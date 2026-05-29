import { Request, Response, NextFunction, RequestHandler } from 'express';
import { services } from '../../services/init';
import { sha256Hex } from './sha256';

// -----------------------------------------------------------------------------
// machineAuth — authenticates the CALLER as a machine, by Bearer token.
//
// Counterpart to sessionAuth (which authenticates a human user). Used on
// /api/canvas/* routes. The token is minted by `POST /api/machines/:id/canvas-token`
// (sessionAuth-protected, see MachineController.issueCanvasToken); we
// store its sha256 hash, look it up on every request, and pin the caller
// to the machine the token was minted for.
//
// Lookup chain on success:
//   bearer → sha256(bearer) → MachineApiToken row → machineId
//          → Note row (machineId, type MACHINE|TERMINAL) → arrangementId, userId
//
// The Note lookup is the same source of truth MachineController uses for
// "which arrangement does this machine belong to" — keeps the mental
// model uniform across surfaces.
// -----------------------------------------------------------------------------

declare global {
  namespace Express {
    interface Request {
      // daemonId is nullable: legacy machines pre-multi-daemon have no
      // pinning. Spawn-from-canvas requires it; other ops don't care.
      machine?: { id: string; arrangementId: string; userId: string; daemonId: string | null };
    }
  }
}

function extractBearer(req: Request): string | null {
  const h = req.header('authorization');
  if (!h) return null;
  const [scheme, token] = h.split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

export const machineAuth: RequestHandler =
  async (req: Request, res: Response, next: NextFunction) => {
    const bearer = extractBearer(req);
    if (!bearer) {
      res.status(401).json({ error: { message: 'Authorization: Bearer <token> required' } });
      return;
    }

    const tokenHash = await sha256Hex(bearer);
    const row = await services.prisma.machineApiToken.findUnique({
      where: { tokenHash },
      select: { id: true, machineId: true, userId: true, revokedAt: true },
    });
    if (!row || row.revokedAt) {
      res.status(401).json({ error: { message: 'Invalid or revoked token' } });
      return;
    }

    const note = await services.prisma.note.findFirst({
      where: { machineId: row.machineId, type: { in: ['MACHINE', 'TERMINAL'] } },
      select: { arrangementId: true, userId: true, machineId: true, daemonId: true },
    });
    if (!note?.machineId) {
      res.status(404).json({ error: { message: `Token's machine no longer exists` } });
      return;
    }

    req.machine = {
      id: note.machineId,
      arrangementId: note.arrangementId,
      userId: note.userId,
      daemonId: note.daemonId,
    };

    // Best-effort lastUsedAt update — never block the request on its result.
    services.prisma.machineApiToken
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});

    next();
  };

export const machineCtx = (req: Request) => {
  const m = req.machine;
  if (!m) throw new Error('machineCtx called without prior machineAuth middleware');
  return m;
};
