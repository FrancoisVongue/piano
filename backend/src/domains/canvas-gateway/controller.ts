import { venum } from 'venum';
import { z } from 'zod';
import { services } from '../../services/init';
import { emitNodeUpdated } from '../action/shared';
import { resolveFromMap } from './resolve';

// -----------------------------------------------------------------------------
// CanvasGatewayController — read/write the calling machine's arrangement.
//
// This is the third first-class client of the backend, alongside the
// browser frontend and the host `piano machine` CLI. Here the CALLER is a
// process running INSIDE a piano machine (typically an AI agent invoking
// `piano canvas *`). The auth boundary (machineAuth middleware) has
// already pinned the caller to one machine, which pins it to one
// arrangement. Every method below scopes its DB reads/writes to that
// arrangement — a machine cannot reach into another arrangement, ever.
//
// Versioning: each gateway write to content snaps the prior content into
// NoteVersion (bounded to last 4 per note). A 30-second cooldown collapses
// rapid edits onto a single snapshot row — typing/AI bursts don't fill
// the table with near-identical rows. Rollback restores a snapshot's
// content; it itself snaps a version so it's reversible.
// Note.version (LWW int) is separate: it gates `expectedVersion` writes
// to prevent two writers clobbering each other's last-read state.
// -----------------------------------------------------------------------------

// Local DTO shapes — gateway is not consumed by the frontend, so we don't
// pollute @piano/shared with these.
export const UpdateNodeSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  content: z.string().max(100_000).optional(),
  label: z.string().nullable().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});
export type UpdateNode = z.infer<typeof UpdateNodeSchema>;

// V0: only TEXT nodes can be created from the gateway. MACHINE/TERMINAL/GROUP
// nodes have side effects (spawn containers, create edges) that don't
// belong on this surface yet; revisit when the AI needs to provision its
// own siblings.
export const CreateNodeSchema = z.object({
  content: z.string().default(''),
  label: z.string().optional(),
  x: z.number().default(0),
  y: z.number().default(0),
  parentId: z.string().optional(),
});
export type CreateNode = z.infer<typeof CreateNodeSchema>;

export const RollbackSchema = z.object({
  versionId: z.string().min(1),
});
export type Rollback = z.infer<typeof RollbackSchema>;

// History size and edit-burst window. Both small ints; lift to env if a
// tenant ever pushes back on them, but pre-tuning is premature.
const VERSION_HISTORY_LIMIT = 4;
const VERSION_COALESCE_WINDOW_MS = 30_000;

// snapNoteVersion captures the prior content of a note before the caller
// overwrites it. Within VERSION_COALESCE_WINDOW_MS of the previous snapshot
// we overwrite that row instead of inserting — so a burst of edits leaves
// at most one row per window. Older rows past VERSION_HISTORY_LIMIT are
// trimmed. Idempotent: callers can call it before every update without
// worrying about exploding the table.
//
// `content` here is the value about to BECOME stale — i.e. the note's
// pre-update content. Pass `current.content`, not the new value.
async function snapNoteVersion(
  noteId: string,
  staleContent: string,
  author: string,
): Promise<void> {
  const last = await services.prisma.noteVersion.findFirst({
    where: { noteId },
    orderBy: { createdAt: 'desc' },
  });
  const now = new Date();

  if (last && now.getTime() - last.createdAt.getTime() < VERSION_COALESCE_WINDOW_MS) {
    // Within the coalesce window — overwrite that same row. We deliberately
    // KEEP its `content` (the older value) as the snapshot, NOT the newer
    // staleContent; the goal is to preserve the OLDEST pre-burst state so
    // a quick mistake is recoverable. Only `createdAt` and `author` move
    // forward, marking that the burst continued.
    await services.prisma.noteVersion.update({
      where: { id: last.id },
      data: { createdAt: now, author },
    });
    return;
  }

  await services.prisma.noteVersion.create({
    data: { noteId, content: staleContent, author },
  });

  // Trim. We could prune older rows in a single query with a window
  // function, but Postgres + Prisma make the two-step form readable; node
  // version counts stay tiny so the extra round-trip is fine.
  const rows = await services.prisma.noteVersion.findMany({
    where: { noteId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (rows.length > VERSION_HISTORY_LIMIT) {
    await services.prisma.noteVersion.deleteMany({
      where: { id: { in: rows.slice(VERSION_HISTORY_LIMIT).map(r => r.id) } },
    });
  }
}

export class CanvasGatewayController {
  // List every node in the calling machine's arrangement. Returned in
  // creation order so the AI gets a stable sequence to reference.
  static list(arrangementId: string) {
    return services.prisma.note.findMany({
      where: { arrangementId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // Read a node. With `resolve` on (the default), `+<id>` references in
  // the content are walked forward and inlined — the PULL model: all the
  // work happens here, at read time, never on write. `content` stays the
  // raw text; the assembled text rides alongside as `resolvedContent`.
  // With `resolve` off, `resolvedContent` is null and the caller sees the
  // bare `+ref` markers.
  static async get(arrangementId: string, noteId: string, resolve: boolean) {
    const note = await services.prisma.note.findFirst({
      where: { id: noteId, arrangementId },
    });
    if (!note) return venum('notFound', { message: `Node ${noteId} not found` });

    let resolvedContent: string | null = null;
    if (resolve) {
      // ONE query: pull every node in the arrangement, build an in-memory
      // id→content map, resolve against it. The map is its own cache, so
      // a diamond reference fetches nothing extra. Scoping to arrangementId
      // here is also the security boundary — a `+ref` to a node in another
      // arrangement simply isn't in the map and gets left literal.
      const all = await services.prisma.note.findMany({
        where: { arrangementId },
        select: { id: true, content: true },
      });
      const map = new Map(all.map((n) => [n.id, n.content]));
      resolvedContent = resolveFromMap(map, noteId);
    }
    return venum('ok', { ...note, resolvedContent });
  }

  static async update(
    machineId: string,
    userId: string,
    arrangementId: string,
    noteId: string,
    patch: UpdateNode,
  ) {
    const current = await services.prisma.note.findFirst({
      where: { id: noteId, arrangementId },
    });
    if (!current) return venum('notFound', { message: `Node ${noteId} not found` });
    if (current.version !== patch.expectedVersion) {
      return venum('versionMismatch', {
        message: `Expected version ${patch.expectedVersion}, current is ${current.version}`,
        current,
      });
    }

    // Snap the PRIOR content before overwriting — only when content is
    // actually changing. Position/label edits don't burn a snapshot.
    if (patch.content !== undefined && patch.content !== current.content) {
      await snapNoteVersion(noteId, current.content, `machine:${machineId}`);
    }

    const updated = await services.prisma.note.update({
      where: { id: noteId },
      data: {
        ...(patch.content !== undefined && { content: patch.content }),
        ...(patch.label !== undefined && { label: patch.label }),
        ...(patch.x !== undefined && { x: patch.x }),
        ...(patch.y !== undefined && { y: patch.y }),
        version: current.version + 1,
      },
    });
    emitNodeUpdated(userId, updated as any);
    return venum('ok', updated);
  }

  // Auto-position when caller doesn't specify (offset from origin so several
  // creates don't pile on top of each other). Edge to the caller's own
  // node is intentionally NOT created — the AI decides connectivity
  // separately via a future `POST /api/canvas/edges`.
  static async create(
    callerMachineId: string,
    userId: string,
    arrangementId: string,
    input: CreateNode,
  ) {
    // Layer membership (dev's per-note `layers` invariant): a freshly
    // created node inherits its creator's layer context rather than
    // defaulting to `[]` (global), which would clutter every layer view.
    // Precedence mirrors the frontend's createNode / createChildNode:
    //   parent's layers (most specific) > caller machine's layers (the
    //   agent's "active layer") > [] (global, the documented fallback).
    const layers = await this.inheritLayers(arrangementId, input.parentId, callerMachineId);

    const created = await services.prisma.note.create({
      data: {
        arrangementId,
        userId,
        type: 'TEXT',
        content: input.content,
        label: input.label,
        x: input.x,
        y: input.y,
        parentId: input.parentId,
        layers,
      },
    });
    // V0: standalone (no-edge) node creation has no SSE emitter yet —
    // emitNodeCreated requires an Edge.Model. Frontend picks this up on
    // next arrangement refetch.
    return venum('ok', created);
  }

  // Resolve layer membership for a new node: parent's layers if a parent
  // is given, else the caller machine's layers, else [] (global). Mirrors
  // dev's createChildNode inheritance + createNode active-layer stamping.
  // Both lookups are arrangement-scoped (security: can't read another
  // arrangement's note).
  private static async inheritLayers(
    arrangementId: string,
    parentId: string | undefined,
    callerMachineId: string,
  ): Promise<string[]> {
    if (parentId) {
      const parent = await services.prisma.note.findFirst({
        where: { id: parentId, arrangementId },
        select: { layers: true },
      });
      if (parent) return parent.layers;
    }
    const caller = await services.prisma.note.findFirst({
      where: { machineId: callerMachineId, arrangementId },
      select: { layers: true },
    });
    return caller?.layers ?? [];
  }

  // List historical snapshots for a node. Caller's arrangement gates
  // visibility — versions belong to a node, which belongs to an arrangement.
  static async listVersions(arrangementId: string, noteId: string) {
    const note = await services.prisma.note.findFirst({
      where: { id: noteId, arrangementId },
      select: { id: true },
    });
    if (!note) return venum('notFound', { message: `Node ${noteId} not found` });
    const versions = await services.prisma.noteVersion.findMany({
      where: { noteId },
      orderBy: { createdAt: 'desc' },
    });
    return venum('ok', versions);
  }

  // Switch the note's content to that of a stored snapshot. The current
  // content is snapped first (so the rollback is itself reversible) and
  // Note.version increments. Position/label aren't touched — versioning
  // is content-only for V1.
  static async rollback(
    machineId: string,
    userId: string,
    arrangementId: string,
    noteId: string,
    versionId: string,
  ) {
    const current = await services.prisma.note.findFirst({
      where: { id: noteId, arrangementId },
    });
    if (!current) return venum('notFound', { message: `Node ${noteId} not found` });

    const target = await services.prisma.noteVersion.findFirst({
      where: { id: versionId, noteId },
    });
    if (!target) return venum('notFound', { message: `Version ${versionId} not found for this node` });

    // Snap current state first, so the rollback is itself an entry in
    // history. Avoids the "I rolled back too far, can I un-rollback?" trap.
    if (current.content !== target.content) {
      await snapNoteVersion(noteId, current.content, `machine:${machineId}:rollback-from`);
    }

    const updated = await services.prisma.note.update({
      where: { id: noteId },
      data: {
        content: target.content,
        version: current.version + 1,
      },
    });
    emitNodeUpdated(userId, updated as any);
    return venum('ok', updated);
  }
}
