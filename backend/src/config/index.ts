import { z } from 'zod';
import { obs } from '../services/observability';

// All env vars are validated up-front via Zod. No silent fallbacks, no
// "works on dev because of an OR-chain that papered over a missing var in
// staging" surprises. If the app boots, every value below is verifiably set
// and well-formed; if it doesn't, the operator sees exactly what's wrong.

const Env = z.object({
  // Runtime mode
  NODE_ENV: z.enum(['development', 'production']),

  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Network
  BACKEND_PORT: z.coerce.number().int().min(1).max(65535).default(3031),

  // External systems
  DATABASE_URL: z.string().url(),
  NATS_URL: z.string().min(1),
  TEMPORAL_ADDRESS: z.string().min(1),

  // Better-auth
  BETTER_AUTH_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  TRUSTED_ORIGINS: z.string().min(1), // comma-separated, parsed below

  // Google OAuth — optional. When both are set, the Google social provider is
  // registered in auth.ts. Omit both to run without Google OAuth (email/password
  // sign-in still works). Setting only one will cause betterAuth to misconfigure;
  // either set both or neither.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // Encryption for user-supplied API keys (BYOK)
  API_KEY_ENCRYPTION_SECRET: z.string().min(32),

  // Sish reverse-tunnel config. Optional — installations that don't expose
  // IDE access leave PIANO_SISH_HOST unset and "Open in IDE" returns notFound.
  // Port range is the inclusive [start, end] pool the daemon controller picks
  // the next free port from at pair time.
  PIANO_SISH_HOST: z.string().optional(),
  PIANO_SISH_PORT_RANGE_START: z.coerce.number().int().min(1).max(65535).default(22000),
  PIANO_SISH_PORT_RANGE_END:   z.coerce.number().int().min(1).max(65535).default(22099),

  // SSH gateway port exposed to clients via the startSsh route. Defaults to 2200.
  // Override when running behind a custom SSH gateway on a non-standard port.
  PIANO_SSH_GATEWAY_PORT: z.coerce.number().optional(),

  // Dev-only pre-pairing: a fixed token from PIANO_DEV_DAEMON_TOKEN auths a
  // "dev" daemon row that ServicesFactory upserts on startup. Same Bearer-auth
  // path as production — just bootstrapped without the UI pair-code dance.
  PIANO_DEV_DAEMON_TOKEN: z.string().optional(),
  PIANO_DEV_DAEMON_USER_EMAIL: z.string().optional(),
  // Dev-only fixed sish port for the auto-paired dev daemon. Production
  // daemons get a port allocated by the pair flow; the dev shortcut needs
  // a deterministic value so Tilt and the backend agree without RPC.
  PIANO_DEV_SISH_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  // Dev-only default workdir for the auto-paired dev daemon. Tilt sets this
  // to the daemon host's $HOME so "Open in IDE" lands in a dir the
  // in-container user can read (containers mount host $HOME).
  PIANO_DEV_DAEMON_DEFAULT_WORKDIR: z.string().optional(),
});

const parsed = Env.safeParse(process.env);

if (!parsed.success) {
  obs.logger.error(
    {
      issues: parsed.error.issues.map(i => ({
        var: i.path.join('.'),
        message: i.message,
      })),
    },
    '❌ Invalid environment — process exiting',
  );
  process.exit(1);
}

const env = parsed.data;

// Build the structured Config from validated env. Routes are strict: every
// field below comes from exactly one env var, no fallbacks, no defaults —
// validation already enforced presence above.
// Prisma only understands query|info|warn|error. Pino's extra verbosity levels
// (debug/trace) map to Prisma's most verbose level so DB logging tracks intent.
const prismaLogLevel = (
  level: typeof env.LOG_LEVEL,
): 'query' | 'info' | 'warn' | 'error' =>
  level === 'debug' || level === 'trace' ? 'query' : level;

const config = {
  env: env.NODE_ENV,
  database: {
    url: env.DATABASE_URL,
    logLevel: prismaLogLevel(env.LOG_LEVEL),
  },
  server: {
    port: env.BACKEND_PORT,
  },
  auth: {
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL.replace(/\/$/, ''),
    trustedOrigins: env.TRUSTED_ORIGINS.split(',').map(o => o.trim().replace(/\/$/, '')),
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
      : undefined,
  },
  nats: {
    url: env.NATS_URL,
  },
  temporal: {
    address: env.TEMPORAL_ADDRESS,
  },
  encryption: {
    apiKeySecret: env.API_KEY_ENCRYPTION_SECRET,
  },
  sish: {
    host: env.PIANO_SISH_HOST,
    portRangeStart: env.PIANO_SISH_PORT_RANGE_START,
    portRangeEnd: env.PIANO_SISH_PORT_RANGE_END,
  },
  sshGatewayPort: env.PIANO_SSH_GATEWAY_PORT ?? 2200,
  dev: {
    daemonToken: env.PIANO_DEV_DAEMON_TOKEN,
    daemonUserEmail: env.PIANO_DEV_DAEMON_USER_EMAIL,
    sishPort: env.PIANO_DEV_SISH_PORT,
    defaultWorkdir: env.PIANO_DEV_DAEMON_DEFAULT_WORKDIR,
  },
};

export type Config = typeof config;
export default config;

// Public config — paths safe to log on startup. Default is SECRET: a field
// is logged only if it's listed here. When you add a new config field, you
// must consciously decide whether it's public; secrets stay out by accident-
// proof default.
const PUBLIC_PATHS = [
  'env',
  'database.logLevel',
  'server.port',
  'auth.baseURL',
  'auth.trustedOrigins',
  'nats.url',
  'temporal.address',
] as const;

const getPath = (obj: any, path: string) =>
  path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

export const publicConfig = () =>
  Object.fromEntries(PUBLIC_PATHS.map(p => [p, getPath(config, p)]));
