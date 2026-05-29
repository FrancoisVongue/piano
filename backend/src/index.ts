import { initObservability, obs, httpLogger } from './services/observability';
initObservability('piano-backend');

import express from 'express';
import config, { publicConfig } from './config';
obs.logger.info({ config: publicConfig() }, 'config loaded');
import { ServicesFactory } from './services/init';
import helmet from 'helmet';
import cors from 'cors';
import { HealthRouter } from './domains/health/routes';
import { createArrangementRouter } from './domains/arrangement/routes';
import { createActionRouter } from './domains/action/routes';
import { createUnifierRouter } from './domains/unifier/routes';
import { createWorkflowRouter } from './domains/workflow/routes';
import { createUserSettingsRouter } from './domains/user-settings/routes';
import { createMachineRouter } from './domains/machine/routes';
import { createTemplateRouter } from './domains/machine-template/routes';
import { createSecretRouter } from './domains/secret/routes';
import { createNoteCacheRouter } from './domains/note-cache/routes';
import { createNoteRunsRouter } from './domains/note-runs/routes';
import { createDaemonRouter } from './domains/daemon/routes';
import { createFilesRouter } from './domains/files/routes';
import { createCanvasGatewayRouter } from './domains/canvas-gateway/routes';
import { emitNodeUpdated } from './domains/action/shared';
import { SSE } from '@piano/shared';
import { Prisma } from '@prisma/client';

const log = obs.logger;

const servicesFactory = new ServicesFactory(config);
const services = await servicesFactory.init().catch(e => {
  log.error({ err: e }, 'Failed to initialize services');
  if (config.env !== 'development') process.exit(1);
  throw e;
});

// ========================================
// NATS → SSE Bridge
// Forwards events from temporal-worker to SSE clients. The withMessageContext
// wrap pulls the publisher's trace context out of the NATS headers so the
// SSE delivery shows up as part of the same trace in Cloud Trace.
// ========================================
const bridgeNatsToSse = (subject: string) => {
  const sub = services.nats.subscribe(subject);
  (async () => {
    for await (const msg of sub) {
      await services.nats.withMessageContext(msg, async () => {
        try {
          const { userId, event, data } = JSON.parse(new TextDecoder().decode(msg.data));
          log.trace({ subject, event, userId }, 'NATS→SSE forwarding');
          services.sse.sendEvent(userId, event, data);
        } catch (err) {
          log.error({ err, subject }, 'NATS→SSE forward failed');
        }
      });
    }
  })();
};

const SSE_SUBJECTS = ['sse.node.updated', 'sse.node.created', 'sse.node.deleted', 'sse.machine.activity'] as const;
SSE_SUBJECTS.forEach(bridgeNatsToSse);
log.info({ subjects: SSE_SUBJECTS }, 'NATS → SSE bridge active');

// Daemon output sync: mirror terminal output into every Note that represents
// this machine (the MACHINE node itself plus any TERMINAL children). updateMany
// is used on purpose — if the user is looking at the canvas machine AND a
// separate TERMINAL node, both should reflect the same daemon output.
services.daemon.onOutputSync = async (userId, machineId, output) => {
  const where: Prisma.NoteWhereInput = { machineId, userId, type: { in: ['MACHINE', 'TERMINAL'] } };
  await services.prisma.note.updateMany({ where, data: { content: output } });

  // Push the new content to the canvas in real time. Without this, the
  // frontend only sees the updated content on a full canvas reload, so
  // anything gated on `data.content` (e.g. the "Copy content" action) stays
  // disabled until the user hits refresh. Same SSE pipeline as AI runs.
  const touched = await services.prisma.note.findMany({ where });
  touched.forEach(note => emitNodeUpdated(userId, note));
};

// Live machine activity → SSE. The daemon streams activity on change (control
// message machine:activity, handled in DaemonService); we fan it out to the
// owning user over the same SSE pipeline as node updates.
services.daemon.onActivity = (userId, machineId, activity, activityGroup) => {
  services.nats
    .publish('sse.machine.activity', SSE.machineActivity(userId, machineId, activity, activityGroup))
    .catch(err => log.warn({ err, userId, machineId }, 'sse.machine.activity publish failed'));
};

const app = express();
const PORT = config.server.port;

app.set('trust proxy', 'loopback, linklocal, uniquelocal');

log.info(
  { mode: config.env, trustedOrigins: config.auth.trustedOrigins },
  config.env === 'development' ? 'CORS: development mode (all origins allowed)' : 'CORS: trusted origins',
);

app.use(helmet());
app.use(cors({
  origin: config.env === 'development' ? true : (
    config.auth.trustedOrigins.length === 1
      ? config.auth.trustedOrigins[0]
      : config.auth.trustedOrigins
  ),
  credentials: true
}));

app.use(httpLogger);
app.use('/health', HealthRouter);

// IMPORTANT: Don't use express.json() before better-auth handler
app.use('/api/auth', services.auth.handler);
app.use(express.json({limit: '12mb'}));

app.use('/api/arrangements', createArrangementRouter(services));
app.use('/api/actions', createActionRouter(services));
app.use('/api/unifiers', createUnifierRouter(services));
app.use('/api/workflows', createWorkflowRouter(services));
app.use('/api/user', createUserSettingsRouter(services));
app.use('/api/machines', createMachineRouter(services));
app.use('/api/templates', createTemplateRouter(services));
app.use('/api/secrets', createSecretRouter(services));
app.use('/api/notes', createNoteCacheRouter(services));
app.use('/api/notes', createNoteRunsRouter(services));
app.use('/api/daemons', createDaemonRouter(services));
app.use('/api/files', createFilesRouter(services));
app.use('/api/canvas', createCanvasGatewayRouter());

// SSE Endpoint
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  services.sse.addClient(req, res);
});

const server = app.listen(PORT, () => {
  log.info({ port: PORT }, '🚀 Backend running');
});

// WebSocket upgrade handler. Two paths:
//   - /api/daemon/ws            paired daemon control plane (Bearer auth)
//   - /api/terminal/:machineId  browser ↔ daemon terminal (multiplexed over
//                               the daemon's control-plane WS — daemons
//                               never need a public listener)
const { TerminalProxyService, authorizeTerminal } = await import('./services/terminal-proxy');
const terminalProxy = new TerminalProxyService();

server.on('upgrade', async (request, socket, head) => {
  const url = new URL(request.url || '', `http://localhost:${PORT}`);

  // Human-side terminal proxy (browser, cookies).
  const termMatch = url.pathname.match(/^\/api\/terminal\/([^\/]+)$/);
  if (termMatch) {
    const machineId = decodeURIComponent(termMatch[1]!);
    const session = await services.auth.api.getSession({ headers: request.headers as any })
      .catch(() => null);
    const userId = session?.user?.id;
    if (!userId) {
      log.warn({ machineId, hasCookie: !!request.headers.cookie }, 'terminal-proxy: no session on upgrade');
      socket.destroy();
      return;
    }
    const authz = await authorizeTerminal(userId, machineId);
    if (authz.tag !== 'ok') {
      log.warn({ userId, machineId, tag: authz.tag, reason: authz.data.message }, 'terminal-proxy denied');
      socket.destroy();
      return;
    }
    terminalProxy.handleUpgrade(request, socket, head, {
      requesterUserId: userId,
      machineId,
      target: { daemonId: authz.data.daemonId, daemonOwnerId: authz.data.daemonOwnerId },
    });
    return;
  }

  // Agent-side terminal proxy (bearer machine-token). Sibling path; the
  // auth source is `Authorization: Bearer <machine-token>` instead of a
  // session cookie. Downstream is the same terminal-proxy bridge — only
  // the identity-resolution prefix differs.
  const canvasTermMatch = url.pathname.match(/^\/api\/canvas\/terminal\/([^\/]+)$/);
  if (canvasTermMatch) {
    const sessionId = decodeURIComponent(canvasTermMatch[1]!);
    const authHeader = request.headers['authorization'];
    if (typeof authHeader !== 'string' || !authHeader.toLowerCase().startsWith('bearer ')) {
      log.warn({ sessionId }, 'canvas-terminal: no bearer on upgrade');
      socket.destroy();
      return;
    }
    const bearer = authHeader.slice('bearer '.length).trim();
    const { sha256Hex } = await import('./shared/lib/sha256');
    const tokenHash = await sha256Hex(bearer);
    const row = await services.prisma.machineApiToken.findUnique({
      where: { tokenHash },
      select: { machineId: true, userId: true, revokedAt: true },
    });
    if (!row || row.revokedAt) {
      log.warn({ sessionId }, 'canvas-terminal: invalid or revoked token');
      socket.destroy();
      return;
    }
    const authz = await authorizeTerminal(row.userId, sessionId);
    if (authz.tag !== 'ok') {
      log.warn({ sessionId, callerUserId: row.userId, tag: authz.tag }, 'canvas-terminal denied');
      socket.destroy();
      return;
    }
    terminalProxy.handleUpgrade(request, socket, head, {
      requesterUserId: row.userId,
      machineId: sessionId,
      target: { daemonId: authz.data.daemonId, daemonOwnerId: authz.data.daemonOwnerId },
    });
    return;
  }

  if (url.pathname !== '/api/daemon/ws') {
    socket.destroy();
    return;
  }

  const auth = request.headers['authorization'];
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
    socket.destroy();
    return;
  }
  const token = auth.slice('Bearer '.length).trim();
  const { DaemonController } = await import('./domains/daemon/controller');
  let daemon = await DaemonController.authenticateToken(token);
  if (!daemon) {
    // Self-heal: dev/self-hosted token, daemon row not in DB yet
    // (fresh install before first sign-up, or .env regenerated).
    daemon = await DaemonController.ensureFromDevToken(token);
  }
  if (!daemon) {
    log.warn(
      'daemon WS rejected: token not recognized. ' +
      'If self-hosted, check PIANO_DEV_DAEMON_TOKEN in .env matches and ' +
      'that at least one user has signed up at the app URL.'
    );
    socket.destroy();
    return;
  }
  services.daemon.handleUpgradeForDaemon(request, socket, head, daemon.id, daemon.userId);
});
