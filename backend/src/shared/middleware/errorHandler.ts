import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../errors/http';
import { obs } from '../../services/observability';

const log = obs.child({ domain: 'error-handler' });

export const errorHandler = (
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  log.error(
    { err: error, url: req.url, method: req.method },
    'Error caught by middleware',
  );

  if (error instanceof HttpError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  if (error instanceof ZodError) {
    const message = error.issues[0]?.message || 'Validation error';
    res.status(400).json({ error: message });
    return;
  }

  res.status(500).json({ error: 'Internal server error' });
};
