import { Request, Response } from 'express';
import { obs } from './observability';

const log = obs.child({ domain: 'sse' });

export class SSEService {
  private clients: Map<string, Response> = new Map();

  addClient(req: Request, res: Response) {
    const clientId = req.query.clientId as string;
    if (!clientId) {
      log.error('SSE connection attempt without clientId');
      res.status(400).send('Client ID is required');
      return;
    }

    this.clients.set(clientId, res);
    log.info({ clientId }, 'SSE client connected');

    req.on('close', () => {
      this.removeClient(clientId);
    });
  }

  removeClient(clientId: string) {
    this.clients.delete(clientId);
    log.info({ clientId }, 'SSE client disconnected');
  }

  sendEvent<T>(clientId: string, event: string, data: T) {
    const client = this.clients.get(clientId);
    if (client) {
      client.write(`event: ${event}\n`);
      client.write(`data: ${JSON.stringify(data)}\n\n`);
      log.trace({ clientId, event }, 'SSE event sent');
    } else {
      log.warn(
        { clientId, event, connected: Array.from(this.clients.keys()) },
        'SSE client not connected — dropping event',
      );
    }
  }
}
