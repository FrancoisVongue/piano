import { Services } from '../../services/init';
import { Subjects } from '../../services/nats';
import { JSONCodec } from 'nats';
import { obs } from '../../services/observability';

const log = obs.child({ domain: 'sse-worker' });
const jc = JSONCodec();

export const createSseWorker = (services: Services) => {
  const subUpdate = services.nats.subscribe(Subjects.RunUpdate);
  const subComplete = services.nats.subscribe(Subjects.RunComplete);

  log.info(
    { subjects: [Subjects.RunUpdate, Subjects.RunComplete] },
    'SSE worker listening',
  );

  const handleMessage = async (msg: any, eventType: 'run.update' | 'run.complete') => {
    await services.nats.withMessageContext(msg, async () => {
      const { noteId, clientId, content } = jc.decode(msg.data) as { noteId: string, clientId: string, content: any };
      log.trace({ eventType, clientId, noteId }, 'Sending SSE event');
      services.sse.sendEvent(clientId, eventType, { noteId, content });
    });
  };

  (async () => {
    for await (const msg of subUpdate) handleMessage(msg, 'run.update');
  })().catch(err => log.error({ err, subject: Subjects.RunUpdate }, 'SSE worker failed'));

  (async () => {
    for await (const msg of subComplete) handleMessage(msg, 'run.complete');
  })().catch(err => log.error({ err, subject: Subjects.RunComplete }, 'SSE worker failed'));

  return { subUpdate, subComplete };
};
