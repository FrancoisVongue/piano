import {
  connect,
  NatsConnection,
  JSONCodec,
  JetStreamClient,
  JetStreamManager,
  RetentionPolicy,
  DiscardPolicy,
  headers as createHeaders,
  MsgHdrs,
  Msg,
} from 'nats';
import { obs } from './observability';
import { Config } from '../config';

export enum Subjects {
  // Pub/Sub subjects (existing)
  RunRequest = 'run.request',
  RunUpdate = 'run.update',
  RunComplete = 'run.complete',

  // JetStream subjects for AI execution
  AIAction = 'ai.action',
  AIUnifier = 'ai.unifier',
  AIWorkflow = 'ai.workflow',

  // Events (for SSE broadcasting)
  NodeUpdated = 'node.updated',
  EdgeUpdated = 'edge.updated',
}

const log = obs.child({ domain: 'nats' });

// NATS message headers ↔ flat carrier — for OTEL propagation API.
const headersToCarrier = (h: MsgHdrs | undefined): Record<string, string> => {
  if (!h) return {};
  const out: Record<string, string> = {};
  for (const k of h.keys()) out[k] = h.get(k);
  return out;
};

const injectContextIntoHeaders = (h: MsgHdrs) => {
  const carrier = obs.inject<Record<string, string>>();
  for (const [k, v] of Object.entries(carrier)) h.set(k, v);
};

class NatsService {
  private nc: NatsConnection | null = null;
  private js: JetStreamClient | null = null;
  private jsm: JetStreamManager | null = null;
  private jc = JSONCodec();

  constructor(private config: Config) {}

  get client(): NatsConnection {
    if (!this.nc) throw new Error('NATS client not connected');
    return this.nc;
  }

  get jetstream(): JetStreamClient {
    if (!this.js) throw new Error('JetStream not initialized');
    return this.js;
  }

  async connect(): Promise<void> {
    try {
      this.nc = await connect({
        servers: this.config.nats.url,
        reconnect: true,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 1000,
      });

      (async () => {
        if (!this.nc) return;
        for await (const status of this.nc.status()) {
          log.info({ statusType: status.type, statusData: status.data ?? null }, 'NATS status');
        }
      })().catch((err) => {
        log.error({ err }, 'NATS status monitor error');
      });

      this.js = this.nc.jetstream();
      this.jsm = await this.nc.jetstreamManager();
      log.info('NATS connected');

      await this.initializeStreams();
    } catch (err) {
      log.error({ err }, 'NATS connection failed');
      throw err;
    }
  }

  private async initializeStreams(): Promise<void> {
    if (!this.jsm) return;

    const streamConfig = {
      name: 'AI_REQUESTS',
      subjects: [Subjects.AIAction, Subjects.AIUnifier, Subjects.AIWorkflow],
      retention: RetentionPolicy.Workqueue,
      max_msgs: 10000,
      discard: DiscardPolicy.Old,
    };

    try {
      await this.jsm.streams.add(streamConfig);
      log.info('JetStream stream AI_REQUESTS created');
    } catch (err: any) {
      if (err.message?.includes('already in use')) {
        await this.jsm.streams.update('AI_REQUESTS', streamConfig);
        log.info('JetStream stream AI_REQUESTS updated with new subjects');
      } else {
        log.error({ err }, 'Failed to initialize JetStream streams');
        throw err;
      }
    }
  }

  // Pub/Sub publish — injects current trace context into NATS headers so the
  // subscriber side can resume the same trace.
  async publish(subject: Subjects | string, data: any): Promise<void> {
    if (!this.nc) throw new Error('NATS client not connected');
    const hdrs = createHeaders();
    injectContextIntoHeaders(hdrs);
    this.nc.publish(subject, this.jc.encode(data), { headers: hdrs });
  }

  // JetStream publish with priority. Same propagation contract as `publish`.
  async publishToQueue(subject: Subjects, data: any, priority: number = 5): Promise<void> {
    if (!this.nc || this.nc.isClosed()) {
      throw new Error('NATS connection is closed. Cannot publish to queue.');
    }
    if (!this.js) throw new Error('JetStream not initialized');

    const hdrs = createHeaders();
    hdrs.set('Nats-Priority', priority.toString());
    injectContextIntoHeaders(hdrs);

    await this.js.publish(subject, this.jc.encode(data), { headers: hdrs });
  }

  subscribe(subject: Subjects | string, callback?: (data: any) => void | Promise<void>) {
    if (!this.nc) throw new Error('NATS client not connected');

    const sub = this.nc.subscribe(subject);

    if (callback) {
      (async () => {
        for await (const msg of sub) {
          await this.withMessageContext(msg, async () => {
            try {
              const data = this.jc.decode(msg.data);
              await callback(data);
            } catch (err) {
              log.error({ err, subject }, 'Error processing NATS message');
            }
          });
        }
      })();
    }

    return sub;
  }

  // Run `fn` with the trace context extracted from a NATS message's headers.
  // Use this when iterating subscriptions / JetStream consumers manually so
  // every handler runs on the same trace as the publisher.
  withMessageContext<T>(msg: { headers?: MsgHdrs }, fn: () => Promise<T>): Promise<T> {
    return obs.runWithRemoteContext(headersToCarrier(msg.headers), fn);
  }
}

export default NatsService;
