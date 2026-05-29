import pino, { Logger } from 'pino';
import pinoPretty from 'pino-pretty';
import pinoHttp from 'pino-http';
import {
  trace,
  context,
  propagation,
  SpanStatusCode,
  SpanKind,
  Attributes,
} from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { TraceExporter } from '@google-cloud/opentelemetry-cloud-trace-exporter';

// -----------------------------------------------------------------------------
// Observability — single entry point for logs and traces.
//
// Three jobs:
//   1. Start the OpenTelemetry SDK (Cloud Trace exporter in prod, no-op in dev
//      unless ENABLE_TELEMETRY=1).
//   2. Expose a pino logger that auto-injects the active trace_id / span_id in
//      Cloud-Logging-friendly fields, so each log links to its trace in the
//      GCP UI.
//   3. Provide thin helpers for the boundaries where context isn't propagated
//      automatically: NATS messages, async work blocks.
//
// Anyone in the codebase: `import { obs } from './services/observability'`.
// `obs.logger.info(...)` / `obs.span(name, fn)` / `obs.inject(headers)` /
// `obs.runWithRemoteContext(carrier, fn)`.
// -----------------------------------------------------------------------------

const projectId =
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCP_PROJECT ||
  process.env.GCLOUD_PROJECT;

let sdk: NodeSDK | null = null;
let serviceName = 'piano-backend';

// Env-derived flags. Always read at logger build time, never cached at module
// load — `dotenv.config()` runs in config/index.ts AFTER this module first
// loads, so a module-level constant would freeze NODE_ENV=undefined and
// leak into the rebuilt logger.
const isProduction = () => process.env.NODE_ENV === 'production';
const isTelemetryOn = () => isProduction() || !!process.env.ENABLE_TELEMETRY;

// Format: explicit LOG_FORMAT wins. Otherwise pretty in dev, JSON in prod.
// LOG_FORMAT is the escape hatch for "I want JSON in dev to debug a parser"
// or "I want pretty in prod when shelled into a container".
const usePrettyFormat = () => {
  const explicit = process.env.LOG_FORMAT?.toLowerCase();
  if (explicit === 'pretty') return true;
  if (explicit === 'json') return false;
  return !isProduction();
};

// Mixin: pulls the active span from OTEL and writes Cloud-Logging-friendly
// trace fields on every log line. Works regardless of instrumentation-pino —
// we don't rely on it patching the logger.
const traceMixin = () => {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const sc = span.spanContext();
  if (!sc.traceId) return {};
  return {
    'logging.googleapis.com/trace': projectId
      ? `projects/${projectId}/traces/${sc.traceId}`
      : sc.traceId,
    'logging.googleapis.com/spanId': sc.spanId,
    'logging.googleapis.com/trace_sampled': (sc.traceFlags & 1) === 1,
  };
};

const buildLogger = (): Logger => {
  const usePretty = usePrettyFormat();
  const base: pino.LoggerOptions = {
    level: process.env.LOG_LEVEL || (isProduction() ? 'info' : 'debug'),
    base: { service: serviceName },
    messageKey: 'message',
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    mixin: traceMixin,
    // Without these, logging `{ err }` / `{ error }` prints `{}` — an Error's
    // message/stack are non-enumerable, so pino skips them. stdSerializers.err
    // extracts type/message/stack (and `cause`). This is why failures across
    // the app (and the Temporal worker) were showing up as empty objects.
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  };
  if (!usePretty) {
    // GCP-friendly severity field — only applied in JSON mode. In pretty
    // mode, leaving `level` as the numeric pino default lets pino-pretty
    // render the LEVEL prefix on every line. Replacing it with `severity`
    // would strip the prefix because pino-pretty looks for `level`.
    base.formatters = {
      level: (label: string) => ({ severity: label.toUpperCase() }),
    };
  }
  return usePretty
    ? pino(base, pinoPretty({
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        singleLine: true,
        // Hide noise (always-the-same `service`, raw `req`/`res` dumps that
        // pino-http emits — `customSuccessMessage` already folds method/url/
        // status into msg). Anything not ignored prints inline as key=value.
        ignore: 'pid,hostname,service,req,res',
        // Compose a single-line message: optional [domain] prefix, the msg
        // itself, then a few high-signal annotations. Other fields fall
        // through pino-pretty's default key=value tail rendering.
        messageFormat: (log: Record<string, unknown>, msgKey: string) => {
          const dom = typeof log.domain === 'string' ? `[${log.domain}] ` : '';
          const rt  = typeof log.responseTime === 'number' ? ` (${log.responseTime}ms)` : '';
          const uid = typeof log.userId === 'string' ? ` user=${log.userId.slice(0, 8)}` : '';
          return `${dom}${log[msgKey] ?? ''}${rt}${uid}`;
        },
      }))
    : pino(base);
};

// Eager logger so module-level `obs.logger` calls work before initObservability
// is called (config parsing, errors during boot). Domain modules that capture
// `obs.child(...)` at module load are tracked below so we can rebind them
// after initObservability — otherwise their children stay locked to the early
// (env-incomplete) logger and emit in the wrong format/level.
let logger: Logger = buildLogger();

// Children handed out before initObservability completes are wrapped in a
// Proxy that forwards method calls to a fresh child of the CURRENT logger.
// After initObservability rebuilds, callers automatically pick up the new
// format/level without needing to re-import or restart.
type ChildKey = string;
const liveChildren = new Map<ChildKey, Record<string, unknown>>();
const childKey = (b: Record<string, unknown>) => JSON.stringify(b);

const makeChild = (bindings: Record<string, unknown>): Logger => {
  const key = childKey(bindings);
  liveChildren.set(key, bindings);
  // Fresh child every property access — pino children are cheap (just a
  // bound prototype) and this keeps them in sync with the latest logger.
  return new Proxy({} as Logger, {
    get: (_, prop) => (logger.child(bindings) as any)[prop],
  });
};

const tracer = () => trace.getTracer(serviceName);

export const obs = {
  get logger(): Logger {
    return logger;
  },

  // Tag a logger with a fixed `domain` field. Returned child stays bound to
  // the latest logger even if initObservability rebuilds it later.
  child(bindings: Record<string, unknown>): Logger {
    return makeChild(bindings);
  },

  // Wrap an async operation in a span. Errors are recorded and re-thrown so
  // existing control flow is unaffected.
  async span<T>(
    name: string,
    fn: () => Promise<T>,
    opts: { attrs?: Attributes; kind?: SpanKind } = {},
  ): Promise<T> {
    return tracer().startActiveSpan(
      name,
      { attributes: opts.attrs, kind: opts.kind },
      async (span) => {
        try {
          const result = await fn();
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err: any) {
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  },

  // Inject the current trace context into a flat carrier (e.g. NATS headers
  // turned into key→value, HTTP headers object).
  inject<T extends Record<string, string>>(carrier: T = {} as T): T {
    propagation.inject(context.active(), carrier);
    return carrier;
  },

  // Shorthand for the most common case: just the W3C `traceparent` string
  // (or undefined if there's no active trace). Used for envelopes that
  // carry trace context as a single field — daemon ControlMessage, etc.
  activeTraceparent(): string | undefined {
    const carrier = obs.inject<Record<string, string>>();
    return carrier.traceparent;
  },

  // Run `fn` with the trace context restored from a carrier. Use on the
  // receiving side of any async boundary that doesn't propagate automatically.
  async runWithRemoteContext<T>(
    carrier: Record<string, string | undefined>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const ctx = propagation.extract(context.active(), carrier);
    return context.with(ctx, fn);
  },
};

// HTTP request logger middleware. Reads the live logger lazily so it picks
// up the rebuilt one after initObservability — important for format/level
// because pinoHttp captures its `logger` argument at construction time.
const httpLoggerProxy = new Proxy({} as Logger, {
  get: (_, prop) => (logger as any)[prop],
});
export const httpLogger = pinoHttp({
  logger: httpLoggerProxy,
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  customErrorMessage: (req, res, err) =>
    `${req.method} ${req.url} ${res.statusCode} ${err?.message ?? ''}`.trim(),
  customProps: (req) => ({ userId: (req as any).user?.id }),
  autoLogging: { ignore: (req) => req.url === '/health' },
  serializers: {
    req: (req) => ({ method: req.method, url: req.url, id: req.id }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});

export const initObservability = (name: string) => {
  serviceName = name;
  // Rebuild the logger so `service` binding + format/level pick up env that
  // dotenv has populated since module load. Children handed out earlier
  // automatically pick up the new logger via the Proxy in `makeChild`.
  logger = buildLogger();

  if (!isTelemetryOn()) {
    logger.info(
      { telemetry: 'disabled', format: usePrettyFormat() ? 'pretty' : 'json' },
      'Observability initialized (set ENABLE_TELEMETRY=1 to opt in locally)',
    );
    return;
  }
  try {
    // NOTE: ENABLE_TELEMETRY=1 currently uses Google Cloud Trace as the only
    // exporter (via @google-cloud/opentelemetry-cloud-trace-exporter). This
    // requires a GCP project and appropriate ADC credentials. Operators running
    // on other platforms should either implement their own exporter here, or set
    // OTEL_EXPORTER_OTLP_ENDPOINT and swap TraceExporter for
    // OTLPTraceExporter from @opentelemetry/exporter-trace-otlp-http to forward
    // traces to any OpenTelemetry-compatible backend (Jaeger, Tempo, etc.).
    sdk = new NodeSDK({
      serviceName: name,
      traceExporter: new TraceExporter({ projectId }),
      // Only HTTP + Express auto-instrumentations: one span per inbound
      // request, which IS our use-case boundary. Everything inside
      // (Prisma queries, fetch calls, file I/O) is too noisy to be
      // useful — Cloud Trace ends up full of pg-pool reconnects and
      // health-check pings instead of actual business operations.
      // Need a span inside a use case? Use `obs.tracer.startSpan(...)`
      // explicitly.
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': { enabled: false },
          '@opentelemetry/instrumentation-net': { enabled: false },
          '@opentelemetry/instrumentation-pg': { enabled: false },
          '@opentelemetry/instrumentation-dns': { enabled: false },
          '@opentelemetry/instrumentation-http': { enabled: true },
          '@opentelemetry/instrumentation-express': { enabled: true },
        }),
      ],
    });
    sdk.start();
    logger.info({ telemetry: 'enabled' }, 'Observability initialized → Cloud Trace');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize telemetry');
  }
};

export const shutdownObservability = async () => {
  if (sdk) await sdk.shutdown();
};
