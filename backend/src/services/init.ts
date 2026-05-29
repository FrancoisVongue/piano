import { Config } from "../config";
import { obs } from "./observability";
import Database from "./database";
import AuthService from "./auth";
import NatsService from "./nats";
import { PrismaClient } from "@prisma/client";
import { SSEService } from './sse';
import { AiService } from "./ai";
import { DaemonService } from './daemon';
import { SandboxRegistry } from './sandbox-registry';
import { sha256Hex } from '../shared/lib/sha256';

const log = obs.logger;

type DevDaemonSpec = {
  prisma: PrismaClient;
  token: string;
  email?: string;
  sshPort?: number;
  defaultWorkdir?: string;
};

async function ensureDevDaemon(spec: DevDaemonSpec) {
  const tokenHash = await sha256Hex(spec.token);

  const user = spec.email
    ? await spec.prisma.user.findUnique({ where: { email: spec.email } })
    : await spec.prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!user) {
    log.info(
      { devEmail: spec.email ?? null },
      'dev-daemon: no user yet — daemon will auto-register on its next WS retry after first sign-up',
    );
    return;
  }

  // Dev shortcut: pin sshPort + defaultWorkdir to the env-supplied values
  // rather than going through pair flow. Tilt passes the same values to
  // the daemon binary so both sides agree without an RPC round-trip.
  await spec.prisma.daemon.upsert({
    where: { userId_name: { userId: user.id, name: 'dev' } },
    update: { tokenHash, status: 'OFFLINE', sshPort: spec.sshPort ?? null, defaultWorkdir: spec.defaultWorkdir ?? null },
    create: {
      userId: user.id,
      name: 'dev',
      tokenHash,
      status: 'OFFLINE',
      sshPort: spec.sshPort ?? null,
      defaultWorkdir: spec.defaultWorkdir ?? null,
    },
  });
  log.info({ user: user.email, sshPort: spec.sshPort ?? null, defaultWorkdir: spec.defaultWorkdir ?? null }, 'dev-daemon ensured');
}

export type Services = {
  prisma: PrismaClient;
  auth: AuthService;
  nats: NatsService;
  sse: SSEService;
  ai: AiService;
  daemon: DaemonService;
  sandboxRegistry: SandboxRegistry;
  init?: () => Promise<void>;
};

export let services: Services;

export class ServicesFactory {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async init(): Promise<Services> {
    const db = new Database(this.config);
    await db.connect().catch(e => {
      log.error({ err: e }, 'Database connection failed');
      throw e;
    });
    const natsService = new NatsService(this.config);
    await natsService.connect().catch(e => {
      log.error({ err: e }, 'NATS connection failed');
      throw e;
    });

    const client = db.client;
    const auth = new AuthService(client, this.config);
    const sseService = new SSEService();
    const daemonService = new DaemonService(client);

    // Fail loudly if the daemon migrations haven't landed — the rest of the
    // multi-daemon code path assumes these columns exist.
    try {
      await client.daemon.findFirst({ select: { id: true, sshPort: true, isPaused: true } });
    } catch (e) {
      log.error({ err: e }, '[init] daemon schema probe failed — pending migrations? Run: pnpm prisma migrate deploy');
      throw new Error(
        'Daemon schema is missing expected columns. Run `pnpm prisma migrate deploy` before starting the backend.',
      );
    }

    // Reset stale ONLINE rows from the previous process — we know nothing
    // is connected yet at boot.
    await client.daemon.updateMany({
      where: { status: 'ONLINE' },
      data: { status: 'OFFLINE' },
    }).catch(e => log.warn({ err: e }, '[daemon] reset-on-boot failed (continuing)'));

    // Auto-register a daemon row when PIANO_DEV_DAEMON_TOKEN is set —
    // the presence of the token IS the opt-in (works for both dev and
    // self-hosted deployments). Hosted/multi-tenant deployments leave the
    // token unset and use the pair-code flow instead.
    if (this.config.dev.daemonToken) {
      // Both sshPort and defaultWorkdir are gated on sish.host being
      // configured — they're meaningless without a tunnel server. The
      // invariant is "ssh-info data exists IFF sish is wired up".
      const sishConfigured = !!this.config.sish.host;
      await ensureDevDaemon({
        prisma: client,
        token: this.config.dev.daemonToken,
        email: this.config.dev.daemonUserEmail,
        sshPort: sishConfigured ? this.config.dev.sishPort : undefined,
        defaultWorkdir: sishConfigured ? this.config.dev.defaultWorkdir : undefined,
      });
    }

    const STALE_ONLINE_AFTER_MS = 5 * 60 * 1000;
    const REAP_PAIRING_AFTER_MS = 24 * 60 * 60 * 1000;

    setInterval(() => {
      const cutoff = new Date(Date.now() - STALE_ONLINE_AFTER_MS);
      client.daemon.updateMany({
        where: { status: 'ONLINE', OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }] },
        data: { status: 'OFFLINE' },
      }).catch(e => log.warn({ err: e }, '[daemon] stale-online sweep failed'));
    }, 60_000);

    setInterval(() => {
      const cutoff = new Date(Date.now() - REAP_PAIRING_AFTER_MS);
      client.daemonPairingCode.deleteMany({
        where: { OR: [{ expiresAt: { lt: cutoff } }, { consumedAt: { lt: cutoff } }] },
      }).catch(e => log.warn({ err: e }, '[daemon] pairing-code reap failed'));
    }, 60 * 60 * 1000);

    const obj = {
      prisma: client,
      auth,
      nats: natsService,
      sse: sseService,
      daemon: daemonService,
      sandboxRegistry: new SandboxRegistry(),
      ai: new AiService(),
      init: async () => {
        await natsService.connect();
      }
    };

    services = obj;
    return services;
  }
}
