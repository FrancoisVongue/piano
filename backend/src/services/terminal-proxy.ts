import { WebSocket as ServerWebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import { venum, match } from 'venum';
import { Note, MachineWindow } from '@piano/shared';
import { obs } from './observability';
import { services } from './init';
import { routeForMachine } from './daemon.adapter';
import type { DaemonTarget } from './daemon';

// Two distinct user concepts on this path: `requesterUserId` (the
// session-authenticated user attaching the terminal) and the target's
// `daemonOwnerId` (whose machine the daemon row belongs to). In single-user
// they're equal — keeping them separate makes the multi-user shape obvious.
type TerminalBridgeArgs = {
  requesterUserId: string;
  machineId: string;
  target: DaemonTarget;
};

const log = obs.child({ domain: 'terminal-proxy' });

export class TerminalProxyService {
  private wss: WebSocketServer;

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
  }

  handleUpgrade(
    request: IncomingMessage,
    socket: any,
    head: Buffer,
    args: TerminalBridgeArgs,
  ) {
    this.wss.handleUpgrade(request, socket, head, (browserWs) => {
      void this.bridge(browserWs, args);
    });
  }

  private async bridge(
    browserWs: ServerWebSocket,
    { requesterUserId, machineId, target }: TerminalBridgeArgs,
  ) {
    log.info({ requesterUserId, machineId, ...target }, 'terminal-proxy open');

    // Distinguish paused (user choice) from disconnected (infra issue) —
    // WS close codes don't carry semantic intent, but the reason string
    // surfaces in browser dev tools and our TerminalPanel `Closed (code=…)`
    // log line. Same shape as daemon.adapter.guardDaemon.
    if (services.daemon.isPaused(target.daemonId)) {
      browserWs.close(1011, 'Daemon paused — resume it in Settings.');
      return;
    }
    if (!services.daemon.isConnected(target)) {
      browserWs.close(1011, 'Daemon not connected');
      return;
    }

    // Listeners must be wired before the open await so frames + close events during
    // the round-trip aren't dropped. Pre-ack frames are queued and flushed below.
    let sessionId: string | null = null;
    let browserClosed = false;
    const queued: string[] = [];

    browserWs.on('message', (data: Buffer | string) => {
      const frame = typeof data === 'string' ? data : data.toString('utf-8');
      if (sessionId) services.daemon.sendTerminalIn(sessionId, frame);
      else queued.push(frame);
    });
    browserWs.on('close', () => {
      browserClosed = true;
      if (sessionId) services.daemon.closeTerminalSession(sessionId);
    });
    browserWs.on('error', (err) => {
      log.warn({ err }, 'browser ws error');
      browserClosed = true;
      if (sessionId) services.daemon.closeTerminalSession(sessionId);
      try { browserWs.close(1011, 'browser error'); } catch {}
    });

    try {
      sessionId = await services.daemon.openTerminalSession(
        target,
        machineId,
        (data) => {
          if (browserWs.readyState !== browserWs.OPEN) return;
          browserWs.send(data, (err) => {
            if (err) log.warn({ err }, 'browser send failed');
          });
        },
        () => {
          try { browserWs.close(1000); } catch { /* swallow */ }
        },
      );
    } catch (err: any) {
      log.error({ err }, 'session open failed');
      browserWs.close(1011, 'session open failed');
      return;
    }

    if (browserClosed) {
      services.daemon.closeTerminalSession(sessionId);
      return;
    }
    for (const frame of queued) services.daemon.sendTerminalIn(sessionId, frame);
  }
}

// Authorization result for a browser → backend → daemon terminal upgrade.
// Each negative variant maps to the reason a logged-in user got their socket
// destroyed — surfaced in the upgrade-handler's log line so debugging starts
// with a concrete answer, not "EOF".
export type TerminalAuth =
  | ReturnType<typeof venum<'ok',             { daemonId: string; daemonOwnerId: string }>>
  | ReturnType<typeof venum<'unknownMachine', { message: string }>>
  | ReturnType<typeof venum<'wrongType',      { message: string }>>
  | ReturnType<typeof venum<'noDaemon',       { message: string }>>;

export async function authorizeTerminal(userId: string, machineId: string): Promise<TerminalAuth> {
  const route = await routeForMachine(userId, machineId);
  if (route) {
    if (!Note.DAEMON_BACKED_TYPES.includes(route.noteType)) {
      return venum('wrongType', { message: `note type ${route.noteType} is not daemon-backed` });
    }
    return venum('ok', route.target);
  }

  // No Note row — could be a sandbox machine or an in-window pane.
  // Sandboxes + panes register themselves in SandboxRegistry at create-time
  // so the proxy can authorize their terminals through the same
  // /api/terminal/:id path as persisted machines.
  const sandbox = services.sandboxRegistry.resolve(machineId, userId);
  if (sandbox) {
    return venum('ok', sandbox);
  }

  // Persisted-pane fallback: panes survive across backend restarts (their
  // daemon-side share session is still alive, layout is persisted on the
  // parent MACHINE note). Walk this user's MACHINE notes' windowLayouts —
  // if any contains this paneId, route to that parent's daemon.
  const pane = await resolvePaneViaWindowLayouts(userId, machineId);
  if (pane) {
    // Re-warm the in-memory registry so subsequent reconnects are O(1).
    services.sandboxRegistry.register({ machineId, requesterUserId: userId, target: pane });
    return venum('ok', pane);
  }

  return venum('unknownMachine', { message: 'machine not found or not owned' });
}

// Lookup a paneId in this user's MACHINE notes' windowLayouts. Returns the
// daemon target of the parent machine that owns the pane (panes are pinned
// to the same daemon as their parent — see MachineController.spawnPane).
async function resolvePaneViaWindowLayouts(
  userId: string,
  paneId: string,
): Promise<DaemonTarget | null> {
  // windowLayout is JSON nullable; we filter to MACHINE notes and check the
  // JSON in JS rather than in Prisma — keeps the query simple and avoids
  // database-specific JSON-not-null filter forms.
  const candidates = await services.prisma.note.findMany({
    where: { userId, type: 'MACHINE' },
    select: {
      daemonId: true,
      windowLayout: true,
      daemon: { select: { userId: true } },
    },
  });
  for (const c of candidates) {
    if (!c.daemonId || !c.daemon || c.windowLayout == null) continue;
    try {
      const layout = MachineWindow.validate.layout(c.windowLayout);
      if (MachineWindow.allPaneIds(layout).includes(paneId)) {
        return { daemonOwnerId: c.daemon.userId, daemonId: c.daemonId };
      }
    } catch {
      // Malformed layout: skip — same fallback as canvas hydration.
      continue;
    }
  }
  return null;
}
