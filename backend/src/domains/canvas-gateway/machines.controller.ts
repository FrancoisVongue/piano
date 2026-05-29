import { venum } from 'venum';
import { z } from 'zod';
import { services } from '../../services/init';
import { MachineController } from '../machine/controller';
import { MachineTemplateController } from '../machine-template/controller';
import { daemonCommand, targetForMachine } from '../../services/daemon.adapter';
import { emitNodeUpdated } from '../action/shared';

// -----------------------------------------------------------------------------
// MachinesGatewayController — peer-machine surface for an agent inside a
// machine. Symmetric to `piano machine *` on the host, just routed
// through canvas-gateway bearer auth and ALWAYS scoped to the caller's
// arrangement.
//
// "Scoped" means: every operation that names a peer machine first
// verifies that peer.arrangementId == caller.arrangementId. Without
// that check, a token minted for machine M in arrangement A could
// touch machines in arrangement B — the scope boundary the rest of
// the canvas-gateway enforces would leak here.
// -----------------------------------------------------------------------------

export const SpawnSchema = z.object({
  templateId: z.string().optional().default(''),
  label: z.string().optional(),
});
export type SpawnInput = z.infer<typeof SpawnSchema>;

export const ExecSchema = z.object({
  cmd: z.array(z.string().min(1)).min(1).max(256),
  workdir: z.string().optional(),
});
export type ExecInput = z.infer<typeof ExecSchema>;

// ensurePeer: caller's bearer token is for machine X in arrangement A. The
// `peerId` URL parameter MUST also live in A — otherwise we'd be giving
// X cross-arrangement access. Returns the Note row on success.
async function ensurePeer(arrangementId: string, peerId: string) {
  const note = await services.prisma.note.findFirst({
    where: { arrangementId, machineId: peerId, type: { in: ['MACHINE', 'TERMINAL'] } },
    select: { id: true, machineId: true, label: true, userId: true, arrangementId: true },
  });
  if (!note) return null;
  return note;
}

export class MachinesGatewayController {
  // Flat list of peer machines in the caller's arrangement. Returns the
  // Note rows directly — agent sees label / machineId / type / parent
  // and can pick targets for exec.
  static list(arrangementId: string) {
    return services.prisma.note.findMany({
      where: {
        arrangementId,
        machineId: { not: null },
        type: { in: ['MACHINE', 'TERMINAL'] },
      },
      select: {
        id: true,
        machineId: true,
        type: true,
        label: true,
        status: true,
        parentMachineNodeId: true,
        daemonId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  static async get(arrangementId: string, peerId: string) {
    const note = await ensurePeer(arrangementId, peerId);
    if (!note) return venum('notFound', { message: `Peer machine ${peerId} not in this arrangement` });
    return venum('ok', note);
  }

  // Recent PTY output. Reuses the existing host-side controller —
  // ownership-by-user already gates daemon access; we add the
  // arrangement-scoping pre-check.
  static async output(arrangementId: string, peerId: string) {
    const note = await ensurePeer(arrangementId, peerId);
    if (!note) return venum('notFound', { message: `Peer machine ${peerId} not in this arrangement` });
    return MachineController.getOutput(note.userId, peerId);
  }

  // Run a command on a peer. Same shape `docker exec` returns —
  // exitCode + combined output. Non-zero exit is a normal result.
  static async exec(arrangementId: string, peerId: string, input: ExecInput) {
    const note = await ensurePeer(arrangementId, peerId);
    if (!note) return venum('notFound', { message: `Peer machine ${peerId} not in this arrangement` });
    return MachineController.exec(note.userId, peerId, input.cmd, input.workdir);
  }

  // Spawn a new machine from a template, INTO the caller's arrangement.
  // The agent owns the resulting machine in the canvas sense — its Note
  // row is created here. Daemon-side provisioning is delegated to the
  // existing template controller.
  //
  // We mint the machineId ourselves (cuid-equivalent) and pre-create the
  // canvas Note so the new machine has a home before the daemon spawns.
  // Position defaults to (0,0) — the canvas will lay it out wherever the
  // viewport happens to be.
  static async spawn(
    callerUserId: string,
    callerMachineId: string,
    arrangementId: string,
    callerDaemonId: string | null,
    input: SpawnInput,
  ) {
    // Pin the new machine to the caller's daemon. Multi-daemon model
    // assumes "one team, one daemon" — putting the worker on a different
    // host would defeat the locality the gateway is built around. Legacy
    // machines (daemonId=null) can't spawn peers — surface that early.
    if (!callerDaemonId) {
      return venum('notFound', {
        message: 'Calling machine is not pinned to a daemon (legacy) — cannot spawn from canvas',
      });
    }

    // Layer membership (dev's per-note `layers` invariant): the spawned
    // worker inherits the spawning agent's layers so it groups with its
    // manager instead of showing on every layer. Falls back to [] (global)
    // when the caller is itself global. Arrangement-scoped lookup.
    const caller = await services.prisma.note.findFirst({
      where: { machineId: callerMachineId, arrangementId },
      select: { layers: true },
    });
    const layers = caller?.layers ?? [];

    const machineId = `m_${cryptoRandomId()}`;

    const note = await services.prisma.note.create({
      data: {
        arrangementId,
        userId: callerUserId,
        type: 'MACHINE',
        content: '',
        label: input.label ?? null,
        machineId,
        daemonId: callerDaemonId,
        x: 0,
        y: 0,
        status: 'PROVISIONING',
        layers,
      },
    });

    // Delegate daemon-side spawn to the existing template controller.
    // Same flow the human path takes — single source of truth for
    // "create-machine-from-template".
    const r = await MachineTemplateController.createMachineFromTemplate(
      callerUserId,
      machineId,
      input.templateId ?? '',
      callerDaemonId,
    );
    if (r.tag !== 'ok') {
      // Rollback the placeholder note so the canvas doesn't keep a
      // PROVISIONING ghost.
      await services.prisma.note.delete({ where: { id: note.id } }).catch(() => {});
      return r;
    }
    // Daemon spawn succeeded — flip Note.status PROVISIONING → RUNNING
    // and emit so any open canvas tab sees the new machine become live.
    // Mirrors provisionFromPatch's on-success branch — keeps the
    // "node on canvas == live machine" invariant honest.
    const live = await services.prisma.note.update({
      where: { id: note.id },
      data: { status: 'RUNNING' },
    }).catch(() => null);
    if (live) emitNodeUpdated(callerUserId, live as any);
    return venum('ok', { machineId, noteId: note.id });
  }

  static async freeze(arrangementId: string, peerId: string) {
    const note = await ensurePeer(arrangementId, peerId);
    if (!note) return venum('notFound', { message: `Peer machine ${peerId} not in this arrangement` });
    return MachineController.freeze(note.userId, peerId);
  }

  // Start an interactive PTY session on a peer. Reuses daemon's
  // `command:share` — same primitive a human's in-window pane uses,
  // just registered under the calling agent's userId so the bearer-auth
  // WS upgrade can later authorize it. Returns `{sessionId, wsPath}` —
  // CLI dials wsPath with its Bearer header.
  //
  // The session is NOT persisted (no Note row). When the CLI disconnects,
  // the WS closes; the daemon-side container exits as part of normal
  // share-session teardown (see daemon's machine.Destroy on conn close).
  static async attach(
    callerUserId: string,
    arrangementId: string,
    peerId: string,
  ) {
    const note = await ensurePeer(arrangementId, peerId);
    if (!note) return venum('notFound', { message: `Peer machine ${peerId} not in this arrangement` });

    const target = await targetForMachine(note.userId, peerId);
    if (!target) return venum('daemonDisconnected', { message: 'Daemon offline — cannot attach' });

    const sessionId = `att_${cryptoRandomId()}`;

    const r = await daemonCommand(
      target,
      { type: 'command:share', machineId: peerId, data: { childId: sessionId } },
      'machine:shared',
      { fallbackMsg: 'Attach failed', timeoutMs: 5000 },
    );
    if (r.tag !== 'ok') return r;

    // Register so /api/canvas/terminal/:sessionId can resolve to the
    // peer's daemon at upgrade time. Same plumbing as spawnPane (panes
    // also live in the registry).
    services.sandboxRegistry.register({
      machineId: sessionId,
      requesterUserId: callerUserId,
      target,
    });

    return venum('ok', {
      sessionId,
      wsPath: `/api/canvas/terminal/${sessionId}`,
    });
  }

  static async remove(arrangementId: string, peerId: string) {
    const note = await ensurePeer(arrangementId, peerId);
    if (!note) return venum('notFound', { message: `Peer machine ${peerId} not in this arrangement` });
    const target = await targetForMachine(note.userId, peerId);
    if (!target) {
      // Daemon offline — drop the note anyway so the canvas doesn't
      // hang on a ghost. Daemon-side container becomes a one-time
      // cleanup task on its next start.
      await services.prisma.note.delete({ where: { id: note.id } }).catch(() => {});
      return venum('ok', { deleted: true });
    }
    const r = await daemonCommand(
      target,
      { type: 'command:delete', machineId: peerId },
      'machine:deleted',
      { fallbackMsg: 'Delete failed', timeoutMs: 5000 },
    );
    if (r.tag !== 'ok') return r;
    await services.prisma.note.delete({ where: { id: note.id } }).catch(() => {});
    return venum('ok', { deleted: true });
  }
}

// Local id minter — avoids a dependency on crypto for a one-call util.
// 16 hex chars from a CSPRNG; daemon doesn't care about format.
function cryptoRandomId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}
