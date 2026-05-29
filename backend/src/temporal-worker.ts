/**
 * Temporal Worker Process
 *
 * NATS JetStream → Temporal Workflows.
 *
 * Flow:
 *   1. Subscribe to NATS JetStream queue ('ai.action', 'ai.unifier').
 *   2. For each message: extract trace context from NATS headers, then start
 *      a Temporal workflow inside that trace span — distributed trace stays
 *      glued together across the queue boundary.
 *   3. Run Temporal worker to execute workflows.
 */

import { initObservability, obs } from './services/observability';
initObservability('piano-temporal-worker');

import { Worker, NativeConnection, Runtime } from '@temporalio/worker';
import { WorkflowClient } from '@temporalio/client';
import { ServicesFactory } from './services/init';
import * as activities from './temporal/activities';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AckPolicy, DeliverPolicy } from 'nats';
import config from './config';
import { jobFor } from './temporal/dispatch';

const log = obs.child({ domain: 'temporal-worker' });

// Temporal SDK is extremely verbose at TRACE/DEBUG. Surface WARN+ only.
// The SDK reports failures under an `error` key; rename it to `err` so it hits
// the logger's error serializer (and pino-pretty's stack rendering) instead of
// printing as `{}`. This is what was hiding the real "Activity failed" reason.
const withErr = (attrs?: Record<string, unknown>): Record<string, unknown> => {
  if (!attrs) return {};
  const { error, ...rest } = attrs;
  return error === undefined ? rest : { ...rest, err: error };
};
Runtime.install({
  logger: {
    log: () => {},
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (message, attrs) => log.warn(withErr(attrs as Record<string, unknown>), `[SDK] ${message}`),
    error: (message, attrs) => log.error(withErr(attrs as Record<string, unknown>), `[SDK] ${message}`),
  },
});

const servicesFactory = new ServicesFactory(config);
const services = await servicesFactory.init().catch(e => {
  log.error({ err: e }, 'Failed to initialize services');
  if (config.env !== 'development') process.exit(1);
  throw e;
});

async function run() {
  try {
    const connection = await NativeConnection.connect({ address: config.temporal.address });
    const temporalClient = new WorkflowClient({ connection });

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const workflowsPath = path.join(__dirname, 'temporal/workflows');

    const worker = await Worker.create({
      connection,
      namespace: 'default',
      taskQueue: 'ai-workflows',
      workflowsPath,
      activities,
    });
    log.info(
      { temporal: config.temporal.address, activities: Object.keys(activities) },
      'Connected to Temporal',
    );

    const workerPromise = worker.run();
    await new Promise(resolve => setTimeout(resolve, 500));

    const jsm = await services.nats.client.jetstreamManager();
    const js = services.nats.jetstream;

    try {
      await jsm.consumers.add('AI_REQUESTS', {
        durable_name: 'temporal-worker',
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
      });
    } catch (err: any) {
      if (!err.message?.includes('already in use')) throw err;
    }

    const consumer = await js.consumers.get('AI_REQUESTS', 'temporal-worker');

    (async () => {
      const messages = await consumer.consume();

      for await (const msg of messages) {
        const startTime = Date.now();
        const priority = msg.headers?.get('Nats-Priority') || 'unknown';

        // Resume the trace from the publisher (HTTP controller in api process)
        // and wrap workflow start in a child span so Cloud Trace shows the
        // queue-to-workflow link.
        await services.nats.withMessageContext(msg, async () => {
          await obs
            .span(
              `nats.consume ${msg.subject}`,
              async () => {
                const payload = JSON.parse(new TextDecoder().decode(msg.data));
                const job = jobFor(msg.subject, payload);

                await obs.span(
                  `temporal.start ${job.name}`,
                  () =>
                    temporalClient.start(job.name, {
                      taskQueue: 'ai-workflows',
                      workflowId: job.id,
                      args: [job.args],
                    }),
                  { attrs: { 'workflow.id': job.id, 'workflow.name': job.name } },
                );

                log.info(
                  { subject: msg.subject, workflowId: job.id, priority, latencyMs: Date.now() - startTime },
                  'Dispatched to Temporal',
                );
                msg.ack();
              },
              { attrs: { 'messaging.system': 'nats', 'messaging.destination': msg.subject } },
            )
            .catch((err) => {
              log.error(
                { err, subject: msg.subject, latencyMs: Date.now() - startTime },
                'Dispatch failed',
              );
              msg.nak();
            });
        });
      }
    })();

    log.info('🚀 Worker ready — listening on ai.action, ai.unifier (priority 1–5)');
    await workerPromise;
  } catch (err) {
    log.error({ err }, 'Fatal error in temporal-worker');
    process.exit(1);
  }
}

run().catch((err) => {
  log.error({ err }, 'Unhandled error');
  process.exit(1);
});
