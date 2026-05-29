import { Router } from 'express';
import { match } from 'venum';
import {
  CanvasGatewayController,
  UpdateNodeSchema,
  CreateNodeSchema,
  RollbackSchema,
} from './controller';
import {
  MachinesGatewayController,
  SpawnSchema,
  ExecSchema,
} from './machines.controller';
import { asyncHandler } from '../../shared/lib/asyncHandler';
import { machineAuth, machineCtx } from '../../shared/lib/machineAuth';
import { paramId } from '../../shared/lib/sessionAuth';
import { sendDaemonError } from '../../services/daemon.adapter';

// -----------------------------------------------------------------------------
// /api/canvas/* — Canvas Gateway, the read/write surface for code running
// inside a machine. Every route runs under `machineAuth`, which scopes
// the caller to exactly one arrangement (the one the machine lives on).
// Route handlers therefore never accept `arrangementId` from the caller
// — it's pinned by middleware.
// -----------------------------------------------------------------------------

export const createCanvasGatewayRouter = () => {
  const router = Router();
  router.use(machineAuth);

  // GET /api/canvas/me — this machine's own context (id, arrangement, user).
  // Useful for the CLI to validate its env and surface identity.
  router.get('/me', asyncHandler(async (req, res) => {
    res.json({ success: machineCtx(req) });
  }));

  // GET /api/canvas/nodes — every node in my arrangement.
  router.get('/nodes', asyncHandler(async (req, res) => {
    const ctx = machineCtx(req);
    const nodes = await CanvasGatewayController.list(ctx.arrangementId);
    res.json({ success: nodes });
  }));

  // GET /api/canvas/nodes/:id — read one node (must be in my arrangement).
  // `+<id>` references are resolved and inlined by default; `?raw=1` opts
  // out and returns the bare markers.
  router.get('/nodes/:id', asyncHandler(async (req, res) => {
    const ctx = machineCtx(req);
    const resolve = req.query.raw !== '1' && req.query.raw !== 'true';
    const result = await CanvasGatewayController.get(ctx.arrangementId, paramId(req), resolve);
    match(result, {
      ok:       (n) => res.json({ success: n }),
      notFound: (e) => res.status(404).json({ error: e }),
    });
  }));

  // PATCH /api/canvas/nodes/:id — content / label / position. Optimistic
  // concurrency via `expectedVersion`; mismatch returns 409 with the
  // current row so the AI can re-read and retry.
  router.patch('/nodes/:id', asyncHandler(async (req, res) => {
    const ctx = machineCtx(req);
    const dto = UpdateNodeSchema.parse(req.body ?? {});
    const result = await CanvasGatewayController.update(
      ctx.id, ctx.userId, ctx.arrangementId, paramId(req), dto,
    );
    match(result, {
      ok:               (n) => res.json({ success: n }),
      notFound:         (e) => res.status(404).json({ error: e }),
      versionMismatch:  (e) => res.status(409).json({ error: e }),
    });
  }));

  // POST /api/canvas/nodes — create a new TEXT node in my arrangement.
  router.post('/nodes', asyncHandler(async (req, res) => {
    const ctx = machineCtx(req);
    const dto = CreateNodeSchema.parse(req.body ?? {});
    const result = await CanvasGatewayController.create(
      ctx.id, ctx.userId, ctx.arrangementId, dto,
    );
    match(result, {
      ok: (n) => res.status(201).json({ success: n }),
    });
  }));

  // GET /api/canvas/nodes/:id/versions — list the bounded history (newest first).
  router.get('/nodes/:id/versions', asyncHandler(async (req, res) => {
    const ctx = machineCtx(req);
    const result = await CanvasGatewayController.listVersions(ctx.arrangementId, paramId(req));
    match(result, {
      ok:       (v) => res.json({ success: v }),
      notFound: (e) => res.status(404).json({ error: e }),
    });
  }));

  // POST /api/canvas/nodes/:id/rollback — body {versionId}. Switches the
  // note's content to that snapshot, snaps the current state first so the
  // rollback is itself reversible.
  router.post('/nodes/:id/rollback', asyncHandler(async (req, res) => {
    const ctx = machineCtx(req);
    const { versionId } = RollbackSchema.parse(req.body ?? {});
    const result = await CanvasGatewayController.rollback(
      ctx.id, ctx.userId, ctx.arrangementId, paramId(req), versionId,
    );
    match(result, {
      ok:       (n) => res.json({ success: n }),
      notFound: (e) => res.status(404).json({ error: e }),
    });
  }));

  // ---------------------------------------------------------------------
  // /api/canvas/machines/* — peer-machine surface. Symmetric to the
  // host-side `piano machine *` CLI, scoped to the caller's arrangement.
  // ---------------------------------------------------------------------

  // GET /api/canvas/machines — list peers in my arrangement.
  router.get('/machines', asyncHandler(async (req, res) => {
    const ctx = machineCtx(req);
    const list = await MachinesGatewayController.list(ctx.arrangementId);
    res.json({ success: list });
  }));

  // GET /api/canvas/machines/:id — one peer's metadata.
  router.get('/machines/:id', asyncHandler(async (req, res) => {
    const ctx = machineCtx(req);
    const result = await MachinesGatewayController.get(ctx.arrangementId, paramId(req));
    match(result, {
      ok:       (n) => res.json({ success: n }),
      notFound: (e) => res.status(404).json({ error: e }),
    });
  }));

  // GET /api/canvas/machines/:id/output — recent PTY output (docker logs-like).
  router.get('/machines/:id/output', asyncHandler(async (req, res) => {
    const ctx = machineCtx(req);
    const result = await MachinesGatewayController.output(ctx.arrangementId, paramId(req));
    match(result, {
      ok:       (d) => res.json({ success: d }),
      notFound: (e) => res.status(404).json({ error: e }),
      ...sendDaemonError(res),
    });
  }));

  // POST /api/canvas/machines/:id/exec — one-shot exec, returns
  // {output, exitCode}. Same shape `docker exec` (without -it) returns.
  router.post('/machines/:id/exec', asyncHandler(async (req, res) => {
    const ctx = machineCtx(req);
    const dto = ExecSchema.parse(req.body ?? {});
    const result = await MachinesGatewayController.exec(ctx.arrangementId, paramId(req), dto);
    match(result, {
      ok:       (d) => res.json({ success: d }),
      notFound: (e) => res.status(404).json({ error: e }),
      ...sendDaemonError(res),
    });
  }));

  // POST /api/canvas/machines — spawn a new peer in my arrangement.
  router.post('/machines', asyncHandler(async (req, res) => {
    const ctx = machineCtx(req);
    const dto = SpawnSchema.parse(req.body ?? {});
    const result = await MachinesGatewayController.spawn(
      ctx.userId, ctx.id, ctx.arrangementId, ctx.daemonId, dto,
    );
    match(result, {
      ok:       (d) => res.status(201).json({ success: d }),
      notFound: (e) => res.status(404).json({ error: e }),
      ...sendDaemonError(res),
    });
  }));

  // POST /api/canvas/machines/:id/freeze — freeze a peer.
  router.post('/machines/:id/freeze', asyncHandler(async (req, res) => {
    const ctx = machineCtx(req);
    const result = await MachinesGatewayController.freeze(ctx.arrangementId, paramId(req));
    match(result, {
      ok:       (d) => res.json({ success: d }),
      notFound: (e) => res.status(404).json({ error: e }),
      ...sendDaemonError(res),
    });
  }));

  // POST /api/canvas/machines/:id/attach — start an interactive PTY
  // session on a peer. Returns {sessionId, wsPath}. Caller dials wsPath
  // with the same Bearer header to get the WebSocket terminal.
  router.post('/machines/:id/attach', asyncHandler(async (req, res) => {
    const ctx = machineCtx(req);
    const result = await MachinesGatewayController.attach(ctx.userId, ctx.arrangementId, paramId(req));
    match(result, {
      ok:       (d) => res.status(201).json({ success: d }),
      notFound: (e) => res.status(404).json({ error: e }),
      ...sendDaemonError(res),
    });
  }));

  // DELETE /api/canvas/machines/:id — destroy a peer (container + canvas note).
  router.delete('/machines/:id', asyncHandler(async (req, res) => {
    const ctx = machineCtx(req);
    const result = await MachinesGatewayController.remove(ctx.arrangementId, paramId(req));
    match(result, {
      ok:       (d) => res.json({ success: d }),
      notFound: (e) => res.status(404).json({ error: e }),
      ...sendDaemonError(res),
    });
  }));

  return router;
};
