import { venum } from 'venum';
import { services } from '../../services/init';
import { MachineTemplate, Note } from '@piano/shared';
import {
  daemonCommand,
  noDaemonForMachine,
  withDaemon,
  targetForMachine,
} from '../../services/daemon.adapter';
import type { DaemonTarget } from '../../services/daemon';
import { emitNodeUpdated, emitNodeDeleted } from '../action/shared';
import { obs } from '../../services/observability';

const log = obs.child({ domain: 'machine-template' });

// Shared step: ask the daemon to materialise a machine from a template and
// inject the requester's secrets. `target` says where the machine runs;
// `requesterUserId` is whose secrets to inject. They can diverge in
// multi-user (Bob spawns a machine on Alice's daemon → Bob's GitHub token,
// not Alice's). Today they're equal because resolveTarget gates on ownership.
//
// `machineName` becomes the container hostname (shows up in the shell prompt).
// Empty/undefined → daemon falls back to a normalised form of machineId.
async function spawnFromTemplate(
  target: DaemonTarget,
  requesterUserId: string,
  machineId: string,
  templateId: string,
  machineName?: string,
) {
  await services.daemon.sendCommand(
    target,
    { type: 'command:create-from-template', machineId, data: { templateId, machineName: machineName ?? '' } },
    'machine:created',
  );
  const secrets = await services.prisma.secret.findMany({ where: { userId: requesterUserId } });
  if (secrets.length > 0) {
    await services.daemon.sendCommand(target, {
      type: 'command:inject-secrets',
      machineId,
      data: { secrets: secrets.map(s => ({ key: s.key, value: s.value })) },
    }, 'secrets:injected');
  }
  return { machineId, templateId, daemonId: target.daemonId };
}

export class MachineTemplateController {
  static async list(userId: string) {
    return services.prisma.machineTemplate.findMany({
      where: { OR: [{ userId }, { isSystem: true }] },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Save a live machine's current state as a reusable template. Target is the
  // daemon the source machine actually lives on — read from Note.daemonId for
  // persistent machines, falling back to the in-memory sandbox registry for
  // transient sandbox machines (which have no Note row by design). Same
  // fallback shape as terminal-proxy.authorizeTerminal.
  static async saveFromMachine(userId: string, data: MachineTemplate.DTO.SaveFromMachine) {
    const noteTarget    = await targetForMachine(userId, data.machineId);
    const sandboxTarget = services.sandboxRegistry.resolve(data.machineId, userId);
    const target        = noteTarget ?? sandboxTarget;
    if (!target) return noDaemonForMachine();
    if (!services.daemon.isConnected(target)) {
      return venum('daemonDisconnected', { message: 'Daemon not connected' });
    }

    // Pin to the daemon hosting the source — layers are local-only.
    const template = await services.prisma.machineTemplate.create({
      data: {
        name: data.name,
        description: data.description,
        icon: data.icon,
        color: data.color,
        parentTemplateId: data.parentTemplateId,
        userId,
        daemonId: target.daemonId,
      },
    });

    const r = await daemonCommand(
      target,
      { type: 'command:create-template', machineId: data.machineId, data: { templateId: template.id, name: data.name } },
      'template:created',
      { fallbackMsg: 'Save template failed' },
    );
    if (r.tag !== 'ok') {
      await services.prisma.machineTemplate.delete({ where: { id: template.id } });
      return r;
    }
    return venum('ok', template);
  }

  // Verify the requester is allowed to dispatch to this daemon AND build a
  // routing target whose daemonOwnerId comes from the daemon row, not the
  // request. Returns the venum directly when not authorized so callers can
  // short-circuit. Today "allowed" = "owns the daemon"; in multi-user this
  // becomes "is a member of an arrangement that uses this daemon".
  private static async resolveTarget(userId: string, daemonId: string) {
    const daemon = await services.prisma.daemon.findFirst({
      where: { id: daemonId, userId },
      select: { userId: true },
    });
    if (!daemon) return venum('notFound', { message: 'Daemon not found' });
    return venum('ok', { daemonOwnerId: daemon.userId, daemonId } as DaemonTarget);
  }

  // Canvas flow: caller (the create-machine UI) MUST pick a daemon at create
  // time. Legacy "any of this user's daemons" fallback is gone with `?userId=`.
  static async createMachineFromTemplate(userId: string, machineId: string, templateId: string, daemonId: string) {
    const t = await this.resolveTarget(userId, daemonId);
    if (t.tag !== 'ok') return t;
    return withDaemon(t.data, 'Create machine failed', () =>
      spawnFromTemplate(t.data, userId, machineId, templateId));
  }

  // Reactive provisioning, kicked off from the canvas PATCH handler when a
  // new Note arrives with status='PROVISIONING' and a `provisioning` intent.
  // Runs fire-and-forget: PATCH responds with the PROVISIONING row, this
  // method flips it to RUNNING on success or DELETES the note on failure
  // (with a reason that the SSE node:deleted event surfaces as a toast).
  // Symmetric with create — "node on canvas == live machine" stays honest.
  static async provisionFromPatch(input: {
    userId: string;
    noteId: string;
    machineId: string;
    daemonId: string;
    intent: Note.DTO.ProvisioningIntent;
    // Note.label — used as the container hostname so the shell prompt shows
    // the user-chosen name instead of the technical machineId. Empty → daemon
    // falls back to normalised machineId.
    label: string | null;
  }) {
    const outcome = await this.runProvisioning(input);

    if (outcome.ok) {
      const updated = await services.prisma.note.update({
        where: { id: input.noteId },
        data: { status: 'RUNNING' },
      }).catch((err) => {
        log.warn({ err, noteId: input.noteId }, 'note status update failed (note may have been deleted)');
        return null;
      });
      if (updated) emitNodeUpdated(input.userId, updated as unknown as Note.Model);
    } else {
      log.warn({ userId: input.userId, noteId: input.noteId, reason: outcome.reason }, 'provisioning failed — removing note');
      await services.prisma.note.delete({ where: { id: input.noteId } }).catch(() => undefined);
      emitNodeDeleted(input.userId, input.noteId, outcome.reason);
    }
  }

  // Single dispatch over intent.kind. Returns ok | { reason } — no exceptions,
  // no FROZEN zombies, no half-states to interpret upstream.
  private static async runProvisioning(input: {
    userId: string;
    machineId: string;
    daemonId: string;
    intent: Note.DTO.ProvisioningIntent;
    label: string | null;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const t = await this.resolveTarget(input.userId, input.daemonId);
    if (t.tag !== 'ok') return { ok: false, reason: t.data.message };
    const target = t.data;
    const machineName = input.label ?? '';

    try {
      if (input.intent.kind === 'template') {
        await spawnFromTemplate(target, input.userId, input.machineId, input.intent.templateId, machineName);
        return { ok: true };
      }
      // branch and share share the wire shape; share inherits hostname from
      // the parent container (Share() takes no hostname argument).
      const isShare = input.intent.kind === 'share';
      const r = await daemonCommand(
        target,
        {
          type: isShare ? 'command:share' : 'command:branch',
          machineId: input.intent.fromMachineId,
          data: isShare
            ? { childId: input.machineId }
            : { childId: input.machineId, machineName },
        },
        isShare ? 'machine:shared' : 'machine:branched',
        { fallbackMsg: `${input.intent.kind} failed` },
      );
      return r.tag === 'ok' ? { ok: true } : { ok: false, reason: r.data.message };
    } catch (err: any) {
      return { ok: false, reason: err?.message || 'daemon provisioning threw' };
    }
  }

  static async createSandbox(userId: string, templateId: string, daemonId: string, name?: string) {
    const t = await this.resolveTarget(userId, daemonId);
    if (t.tag !== 'ok') return t;
    const sandboxId = `sandbox_${templateId || 'blank'}_${Date.now()}`;
    // Pass `name` to daemon so the hostname-in-prompt reflects what the user
    // typed in the "New machine" form rather than the technical sandboxId.
    const result = await withDaemon(t.data, 'Create sandbox failed', () =>
      spawnFromTemplate(t.data, userId, sandboxId, templateId, name));
    // Register the sandbox in the in-memory authorization registry so the
    // terminal proxy can route /api/terminal/<sandboxId> without a Note row.
    if (result.tag === 'ok') {
      services.sandboxRegistry.register({
        machineId: sandboxId,
        requesterUserId: userId,
        target: t.data,
      });
    }
    return result;
  }

  static async cleanupSandbox(userId: string, machineId: string, daemonId: string) {
    const t = await this.resolveTarget(userId, daemonId);
    if (t.tag !== 'ok') return t;
    return withDaemon(t.data, 'Cleanup failed', async () => {
      services.daemon.send(t.data, { type: 'command:delete', machineId });
      services.sandboxRegistry.unregister(machineId);
      return { cleaned: true };
    });
  }

  // Template-level delete. Daemon-side files live on whichever daemon created
  // the template — without a stored mapping we can't reach them, so DB delete
  // is the only authoritative action.
  static async delete(userId: string, templateId: string) {
    const template = await services.prisma.machineTemplate.findFirst({
      where: { id: templateId, userId },
    });
    if (!template) return venum('notFound', { message: 'Template not found' });
    if (template.isSystem) return venum('forbidden', { message: 'Cannot delete system templates' });

    await services.prisma.machineTemplate.delete({ where: { id: templateId } });
    return venum('ok', { deleted: true });
  }
}
