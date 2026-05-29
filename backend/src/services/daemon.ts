import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import type { PrismaClient } from '@prisma/client';
import { obs } from './observability';

const log = obs.child({ domain: 'daemon' });

type ControlMessage = {
  type: string;
  machineId?: string;
  data?: any;
  // W3C trace context — injected on outbound, mirrored back on inbound
  // responses by the daemon so the round-trip lives on one trace.
  traceparent?: string;
};

type TerminalSessionEntry = {
  daemonId: string;
  // Owner of the daemon the session lives on — same semantics as
  // DaemonTarget.daemonOwnerId. Kept here so close/in frames can rebuild
  // the target without an extra map lookup.
  daemonOwnerId: string;
  onOut: (data: Buffer) => void;
  onClose: () => void;
  resolveOpen: () => void;
  rejectOpen: (err: Error) => void;
};

type PendingRequest = {
  resolve: (msg: ControlMessage) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

// IMPORTANT: `daemonOwnerId` is the userId that OWNS the daemon row, not the
// requester's userId. They happen to be equal in single-user deployments — in a
// multi-user scenario Bob can dispatch to Alice's daemon, and Bob's userId must
// NOT end up here. Always derive this field from a Daemon row, never from
// authUserId(req). Renamed from `userId` specifically to make this invariant
// visible at every callsite.
export type DaemonTarget = { daemonOwnerId: string; daemonId: string };

// Matches daemon/metrics.go:MachineMetrics. Lives here instead of shared/
// because it's an in-memory runtime type, never persisted or exposed as a
// schema — the response type is whatever the controller returns.
export type MachineMetrics = {
  memUsageBytes: number;
  memLimitBytes: number;
  cpuPercent: number;
  uptimeSeconds: number;
  diskUsageBytes: number;
  listeningPorts?: number[];
  state: string;
  activity?: MachineActivity;
  activityGroup?: MachineActivityGroup;
  timestamp: string;
};

// Machine-level activity derived by the daemon from the PTY stream (OSC 133
// shell integration + the `piano` OSC primitive + bell). Cached opaquely and
// forwarded as-is; see daemon/activity.go for the source of truth.
export type MachineActivity = {
  phase: string; // "idle" | "running" | ""
  lastExitCode?: number;
  signal?: string;
  message?: string;
  lastActivityAt?: string;
  attentionAt?: string;
};

// Container-level rollup over a machine's terminals (primary PTY + shared
// panes). Set only on the primary machine. summary = loudest terminal.
export type MachineActivityGroup = {
  summary: MachineActivity;
  running: number;
  attention: number;
  failed: number;
  total: number;
  terminals: { machineId: string; activity: MachineActivity }[];
};

type MetricsEntry = { data: MachineMetrics; receivedAt: number };

const METRICS_TTL_MS = 2 * 60 * 1000;

export type OutputSyncHandler = (userId: string, machineId: string, output: string) => Promise<void>;
export type ActivityHandler = (userId: string, machineId: string, activity: MachineActivity | undefined, group: MachineActivityGroup | undefined) => void;

// Per-connection cache. `ownerId` is the userId that OWNS this daemon row —
// same semantics as DaemonTarget.daemonOwnerId. Distinct from any future
// "requester" concept (multi-user collaboration won't change WS ownership).
type ConnInfo = { ownerId: string; daemonId: string };

const pendingKey = (daemonId: string, machineId: string | undefined, type: string) =>
  `${daemonId}:${machineId ?? ''}:${type}`;

const withTraceContext = (msg: ControlMessage): ControlMessage =>
  msg.traceparent ? msg : { ...msg, traceparent: obs.activeTraceparent() };

export class DaemonService {
  private daemonConnections = new Map<string, WebSocket>();
  private daemonIdToOwnerId = new Map<string, string>();
  private pausedDaemons = new Set<string>();
  private terminalSessions = new Map<string, TerminalSessionEntry>();
  private connInfo = new WeakMap<WebSocket, ConnInfo>();
  private pendingRequests = new Map<string, PendingRequest>();
  private metricsCache = new Map<string, MetricsEntry>();
  private wss: WebSocketServer;
  onOutputSync?: OutputSyncHandler;
  onActivity?: ActivityHandler;

  constructor(private readonly prisma: PrismaClient) {
    this.wss = new WebSocketServer({ noServer: true });

    setInterval(() => {
      const now = Date.now();
      for (const [machineId, entry] of this.metricsCache) {
        if (now - entry.receivedAt > METRICS_TTL_MS) this.metricsCache.delete(machineId);
      }
    }, METRICS_TTL_MS / 2);
  }

  handleUpgradeForDaemon(
    request: IncomingMessage,
    socket: any,
    head: Buffer,
    daemonId: string,
    ownerId: string,
  ) {
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.handleDaemonConnection(ws, daemonId, ownerId);
    });
  }

  private handleDaemonConnection(ws: WebSocket, daemonId: string, ownerId: string) {
    const existing = this.daemonConnections.get(daemonId);
    if (existing && existing !== ws) existing.close();

    this.daemonConnections.set(daemonId, ws);
    this.daemonIdToOwnerId.set(daemonId, ownerId);
    this.connInfo.set(ws, { ownerId, daemonId });
    log.info({ daemonId, ownerId }, 'daemon paired connect');

    void this.loadPausedFlag(daemonId);
    this.markOnline(daemonId).catch(err => log.error({ err }, 'markOnline failed'));
    const heartbeat = setInterval(() => {
      this.markOnline(daemonId).catch(err => log.error({ err }, 'heartbeat failed'));
    }, 60_000);

    ws.on('message', (raw: Buffer) => {
      try {
        const msg: ControlMessage = JSON.parse(raw.toString());
        this.handleMessage(ws, msg);
      } catch (err) {
        log.error({ err }, 'daemon invalid message');
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      // Bail if a fresh WS already took this slot — its state is not ours to clear.
      if (this.daemonConnections.get(daemonId) !== ws) return;

      this.daemonConnections.delete(daemonId);
      this.daemonIdToOwnerId.delete(daemonId);
      this.pausedDaemons.delete(daemonId);

      for (const [sessionId, entry] of this.terminalSessions) {
        if (entry.daemonId === daemonId) {
          this.terminalSessions.delete(sessionId);
          try { entry.rejectOpen(new Error('Daemon disconnected during session open')); } catch { /* swallow */ }
          try { entry.onClose(); } catch { /* swallow */ }
        }
      }
      this.failPendingByDaemonId(daemonId, 'Daemon disconnected');
      log.info({ daemonId }, 'daemon paired disconnect');
      this.markOffline(daemonId).catch(err => log.error({ err }, 'markOffline failed'));
    });
  }

  private failPendingByDaemonId(daemonId: string, reason: string) {
    const prefix = `${daemonId}:`;
    for (const [k, v] of this.pendingRequests) {
      if (!k.startsWith(prefix)) continue;
      clearTimeout(v.timeout);
      this.pendingRequests.delete(k);
      v.reject(new Error(reason));
    }
  }

  private async loadPausedFlag(daemonId: string) {
    const row = await this.prisma.daemon.findUnique({
      where: { id: daemonId },
      select: { isPaused: true },
    }).catch(() => null);
    if (row?.isPaused) this.pausedDaemons.add(daemonId);
    else this.pausedDaemons.delete(daemonId);
  }

  isPaused(daemonId: string): boolean {
    return this.pausedDaemons.has(daemonId);
  }

  setPaused(daemonId: string, isPaused: boolean) {
    if (isPaused) this.pausedDaemons.add(daemonId);
    else this.pausedDaemons.delete(daemonId);
  }

  private async markOnline(daemonId: string) {
    await this.prisma.daemon.update({
      where: { id: daemonId },
      data: { status: 'ONLINE', lastSeenAt: new Date() },
    }).catch(() => { /* row may have been deleted underneath us */ });
  }

  // Re-checks the in-memory map right before writing to avoid a race where
  // a fresh connection has already taken the slot since the close fired.
  private async markOffline(daemonId: string) {
    if (this.daemonConnections.has(daemonId)) return;
    await this.prisma.daemon.update({
      where: { id: daemonId },
      data: { status: 'OFFLINE' },
    }).catch(() => { /* row may have been deleted */ });
  }

  private handleMessage(ws: WebSocket, msg: ControlMessage) {
    const info = this.connInfo.get(ws);
    if (!info) {
      log.error('handleMessage on WS with no connInfo');
      return;
    }
    const { daemonId, ownerId } = info;

    const key = pendingKey(daemonId, msg.machineId, msg.type);
    const pending = this.pendingRequests.get(key);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(key);
      pending.resolve(msg);
      return;
    }

    if (msg.type === 'error' && msg.machineId) {
      const prefix = `${daemonId}:${msg.machineId}:`;
      for (const [k, v] of this.pendingRequests) {
        if (k.startsWith(prefix)) {
          clearTimeout(v.timeout);
          this.pendingRequests.delete(k);
          v.reject(new Error(msg.data?.error || 'Daemon error'));
          return;
        }
      }
      log.error({ daemonId, machineId: msg.machineId, data: msg.data }, 'daemon unmatched error');
      return;
    }

    if (msg.type === 'machine:output-sync' && msg.machineId && this.onOutputSync) {
      this.onOutputSync(ownerId, msg.machineId, msg.data?.output || '').catch(err => {
        log.error({ err, machineId: msg.machineId }, 'daemon output sync failed');
      });
      return;
    }

    if (msg.type === 'machine:metrics-push' && msg.machineId && msg.data) {
      this.metricsCache.set(msg.machineId, {
        data: msg.data as MachineMetrics,
        receivedAt: Date.now(),
      });
      return;
    }

    // Live, on-change activity (faster than the 30s metrics tick). Patch the
    // cached metrics so a subsequent poll agrees with the SSE stream, then hand
    // off to the SSE bridge (set in index.ts) to push to the owning user.
    if (msg.type === 'machine:activity' && msg.machineId && msg.data) {
      const { activity, activityGroup } = msg.data as {
        activity?: MachineActivity;
        activityGroup?: MachineActivityGroup;
      };
      const entry = this.metricsCache.get(msg.machineId);
      if (entry) {
        entry.data = { ...entry.data, activity, activityGroup };
      }
      this.onActivity?.(ownerId, msg.machineId, activity, activityGroup);
      return;
    }

    if (msg.type === 'terminal:opened' && msg.data?.sessionId) {
      const session = this.terminalSessions.get(msg.data.sessionId);
      if (session) session.resolveOpen();
      return;
    }
    if (msg.type === 'terminal:open-failed' && msg.data?.sessionId) {
      const session = this.terminalSessions.get(msg.data.sessionId);
      if (session) {
        session.rejectOpen(new Error(msg.data.error || 'terminal open failed'));
        this.terminalSessions.delete(msg.data.sessionId);
      }
      return;
    }
    if (msg.type === 'terminal:out' && msg.data?.sessionId) {
      const session = this.terminalSessions.get(msg.data.sessionId);
      if (session && typeof msg.data.frame === 'string') {
        try { session.onOut(Buffer.from(msg.data.frame, 'base64')); }
        catch (err) { log.warn({ err }, 'terminal:out forward failed'); }
      }
      return;
    }
    if (msg.type === 'terminal:close' && msg.data?.sessionId) {
      const session = this.terminalSessions.get(msg.data.sessionId);
      if (session) {
        this.terminalSessions.delete(msg.data.sessionId);
        try { session.onClose(); } catch { /* swallow */ }
      }
      return;
    }

    log.debug({ daemonId, msgType: msg.type, machineId: msg.machineId }, 'unhandled daemon push');
  }

  getMetrics(machineId: string): MachineMetrics | null {
    const entry = this.metricsCache.get(machineId);
    if (!entry) return null;
    if (Date.now() - entry.receivedAt > METRICS_TTL_MS) {
      this.metricsCache.delete(machineId);
      return null;
    }
    return entry.data;
  }

  async sendCommand(target: DaemonTarget, msg: ControlMessage, expectResponseType: string, timeoutMs = 30000): Promise<ControlMessage> {
    const ws = this.resolveWs(target);
    if (!ws) throw new Error('Daemon not connected');

    return new Promise((resolve, reject) => {
      const key = pendingKey(target.daemonId, msg.machineId, expectResponseType);
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(key);
        reject(new Error('Daemon command timed out'));
      }, timeoutMs);

      this.pendingRequests.set(key, { resolve, reject, timeout });
      log.debug({ msgType: msg.type, machineId: msg.machineId ?? null, daemonId: target.daemonId }, 'daemon send');
      ws.send(JSON.stringify(withTraceContext(msg)), (err) => {
        if (err) log.error({ err }, 'daemon send failed');
      });
    });
  }

  // ws.send throws synchronously when the socket is CLOSING and no callback is given.
  send(target: DaemonTarget, msg: ControlMessage) {
    const ws = this.resolveWs(target);
    if (!ws) return;
    ws.send(JSON.stringify(withTraceContext(msg)), (err) => {
      if (err) log.warn({ err }, 'fire-and-forget send failed');
    });
  }

  isConnected(target: DaemonTarget): boolean {
    return this.resolveWs(target) !== null;
  }

  private resolveWs(target: DaemonTarget): WebSocket | null {
    if (this.pausedDaemons.has(target.daemonId)) return null;
    const ws = this.daemonConnections.get(target.daemonId);
    return ws && ws.readyState === WebSocket.OPEN ? ws : null;
  }

  // Today "online for this user" == "owned by this user and connected". In
  // multi-user (cross-arrangement membership) this will need to widen to
  // include daemons shared via arrangement membership — until then the
  // ownerId equality is the right cut.
  getOnlineDaemonIds(requesterUserId: string): Set<string> {
    const ids = new Set<string>();
    for (const [daemonId, ws] of this.daemonConnections) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (this.pausedDaemons.has(daemonId)) continue;
      if (this.daemonIdToOwnerId.get(daemonId) === requesterUserId) ids.add(daemonId);
    }
    return ids;
  }

  disconnectDaemon(daemonId: string): void {
    const ws = this.daemonConnections.get(daemonId);
    if (ws) ws.close();
  }

  async openTerminalSession(
    target: DaemonTarget,
    machineId: string,
    onOut: (data: Buffer) => void,
    onClose: () => void,
  ): Promise<string> {
    if (!this.isConnected(target)) throw new Error('Daemon not connected');

    const sessionId = crypto.randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.terminalSessions.delete(sessionId)) {
          reject(new Error('terminal open timed out'));
        }
      }, 10_000);
      this.terminalSessions.set(sessionId, {
        daemonId: target.daemonId,
        daemonOwnerId: target.daemonOwnerId,
        onOut,
        onClose,
        resolveOpen: () => { clearTimeout(timeout); resolve(sessionId); },
        rejectOpen:  (err) => { clearTimeout(timeout); reject(err); },
      });
      this.send(target, { type: 'terminal:open', machineId, data: { sessionId } });
    });
  }

  sendTerminalIn(sessionId: string, frame: string) {
    const session = this.terminalSessions.get(sessionId);
    if (!session) return;
    this.send(
      { daemonOwnerId: session.daemonOwnerId, daemonId: session.daemonId },
      { type: 'terminal:in', data: { sessionId, frame } },
    );
  }

  closeTerminalSession(sessionId: string) {
    const session = this.terminalSessions.get(sessionId);
    if (!session) return;
    this.terminalSessions.delete(sessionId);
    this.send(
      { daemonOwnerId: session.daemonOwnerId, daemonId: session.daemonId },
      { type: 'terminal:close', data: { sessionId } },
    );
  }
}
