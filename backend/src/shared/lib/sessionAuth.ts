import { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Services } from '../../services/init';

// -----------------------------------------------------------------------------
// The ONE auth story for the backend.
//
// better-auth's getSession accepts cookies OR Authorization: Bearer headers
// transparently, so we don't pre-check the header shape — we just ask for a
// session. If there isn't one, 401. Otherwise we stash the id on the request
// and move on.
//
// Historical note: there used to be a second middleware in
// domains/auth/middleware.ts (`requireAuth`) that early-rejected cookie-only
// requests and stashed `email`, `name`, `sessionToken` — all of which turned
// out to be unused. It was deleted; this file is now the single source of
// truth for "who is the caller?".
// -----------------------------------------------------------------------------

declare global {
  namespace Express {
    // Only `id` — nothing else is read anywhere in the codebase.
    interface Request {
      user?: { id: string };
    }
  }
}

export const sessionAuth = (services: Services): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction) => {
    const session = await services.auth.api.getSession({ headers: req.headers as any });
    if (!session?.user?.id) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    req.user = { id: session.user.id };
    next();
  };

// After sessionAuth runs, req.user is guaranteed. This accessor lets routes
// read the id as prose without a non-null assertion dance.
export const authUserId = (req: Request): string => {
  const id = req.user?.id;
  if (!id) throw new Error('authUserId called without prior sessionAuth middleware');
  return id;
};

export const paramId = (req: Request, name: string = 'id'): string => {
  const v = req.params[name];
  if (!v) throw new Error(`Missing path parameter: ${name}`);
  return v;
};
