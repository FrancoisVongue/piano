/**
 * Import one arrangement JSON (from arrangement-split/) into the local DB.
 *
 *   bun backend/scripts/import-arrangement.ts <path-to-arrangement.json> [targetUserId]
 *
 * If targetUserId is omitted, falls back to the single User row in the DB.
 * Re-assigns Arrangement.userId and Note.userId to the target user.
 * Bails out if an arrangement/note/edge with the same id already exists.
 */

import { readFileSync } from 'node:fs';
import { PrismaClient, NoteType, Status } from '@prisma/client';

type ExportedNote = {
  id: string;
  type: string;
  status: string | null;
  content: string;
  label: string | null;
  color: string | null;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  scale: number;
  pinned: boolean;
  tags: string[];
  version: number;
  parentId: string | null;
  isMergePoint: boolean;
  ancestorOverride: string[];
  assistantProvider: string | null;
  arrangementId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
};

type ExportedEdge = {
  id: string;
  arrangementId: string;
  sourceId: string;
  targetId: string;
  sourceHandleId: string;
  targetHandleId: string;
  type: string;
  label: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type ExportedArrangement = {
  id: string;
  title: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  notes: ExportedNote[];
  edges: ExportedEdge[];
};

const toNoteType = (t: string): NoteType => {
  if (t in NoteType) return NoteType[t as keyof typeof NoteType];
  throw new Error(`Unknown NoteType in export: ${t}`);
};

const toStatus = (s: string | null): Status | null => {
  if (s === null) return null;
  if (s in Status) return Status[s as keyof typeof Status];
  throw new Error(`Unknown Status in export: ${s}`);
};

const resolveTargetUserId = async (
  prisma: PrismaClient,
  explicit: string | undefined,
): Promise<string> => {
  if (explicit) {
    const exists = await prisma.user.findUnique({ where: { id: explicit } });
    if (!exists) throw new Error(`Target user ${explicit} not found`);
    return explicit;
  }
  const users = await prisma.user.findMany({ select: { id: true } });
  if (users.length !== 1) {
    throw new Error(
      `Expected exactly 1 user in DB (so we can auto-pick the target); found ${users.length}. Pass targetUserId explicitly.`,
    );
  }
  return users[0]!.id;
};

const importArrangement = async (
  prisma: PrismaClient,
  a: ExportedArrangement,
  targetUserId: string,
) => {
  const existing = await prisma.arrangement.findUnique({ where: { id: a.id } });
  if (existing) throw new Error(`Arrangement ${a.id} already exists — aborting`);

  await prisma.$transaction(async (tx) => {
    await tx.arrangement.create({
      data: {
        id: a.id,
        title: a.title,
        pinned: a.pinned,
        userId: targetUserId,
        createdAt: new Date(a.createdAt),
        updatedAt: new Date(a.updatedAt),
      },
    });

    // Pass 1: create notes without parentId to sidestep ordering
    await tx.note.createMany({
      data: a.notes.map((n) => ({
        id: n.id,
        type: toNoteType(n.type),
        status: toStatus(n.status),
        content: n.content,
        label: n.label,
        color: n.color,
        tags: n.tags ?? [],
        pinned: n.pinned,
        isMergePoint: n.isMergePoint,
        ancestorOverride: n.ancestorOverride ?? [],
        parentId: null,
        scale: n.scale,
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
        version: n.version,
        assistantProvider: n.assistantProvider,
        arrangementId: a.id,
        userId: targetUserId,
        createdAt: new Date(n.createdAt),
        updatedAt: new Date(n.updatedAt),
      })),
    });

    // Pass 2: fill parentId where it was set
    for (const n of a.notes) {
      if (!n.parentId) continue;
      await tx.note.update({
        where: { id: n.id },
        data: { parentId: n.parentId },
      });
    }

    await tx.edge.createMany({
      data: a.edges.map((e) => ({
        id: e.id,
        type: e.type,
        label: e.label,
        sourceHandleId: e.sourceHandleId,
        targetHandleId: e.targetHandleId,
        version: e.version,
        sourceId: e.sourceId,
        targetId: e.targetId,
        arrangementId: a.id,
        createdAt: new Date(e.createdAt),
        updatedAt: new Date(e.updatedAt),
      })),
    });
  });
};

const main = async () => {
  const [, , filePath, targetUserIdArg] = process.argv;
  if (!filePath) {
    console.error('Usage: bun backend/scripts/import-arrangement.ts <path> [targetUserId]');
    process.exit(1);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const arrangement = JSON.parse(raw) as ExportedArrangement;

  const prisma = new PrismaClient();
  try {
    const targetUserId = await resolveTargetUserId(prisma, targetUserIdArg);
    console.log(
      `Importing "${arrangement.title}" (${arrangement.id}) — ${arrangement.notes.length} notes, ${arrangement.edges.length} edges → user ${targetUserId}`,
    );
    await importArrangement(prisma, arrangement, targetUserId);
    console.log('Done.');
  } finally {
    await prisma.$disconnect();
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
