import { Prisma } from '@prisma/client';
import { services } from '../../../services/init';
import { Note, Edge } from '@piano/shared';
import { idempotentDelete, tryDb, Tried } from '../../../services/prisma.adapter';

// -----------------------------------------------------------------------------
// Arrangement DB adapter.
//
// Every arrangement-domain prisma call lives here. The controller reads
// business intent ("find this arrangement, create one"); all "how we talk
// to Postgres" detail is encapsulated below.
//
// Naming: functions read as the question the controller is asking
// ("findOwnedBy", "listForUser").
// -----------------------------------------------------------------------------

// ----- ARRANGEMENT -----

export const findOwnedBy = (id: string, userId: string) =>
  services.prisma.arrangement.findFirst({ where: { id, userId } });

export const createArrangement = (data: {
  title: string;
  userId: string;
  tags: string[];
}) => services.prisma.arrangement.create({ data });

export const updateArrangement = (id: string, userId: string, data: Prisma.ArrangementUpdateInput) =>
  services.prisma.arrangement.update({ where: { id, userId }, data });

export const deleteArrangement = (id: string) =>
  services.prisma.arrangement.delete({ where: { id } });

export const findByIdWithGraph = (id: string, userId: string) =>
  services.prisma.arrangement.findFirst({
    where: { id, userId },
    include: { notes: true, edges: true },
  });

export const touchLastVisited = (id: string, userId: string) =>
  services.prisma.$executeRaw`
    UPDATE "Arrangement"
    SET "lastVisitedAt" = NOW()
    WHERE "id" = ${id} AND "userId" = ${userId}
  `;

export const listForUser = (userId: string) =>
  services.prisma.arrangement.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { notes: true } } },
  });

export const listWithMachineNotes = (userId: string) =>
  services.prisma.arrangement.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    include: {
      notes: {
        where: { type: { in: ['MACHINE', 'TERMINAL'] } },
        select: {
          id: true, type: true, machineId: true, status: true,
          label: true, parentMachineNodeId: true,
        },
      },
    },
  });

// ----- NOTES -----

export const findMachineNotes = (arrangementId: string) =>
  services.prisma.note.findMany({
    where: { arrangementId, type: { in: ['MACHINE', 'TERMINAL'] } },
    select: {
      id: true,
      type: true,
      machineId: true,
      daemonId: true,
      daemon: { select: { userId: true } },
    },
  });

export const findNoteKind = (id: string, arrangementId: string) =>
  services.prisma.note.findFirst({
    where: { id, arrangementId },
    select: {
      type: true,
      machineId: true,
      daemonId: true,
      daemon: { select: { userId: true } },
    },
  });

export const findNoteById = (id: string) =>
  services.prisma.note.findUnique({ where: { id } });

export const existingNoteIds = async (ids: string[], arrangementId: string): Promise<Set<string>> => {
  if (ids.length === 0) return new Set();
  const rows = await services.prisma.note.findMany({
    where: { id: { in: ids }, arrangementId },
    select: { id: true },
  });
  return new Set(rows.map(r => r.id));
};

export const createManyNotes = (data: Note.Patch.CreateData[]) =>
  services.prisma.note.createMany({ data, skipDuplicates: true });

export const updateNote = (id: string, data: Prisma.NoteUpdateInput) =>
  services.prisma.note.update({ where: { id }, data });

// Tag a note with an explicit ancestor chain. Used by Cartesian fan-out
// when the first path's child needs to remember "this is path #0".
export const setAncestorOverride = (id: string, ancestorIds: string[]) =>
  services.prisma.note.update({
    where: { id },
    data: { ancestorOverride: ancestorIds },
  });

export const deleteNotesByIds = (ids: string[]) =>
  services.prisma.note.deleteMany({ where: { id: { in: ids } } });

export const deleteNoteIdempotent = (id: string, arrangementId: string) =>
  idempotentDelete(() => services.prisma.note.deleteMany({ where: { id, arrangementId } }));

// ----- EDGES -----

export const findEdge = (id: string, arrangementId: string) =>
  services.prisma.edge.findUnique({ where: { id, arrangementId } });

export const findIncomingEdge = (targetId: string, arrangementId: string) =>
  services.prisma.edge.findFirst({ where: { targetId, arrangementId } });

export const createEdge = (data: Prisma.EdgeCreateInput) =>
  services.prisma.edge.create({ data });

export const updateEdge = (id: string, data: Prisma.EdgeUpdateInput) =>
  services.prisma.edge.update({ where: { id }, data });

// deleteMany (not delete) on purpose: cascade from a node delete often
// wipes the edge before the patch loop reaches it. deleteMany returns
// { count: 0 } silently; delete would throw P2025 and force Prisma's
// query engine to log noisy stderr before our idempotentDelete catches it.
export const deleteEdgeIdempotent = (id: string, arrangementId: string) =>
  idempotentDelete(() => services.prisma.edge.deleteMany({ where: { id, arrangementId } }));

// -----------------------------------------------------------------------------
// "Try" variants. Controllers call these instead of wrapping prisma in try/catch.
// Each returns a Tried<T>; controllers just branch on `.ok`.
// -----------------------------------------------------------------------------

export const tryCreateManyNotes = (data: Note.Patch.CreateData[]) =>
  tryDb(() => services.prisma.note.createMany({ data, skipDuplicates: true }));

export const tryUpdateNote = (id: string, data: Prisma.NoteUpdateInput) =>
  tryDb(() => services.prisma.note.update({ where: { id }, data }));

// Compound "upsert one edge" step: existence probe → (create | update) with
// validation on the create path. Validation is a pure check — it returns a
// Tried directly, no throws. Only the prisma writes are wrapped in tryDb.
export const tryUpsertEdge = async (
  dirty: Note.DTO.PatchPayload['dirtyEdges'][number],
  arrangementId: string,
): Promise<Tried> => {
  const existing = await services.prisma.edge.findUnique({ where: { id: dirty.id, arrangementId } });

  if (existing) {
    const data = Edge.Patch.toUpdateData(dirty);
    if (!Object.keys(data).length) return { ok: true, value: undefined };
    return tryDb(() => services.prisma.edge.update({ where: { id: dirty.id }, data }))
      .then(r => r.ok ? { ok: true, value: undefined } : r);
  }

  const [target, hasParent] = await Promise.all([
    services.prisma.note.findUnique({ where: { id: dirty.target! } }),
    services.prisma.edge.findFirst({ where: { targetId: dirty.target!, arrangementId } }),
  ]);
  const v = Edge.Patch.canCreate({
    targetExists: !!target,
    isMergePoint: target?.isMergePoint ?? false,
    hasParent: !!hasParent,
  });
  if (!v.valid) return { ok: false, reason: v.reason };

  return tryDb(() => services.prisma.edge.create({
    data: Edge.Patch.toCreateData(
      { ...dirty, source: dirty.source!, target: dirty.target! },
      arrangementId,
    ) as any,
  })).then(r => r.ok ? { ok: true, value: undefined } : r);
};
