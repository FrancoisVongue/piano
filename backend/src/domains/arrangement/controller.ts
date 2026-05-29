import { Prisma } from '@prisma/client';
import { venum } from 'venum';
import { services } from '../../services/init';
import { Note, Arrangement } from '@piano/shared';
import { daemonCommand } from '../../services/daemon.adapter';
import { NoteCacheController } from '../note-cache/controller';
import { MachineTemplateController } from '../machine-template/controller';
import * as db from './adapters/db';

export class ArrangementController {
  // ============================================
  // CRUD
  // ============================================

  static async create(
    input: { title: string; tags?: string[] },
    userId: string,
  ) {
    return venum('ok', await db.createArrangement({
      title: input.title, userId, tags: input.tags ?? [],
    }));
  }

  static async update(id: string, userId: string, updateData: Arrangement.DTO.Update) {
    const { config, ...rest } = updateData;
    const data: Prisma.ArrangementUpdateInput = { ...rest };

    if (config !== undefined) {
      data.config = config === null ? Prisma.DbNull : config;
    }

    return venum('ok', await db.updateArrangement(id, userId, data));
  }

  static delete = db.deleteArrangement;
  static findByUser = db.listForUser;

  static async findById(id: string, userId: string) {
    await db.touchLastVisited(id, userId);
    return db.findByIdWithGraph(id, userId);
  }

  static async findAllWithMachines(userId: string) {
    // Mission Control view: join in the latest cached daemon metrics per
    // machine note — purely in-memory, no extra round trip.
    const arrangements = await db.listWithMachineNotes(userId);
    return Arrangement.withDaemonMetrics(arrangements, (id) => services.daemon.getMetrics(id));
  }

  // ============================================
  // BULK MACHINE DELETE
  // ============================================

  // Deletes all MACHINE and TERMINAL notes in an arrangement.
  // Daemon first (one batch command, handles frozen/shared edge cases), DB
  // second — consistent with the single-note delete order so we never leave
  // daemon zombies.
  static async deleteAllMachines(arrangementId: string, userId: string) {
    const arr = await db.findOwnedBy(arrangementId, userId);
    if (!arr) return venum('notFound', { message: 'Arrangement not found' });

    const notes = await db.findMachineNotes(arrangementId);
    if (notes.length === 0) return venum('ok', { count: 0 });

    // Group machineIds by their owning daemon so we send one batch per
    // daemon. Notes without daemonId (legacy data) get DB-deleted but skip
    // the daemon RPC — there's nowhere to route the cleanup to.
    const byDaemon = new Map<string, { ownerId: string; machineIds: string[] }>();
    for (const n of notes) {
      if (!Note.isDaemonRoutable(n) || !n.daemon) continue;
      const entry = byDaemon.get(n.daemonId);
      if (entry) entry.machineIds.push(n.machineId);
      else byDaemon.set(n.daemonId, { ownerId: n.daemon.userId, machineIds: [n.machineId] });
    }
    for (const [daemonId, { ownerId, machineIds }] of byDaemon) {
      const r = await daemonCommand(
        { daemonOwnerId: ownerId, daemonId },
        { type: 'command:delete-batch', data: { machineIds } },
        'machines:deleted',
        { fallbackMsg: 'daemon delete-batch failed', timeoutMs: 30000 },
      );
      if (r.tag !== 'ok') return r;
    }

    await db.deleteNotesByIds(notes.map(n => n.id));
    return venum('ok', { count: notes.length });
  }

  // ============================================
  // PATCH (optimistic sync)
  // ============================================

  static async patch(arrangementId: string, userId: string, payload: Note.DTO.PatchPayload) {
    const arr = await db.findOwnedBy(arrangementId, userId);
    if (!arr) return venum('notFound', { message: 'Arrangement not found' });

    const res = Arrangement.Patch.newResponse();
    if (Arrangement.Patch.isEmpty(payload)) return venum('ok', res);

    // Order matters: demotions + deletions before upserts (so newly-orphaned
    // edges aren't re-created), daemon-aware node deletes first (so DB never
    // outlives the daemon state). Demotions run before deletions so a node
    // demoted in the same patch can't be accidentally daemon-killed by the
    // delete step on its way out.
    await this.applyNodeDemotions(res, payload, arrangementId);
    await this.applyNodeDeletions(res, payload, arrangementId, userId);
    await this.applyEdgeDeletions(res, payload, arrangementId);
    await this.applyDirtyNodes(res, payload, arrangementId, userId);
    await this.applyDirtyEdges(res, payload, arrangementId);

    return venum('ok', res);
  }

  // Demotion is a structural move: a TERMINAL canvas note is being
  // embedded into a machine-window pane. Same daemon session, different
  // UI surface — we drop the Note row but MUST NOT call command:delete
  // on the daemon, otherwise we'd kill the PTY the window is about to
  // reuse. Pure DB delete; no daemon RPC.
  private static applyNodeDemotions(
    res: Arrangement.Patch.Response,
    payload: Note.DTO.PatchPayload,
    arrangementId: string,
  ) {
    return Arrangement.Patch.collectPerItem(
      payload.demotedNodeIds ?? [],
      (id) => id,
      'nodes',
      res,
      (id) => db.deleteNoteIdempotent(id, arrangementId),
    );
  }

  private static applyNodeDeletions(
    res: Arrangement.Patch.Response,
    payload: Note.DTO.PatchPayload,
    arrangementId: string,
    userId: string,
  ) {
    return Arrangement.Patch.collectPerItem(
      payload.deletedNodeIds ?? [],
      (id) => id,
      'nodes',
      res,
      (id) => this.deleteNoteWithDaemon(id, arrangementId, userId),
    );
  }

  private static applyEdgeDeletions(
    res: Arrangement.Patch.Response,
    payload: Note.DTO.PatchPayload,
    arrangementId: string,
  ) {
    return Arrangement.Patch.collectPerItem(
      payload.deletedEdgeIds ?? [],
      (id) => id,
      'edges',
      res,
      (id) => db.deleteEdgeIdempotent(id, arrangementId),
    );
  }

  private static async applyDirtyNodes(
    res: Arrangement.Patch.Response,
    payload: Note.DTO.PatchPayload,
    arrangementId: string,
    userId: string,
  ) {
    // TODO(multi-user): the patch payload's `daemonId` and `provisioning.fromMachineId`
    // are not verified against requester ownership — today user === owner so
    // there's no cross-tenant case to defend against. When membership-based
    // access lands, gate both against `daemon.userId === userId` and a
    // parent-machine ownership probe before the create/update.
    const existing = await db.existingNoteIds(payload.dirtyNodes.map(n => n.id), arrangementId);
    const { toCreate, toUpdate } = Note.Patch.categorize(payload.dirtyNodes, existing, arrangementId, userId);

    if (toCreate.length) {
      const createResult = await db.tryCreateManyNotes(toCreate);
      Arrangement.Patch.collectBulk(
        toCreate.map(n => n.id),
        'nodes',
        res,
        createResult,
      );

      // Daemon-side side effect of a new MACHINE/TERMINAL note: kick off
      // provisioning fire-and-forget, then RUNNING/FROZEN flip via SSE.
      // Same shape as deleteNoteWithDaemon's daemon RPC (mirror of the
      // delete side-effect). Filtered to newly-created rows only — updates
      // never re-trigger provisioning.
      if (createResult.ok) {
        const createdIds = new Set(toCreate.map(n => n.id));
        const provisioningNodes = payload.dirtyNodes.filter(
          n => createdIds.has(n.id)
            && n.status === 'PROVISIONING'
            && n.provisioning
            && n.machineId
            && n.daemonId,
        );
        for (const node of provisioningNodes) {
          void MachineTemplateController.provisionFromPatch({
            userId,
            noteId: node.id,
            machineId: node.machineId!,
            daemonId: node.daemonId!,
            intent: node.provisioning!,
            label: node.label ?? null,
          });
        }
      }
    }

    await Arrangement.Patch.collectPerItem(
      toUpdate,
      (u) => u.id,
      'nodes',
      res,
      // Cast at the prisma boundary: PatchEntity types `windowLayout`/`style`
      // as `unknown`/permissive (parse-don't-validate at ingress) but Prisma
      // wants `JsonValue`. PatchEntitySchema already validated, so safe.
      ({ id, data }) => db.tryUpdateNote(id, data as Parameters<typeof db.tryUpdateNote>[1]),
    );

    // Cache invalidation: if any updated note changed its content, any cache
    // handle anchored on that note now references stale bytes. Fire-and-forget
    // — failure to invalidate shouldn't fail the patch.
    await Promise.all(
      toUpdate
        .filter(({ data }) => 'content' in data)
        .map(({ id }) => NoteCacheController.invalidateAllHandles(userId, id).catch(() => undefined)),
    );
  }

  private static applyDirtyEdges(
    res: Arrangement.Patch.Response,
    payload: Note.DTO.PatchPayload,
    arrangementId: string,
  ) {
    return Arrangement.Patch.collectPerItem(
      payload.dirtyEdges ?? [],
      (dirty) => dirty.id,
      'edges',
      res,
      (dirty) => db.tryUpsertEdge(dirty, arrangementId),
    );
  }

  // Delete one note. If it represents a daemon machine/terminal, ask the
  // daemon to clean up FIRST and only commit the DB delete on success —
  // daemon zombies are more expensive than stale DB rows.
  private static async deleteNoteWithDaemon(
    id: string,
    arrangementId: string,
    userId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const note = await db.findNoteKind(id, arrangementId);
    if (!note) return { ok: true }; // already gone, idempotent

    // Skip the daemon RPC for notes without daemonId (legacy data) — DB
    // delete is the authoritative cleanup; daemon-side files become orphans.
    if (Note.isDaemonRoutable(note) && note.daemon) {
      const r = await daemonCommand(
        { daemonOwnerId: note.daemon.userId, daemonId: note.daemonId },
        { type: 'command:delete', machineId: note.machineId },
        'machine:deleted',
        { fallbackMsg: 'daemon delete failed', timeoutMs: 5000 },
      );
      if (r.tag !== 'ok') return { ok: false, reason: `daemon delete failed: ${r.data.message}` };
    }

    return db.deleteNoteIdempotent(id, arrangementId);
  }
}
