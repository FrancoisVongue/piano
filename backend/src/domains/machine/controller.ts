import { venum } from 'venum';
import crypto from 'node:crypto';
import { services } from '../../services/init';
import { obs } from '../../services/observability';
import { daemonCommand, DaemonResult, noDaemonForMachine, targetForMachine } from '../../services/daemon.adapter';
import { sha256Hex } from '../../shared/lib/sha256';
import config from '../../config';

// Panes share the sandbox-registry: both are transient, have no Note row, and
// need terminal-proxy authorization keyed by id → daemon target. Reuse keeps
// auth path uniform — see authorizeTerminal in terminal-proxy.ts.

const log = obs.child({ domain: 'machine' });


const onOk = <U>(result: DaemonResult<any>, transform: (response: any) => U): DaemonResult<U> =>
  result.tag === 'ok' ? venum('ok', transform(result.data)) : result;

export class MachineController {
  // Freeze a live machine into a reusable template, then delete its canvas
  // notes (MACHINE + any TERMINAL children). The template is created BEFORE
  // the daemon snapshot so we can roll it back on snapshot failure; if the
  // DB delete fails after a successful snapshot the template still exists,
  // we just log and let the canvas show stale nodes that can be removed
  // manually next refetch.
  static async freeze(userId: string, machineId: string, nameOverride?: string) {
    const target = await targetForMachine(userId, machineId);
    if (!target) return noDaemonForMachine();

    const note = await services.prisma.note.findFirst({
      where: { userId, machineId },
      select: { id: true, label: true, arrangementId: true },
    });
    const templateName = (
      nameOverride?.trim()
      || note?.label?.trim()
      || `Frozen ${new Date().toLocaleString()}`
    ).slice(0, 80);

    // Pin the template to the daemon whose layersDir actually holds its
    // overlay files. Spawning this template later on a different daemon
    // would 404 the upper dir — the picker filters on this so it never
    // happens.
    const template = await services.prisma.machineTemplate.create({
      data: { name: templateName, userId, daemonId: target.daemonId },
    });
    const persisted = await daemonCommand(target,
      { type: 'command:create-template', machineId, data: { templateId: template.id, name: templateName } },
      'template:created',
      { fallbackMsg: 'Save template failed' },
    );
    if (persisted.tag !== 'ok') {
      await services.prisma.machineTemplate.delete({ where: { id: template.id } }).catch(() => {});
      return persisted;
    }

    const deletedNoteIds: string[] = [];
    if (note) {
      const terminals = await services.prisma.note.findMany({
        where: { userId, parentMachineNodeId: note.id, type: 'TERMINAL' },
        select: { id: true },
      }).catch(() => []);
      const ids = [note.id, ...terminals.map(t => t.id)];
      try {
        await services.prisma.note.deleteMany({ where: { id: { in: ids } } });
      } catch (err) {
        log.warn({ err, machineId, templateId: template.id }, 'freeze: note cleanup failed');
      }
      // Push IDs unconditionally so the canvas removes them even if DB delete
      // failed; user can retry. Without this an error leaves zombie nodes.
      deletedNoteIds.push(...ids);
    }

    return venum('ok', {
      machineId,
      templateId: template.id,
      templateName,
      deletedNoteIds,
      arrangementId: note?.arrangementId ?? null,
    });
  }

  static async branch(userId: string, parentMachineId: string, childId: string, machineName?: string) {
    const target = await targetForMachine(userId, parentMachineId);
    if (!target) return noDaemonForMachine();
    const r = await daemonCommand(target,
      { type: 'command:branch', machineId: parentMachineId, data: { childId, machineName } },
      'machine:branched', { fallbackMsg: 'Branch failed' });
    return onOk(r, () => ({ machineId: childId, parentId: parentMachineId, daemonId: target.daemonId }));
  }

  static async share(userId: string, parentMachineId: string, childId: string) {
    const target = await targetForMachine(userId, parentMachineId);
    if (!target) return noDaemonForMachine();
    const r = await daemonCommand(target,
      { type: 'command:share', machineId: parentMachineId, data: { childId } },
      'machine:shared', { fallbackMsg: 'Share failed' });
    return onOk(r, () => ({ machineId: childId, parentId: parentMachineId, daemonId: target.daemonId }));
  }

  static async activate(userId: string, machineId: string) {
    const target = await targetForMachine(userId, machineId);
    if (!target) return noDaemonForMachine();
    const r = await daemonCommand(target, { type: 'command:activate', machineId }, 'machine:activated', { fallbackMsg: 'Activate failed' });
    return onOk(r, (response) => ({ machineId, ports: response?.data?.ports || [] }));
  }

  static async deactivate(userId: string, machineId: string) {
    const target = await targetForMachine(userId, machineId);
    if (!target) return noDaemonForMachine();
    const r = await daemonCommand(target, { type: 'command:deactivate' }, 'machine:deactivated', { fallbackMsg: 'Deactivate failed' });
    return onOk(r, () => ({ deactivated: true }));
  }

  static async startSsh(_userId: string, machineId: string) {
    return venum('ok', { machineId, port: config.sshGatewayPort });
  }

  static async getOutput(userId: string, machineId: string) {
    const target = await targetForMachine(userId, machineId);
    if (!target) return noDaemonForMachine();
    const r = await daemonCommand(target, { type: 'command:get-output', machineId }, 'machine:output', { fallbackMsg: 'Get output failed' });
    return onOk(r, (response) => ({ output: response?.data?.output || '' }));
  }

  // One-shot run-and-return. Wraps daemon's `command:exec`. Non-zero
  // exit code is NOT an error here — callers (canvas agents) need the
  // distinction between "process ran and failed" (exitCode != 0) and
  // "couldn't run at all" (daemon error). Same shape as `docker exec`
  // — output is combined stdout+stderr.
  //
  // 60s timeout cap: long-running prompts (e.g. claude -p with deep
  // reasoning) that exceed it surface as `daemonError` here and orphan
  // the remote process. V1 limitation — for sustained sessions use
  // claude --resume in separate exec calls instead.
  static async exec(userId: string, machineId: string, cmd: string[], workdir?: string) {
    const target = await targetForMachine(userId, machineId);
    if (!target) return noDaemonForMachine();
    const r = await daemonCommand(
      target,
      { type: 'command:exec', machineId, data: { cmd, workdir } },
      'machine:execed',
      { fallbackMsg: 'Exec failed', timeoutMs: 60_000 },
    );
    return onOk(r, (response) => ({
      output:   response?.data?.output ?? '',
      exitCode: response?.data?.exitCode ?? 0,
    }));
  }

  // Pane = a daemon-side shared session (same `command:share` substrate as
  // canvas-level TERMINAL notes), but explicitly NOT persisted as a Note.
  // The frontend keeps it in MachineWindow.Layout. Use `share` when the
  // user wants the session to live as a first-class canvas node; use
  // `spawnPane` when it lives inside a machine window's tab.
  static async spawnPane(userId: string, parentMachineId: string, paneId: string) {
    const target = await targetForMachine(userId, parentMachineId);
    if (!target) return noDaemonForMachine();
    const r = await daemonCommand(target,
      { type: 'command:share', machineId: parentMachineId, data: { childId: paneId } },
      'machine:shared', { fallbackMsg: 'Spawn pane failed' });
    // Register the pane in the sandbox registry so terminal-proxy can
    // authorize WS connections to /api/terminal/:paneId. Panes have no Note
    // row, so authorizeTerminal would otherwise return unknownMachine.
    if (r.tag === 'ok') {
      services.sandboxRegistry.register({ machineId: paneId, requesterUserId: userId, target });
    }
    return onOk(r, () => ({ paneId, parentId: parentMachineId, daemonId: target.daemonId }));
  }

  // Pane lives on the same daemon as its parent machine; we route via the
  // parent's Note (the pane isn't a Note itself).
  static async closePane(userId: string, parentMachineId: string, paneId: string) {
    const target = await targetForMachine(userId, parentMachineId);
    if (!target) return noDaemonForMachine();
    const r = await daemonCommand(target,
      { type: 'command:delete', machineId: paneId },
      'machine:deleted', { fallbackMsg: 'Close pane failed' });
    // Drop the pane's auth entry regardless of daemon ack: even if the
    // daemon RPC fails, the frontend has dropped the pane from layout and
    // any reconnect attempts should be denied.
    services.sandboxRegistry.unregister(paneId);
    return onOk(r, () => ({ paneId }));
  }

  // Mint a fresh canvas-gateway bearer token for the given machine. Returns
  // the plaintext ONCE — it's never persisted in cleartext. The hash is
  // stored, and the bearer is what the in-container `piano canvas *` puts
  // in `Authorization: Bearer ...`. Caller must own the machine (route
  // already runs under sessionAuth; we verify ownership here too).
  static async issueCanvasToken(userId: string, machineId: string) {
    const note = await services.prisma.note.findFirst({
      where: { userId, machineId, type: { in: ['MACHINE', 'TERMINAL'] } },
      select: { id: true },
    });
    if (!note) return venum('notFound', { message: 'Machine not found or not yours' });

    // 32 bytes of crypto entropy → base64url. ~43 chars, URL-safe.
    const bearer = crypto.randomBytes(32).toString('base64url');
    const tokenHash = await sha256Hex(bearer);

    await services.prisma.machineApiToken.create({
      data: { machineId, tokenHash, userId },
    });

    return venum('ok', { token: bearer, machineId });
  }
}
