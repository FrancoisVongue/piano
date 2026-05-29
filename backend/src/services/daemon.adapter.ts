import { Response } from 'express';
import { venum } from 'venum';
import { services } from './init';
import type { DaemonTarget } from './daemon';
import type { Note } from '@piano/shared';

export type DaemonOk<T> = { tag: 'ok'; data: T };
export type DaemonDisconnected = { tag: 'daemonDisconnected'; data: { message: string } };
// daemonPaused is distinct from daemonDisconnected: the WS may still be open,
// the user just told us "don't dispatch new work here". Frontend maps this to
// "Resume in Settings" instead of the misleading "connection issue".
export type DaemonPaused = { tag: 'daemonPaused'; data: { message: string } };
export type DaemonError = { tag: 'daemonError'; data: { message: string } };
export type DaemonResult<T> = DaemonOk<T> | DaemonDisconnected | DaemonPaused | DaemonError;

// Check paused before connectivity: paused is an explicit user state, an
// offline-because-paused daemon is not the same kind of failure as one that
// crashed or lost network.
function guardDaemon(target: DaemonTarget): DaemonDisconnected | DaemonPaused | null {
  if (services.daemon.isPaused(target.daemonId)) {
    return venum('daemonPaused', { message: 'Daemon is paused — resume it in Settings to dispatch work.' });
  }
  if (!services.daemon.isConnected(target)) {
    return venum('daemonDisconnected', { message: 'Daemon not connected' });
  }
  return null;
}

export async function daemonCommand<T = unknown>(
  target: DaemonTarget,
  command: any,
  successEvent: string,
  opts?: { fallbackMsg?: string; timeoutMs?: number },
): Promise<DaemonResult<T>> {
  const guard = guardDaemon(target);
  if (guard) return guard;
  try {
    const response = opts?.timeoutMs != null
      ? await services.daemon.sendCommand(target, command, successEvent, opts.timeoutMs)
      : await services.daemon.sendCommand(target, command, successEvent);
    return venum('ok', response as T);
  } catch (err: any) {
    return venum('daemonError', {
      message: err?.message || opts?.fallbackMsg || 'Daemon operation failed',
    });
  }
}

export const requireDaemon = guardDaemon;

export const daemonError = (err: any, fallback: string) =>
  venum('daemonError', { message: err?.message || fallback });

export async function withDaemon<T>(
  target: DaemonTarget,
  fallback: string,
  run: () => Promise<T>,
): Promise<DaemonResult<T>> {
  const guard = guardDaemon(target);
  if (guard) return guard;
  try {
    return venum('ok', await run());
  } catch (err: any) {
    return daemonError(err, fallback);
  }
}

// Single source of truth for "machineId → where to dispatch + what we know
// about that daemon". Three call surfaces (machine controllers, terminal
// proxy, ssh-info) all need this lookup with slightly different selects;
// unifying it into one shape keeps the multi-user migration (Step 6 — flip
// `where: { userId, ... }` to membership-check) to a single edit.
//
// `userId` is the REQUESTER (note-scoping). `daemonOwnerId` in the returned
// target comes from the daemon row itself — never from the requester.
export type DaemonRoute = {
  target: DaemonTarget;
  noteType: Note.Type;
  daemon: {
    name: string;
    sshPort: number | null;
    defaultWorkdir: string | null;
    isPaused: boolean;
  };
};

export async function routeForMachine(userId: string, machineId: string): Promise<DaemonRoute | null> {
  const note = await services.prisma.note.findFirst({
    where: { userId, machineId },
    select: {
      type: true,
      daemonId: true,
      daemon: {
        select: { userId: true, name: true, sshPort: true, defaultWorkdir: true, isPaused: true },
      },
    },
  });
  if (!note?.daemonId || !note.daemon) return null;
  return {
    target:   { daemonOwnerId: note.daemon.userId, daemonId: note.daemonId },
    noteType: note.type,
    daemon:   {
      name:           note.daemon.name,
      sshPort:        note.daemon.sshPort,
      defaultWorkdir: note.daemon.defaultWorkdir,
      isPaused:       note.daemon.isPaused,
    },
  };
}

// Convenience for callers that only need the routing target. Same lookup as
// routeForMachine, narrower return.
export async function targetForMachine(userId: string, machineId: string): Promise<DaemonTarget | null> {
  return (await routeForMachine(userId, machineId))?.target ?? null;
}

export const noDaemonForMachine = () =>
  venum('daemonDisconnected', { message: 'Machine has no associated daemon' });

export const sendDaemonError = (res: Response) => ({
  daemonDisconnected: (err: { message: string }) =>
    res.status(503).json({ error: err }),
  // 409 Conflict: the resource exists but its current state forbids the
  // operation. Distinct from 503 — paused is not a transient infra issue.
  daemonPaused: (err: { message: string }) =>
    res.status(409).json({ error: err }),
  daemonError: (err: { message: string }) =>
    res.status(502).json({ error: err }),
});
