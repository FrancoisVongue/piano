import { Request, Response, NextFunction, Router } from 'express';
import { match } from 'venum';
import { Daemon } from '@piano/shared';
import { DaemonController } from './controller';
import type { Services } from '../../services/init';
import { asyncHandler } from '../../shared/lib/asyncHandler';
import { sessionAuth, authUserId, paramId } from '../../shared/lib/sessionAuth';

// Defence-in-depth on the unauthenticated /pair endpoint: 32^8 codes make
// brute force impossible, but hammering Postgres with bogus findUnique is
// wasteful. 30/min/IP is generous for a real user pasting a code.
const PAIR_BUCKET_MAX = 30;
const PAIR_BUCKET_WINDOW_MS = 60_000;
const pairAttempts = new Map<string, { count: number; resetAt: number }>();

function pairRateLimit(req: Request, res: Response, next: NextFunction) {
  const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString();
  const now = Date.now();
  let entry = pairAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + PAIR_BUCKET_WINDOW_MS };
    pairAttempts.set(ip, entry);
  }
  entry.count += 1;
  if (entry.count > PAIR_BUCKET_MAX) {
    res.status(429).json({ error: { message: 'Too many pair attempts — slow down.' } });
    return;
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of pairAttempts) {
    if (entry.resetAt < now) pairAttempts.delete(ip);
  }
}, PAIR_BUCKET_WINDOW_MS);

export const createDaemonRouter = (services: Services) => {
  const router = Router();

  // Public — daemon CLI hits this with a one-time pairing code. No session.
  router.post('/pair', pairRateLimit, asyncHandler(async (req, res) => {
    const dto = Daemon.validate.pair(req.body);
    const result = await DaemonController.pair(dto);
    match(result, {
      ok:              (data) => res.status(200).json({ success: data }),
      notFound:        (err)  => res.status(404).json({ error: err }),
      consumed:        (err)  => res.status(410).json({ error: err }),
      expired:         (err)  => res.status(410).json({ error: err }),
      portsExhausted:  (err)  => res.status(503).json({ error: err }),
    });
  }));

  router.use(sessionAuth(services));

  router.get('/', asyncHandler(async (req, res) => {
    const list = await DaemonController.list(authUserId(req));
    res.json({ success: list });
  }));

  router.post('/pair-codes', asyncHandler(async (req, res) => {
    const dto = Daemon.validate.createPairingCode(req.body);
    const result = await DaemonController.createPairingCode(authUserId(req), dto);
    match(result, {
      ok:        (data) => res.status(201).json({ success: data }),
      nameTaken: (err)  => res.status(409).json({ error: err }),
    });
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const dto = Daemon.validate.update(req.body);
    const result = await DaemonController.update(authUserId(req), paramId(req), dto);
    match(result, {
      ok:       (data) => res.json({ success: data }),
      notFound: (err)  => res.status(404).json({ error: err }),
    });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const result = await DaemonController.delete(authUserId(req), paramId(req));
    match(result, {
      ok:       ()    => res.json({ success: true }),
      notFound: (err) => res.status(404).json({ error: err }),
    });
  }));

  router.delete('/pair-codes/:code', asyncHandler(async (req, res) => {
    const result = await DaemonController.cancelPairingCode(authUserId(req), paramId(req, 'code'));
    match(result, { ok: () => res.json({ success: true }) });
  }));

  router.post('/:id/rotate-token', asyncHandler(async (req, res) => {
    const result = await DaemonController.rotateToken(authUserId(req), paramId(req));
    match(result, {
      ok:       (data) => res.json({ success: data }),
      notFound: (err)  => res.status(404).json({ error: err }),
    });
  }));

  router.post('/:id/pause', asyncHandler(async (req, res) => {
    const result = await DaemonController.setPaused(authUserId(req), paramId(req), true);
    match(result, {
      ok:       (data) => res.json({ success: data }),
      notFound: (err)  => res.status(404).json({ error: err }),
    });
  }));

  router.post('/:id/resume', asyncHandler(async (req, res) => {
    const result = await DaemonController.setPaused(authUserId(req), paramId(req), false);
    match(result, {
      ok:       (data) => res.json({ success: data }),
      notFound: (err)  => res.status(404).json({ error: err }),
    });
  }));

  return router;
};
