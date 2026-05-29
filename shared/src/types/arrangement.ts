import { z } from 'zod';
import { LLM } from './models';
import { Note } from './note';
import { Edge } from './edge';

export namespace Arrangement {
  // ============================================
  // CONFIG (per-arrangement preferences: actions, models, …)
  // ============================================
  // Single per-arrangement preferences container. Each section stores the
  // user's preferred order + visibility for a list-of-things they interact
  // with on this arrangement (currently actions and models).
  // - `visibleIds` is BOTH the visibility set and the order. Items not in
  //   the list are hidden; the list order drives what gets shown / hotkey-bound.
  // - A null section means "fall back to global default" (show all in the
  //   provider's natural order). A null Config means "no overrides at all".

  export interface Config {
    actions?: { visibleIds: string[] };
    models?: { visibleIds: string[] };
  }

  const ConfigSectionSchema = z.object({
    visibleIds: z.array(z.string()),
  });

  export const ConfigSchema = z.object({
    actions: ConfigSectionSchema.optional(),
    models: ConfigSectionSchema.optional(),
  });

  // Helpers on the Config container. Declared as a same-name namespace so
  // callers write `Arrangement.Config.withSection(...)` next to the type.
  export namespace Config {
    /**
     * Set/clear one section of a Config without mutating callers' input.
     * - `value = null` removes the section entirely.
     * - Returns null when the resulting Config has no sections — keeps the
     *   "no overrides" sentinel canonical (DB stores null, not `{}`).
     */
    export const withSection = <K extends keyof Config>(
      prev: Config | null,
      key: K,
      value: Config[K] | null,
    ): Config | null => {
      const next: Config = { ...(prev ?? {}) };
      if (value === null) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return Object.keys(next).length === 0 ? null : next;
    };
  }

  // ============================================
  // CORE MODEL
  // ============================================
  
  export interface Model {
    id: string;
    title: string;
    pinned: boolean;
    tags: string[];
    systemPrompt: string | null;
    config: Config | null;
    userId: string;
    notes?: any[]; // Avoid circular dependency - will be properly typed at usage
    edges?: any[]; // Avoid circular dependency - will be properly typed at usage
    createdAt: Date;
    lastVisitedAt: Date | null;
    updatedAt: Date;
    _count?: {
      notes: number;
    };
  }

  /**
   * Tag helpers — applies to both arrangements and (via Note.tags) notes.
   *
   * All three defensively read `tags ?? []` because Prisma-returned rows can
   * carry an undefined `tags` when the column is freshly added and an older
   * client hasn't refreshed — same defensive posture as Note.tags.
   */
  export const hasAllTags = (arr: Pick<Model, 'tags'>, tags: string[]): boolean => {
    const arrTags = arr.tags ?? [];
    return tags.every(t => arrTags.includes(t));
  };
  export const hasAnyTag = (arr: Pick<Model, 'tags'>, tags: string[]): boolean => {
    const arrTags = arr.tags ?? [];
    return tags.some(t => arrTags.includes(t));
  };
  export const collectAllTags = (arrangements: Pick<Model, 'tags'>[]): string[] =>
    Array.from(new Set(arrangements.flatMap(a => a.tags ?? []))).sort();

  // ============================================
  // DTOs (what frontend sends)
  // ============================================
  
  export namespace DTO {
    export const CreateSchema = z.object({
      title: z.string().trim().min(1).max(200),
      tags: z.array(z.string()).optional(),
    });

    export const UpdateSchema = z.object({
      title: z.string().trim().min(1).max(200).optional(),
      pinned: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
      systemPrompt: z.string().max(10000).nullable().optional(),
      config: ConfigSchema.nullable().optional(),
    });

    export const SyncSchema = z.object({
      nodes: z.array(z.any()), // React Flow nodes
      edges: z.array(z.any()), // React Flow edges
    });

    export const ExecuteActionSchema = z.object({
      actionId: z.string().min(1), // ID of the action to execute
      nodeId: z.string().min(1), // ID of the node to run action on
      model: z.enum(LLM.ModelIds as [string, ...string[]]).optional().default(LLM.DEFAULT_MODEL),
      childNodeOffset: z.object({
        x: z.number(),
        y: z.number()
      }).optional().default({ x: 0, y: 150 }),
      parentScale: z.number().min(0.1).max(10.0).optional(), // Parent scale for inheritance
      patchPayload: Note.DTO.PatchPayloadSchema.optional(), // Optional - only if dirty
    });

    export type Create = z.infer<typeof CreateSchema>;
    export type Update = z.infer<typeof UpdateSchema>;
    export type Sync = z.infer<typeof SyncSchema>;
    export type ExecuteAction = z.infer<typeof ExecuteActionSchema>;
  }

  // ============================================
  // RESPONSE TYPES
  // ============================================

  export namespace Response {
    /**
     * Generic node structure (compatible with React Flow nodes)
     */
    export interface FlowNode {
      id: string
      type?: string
      position: { x: number; y: number }
      data: Record<string, unknown>
      parentId?: string
      [key: string]: unknown
    }

    /**
     * Generic edge structure (compatible with React Flow edges)
     */
    export interface FlowEdge {
      id: string
      source: string
      target: string
      [key: string]: unknown
    }

    /**
     * Result from running an action — always a freshly created child node
     * (SINGLE_CHILD: one child filled by AI; MULTIPLE_CHILDREN: first child
     * filled, additional siblings stream in later via SSE).
     */
    export interface RunResult {
      responseNode: FlowNode
      responseEdge: FlowEdge
    }
  }

  // ============================================
  // MISSION CONTROL PROJECTION
  // --------------------------------------------
  // Join a daemon-metrics lookup into the machine notes of each arrangement.
  // Pure; the caller supplies the lookup so we don't couple shared types
  // to the daemon service.
  // ============================================

  export const withDaemonMetrics = <
    Arr extends { notes: Array<{ machineId?: string | null }> },
    M,
  >(
    arrangements: Arr[],
    metricsFor: (machineId: string) => M | null,
  ): Array<Arr & { notes: Array<Arr['notes'][number] & { metrics: M | null }> }> =>
    arrangements.map(arr => ({
      ...arr,
      notes: arr.notes.map(note => ({
        ...note,
        metrics: note.machineId ? metricsFor(note.machineId) : null,
      })),
    }));

  // ============================================
  // PATCH OPERATIONS
  // ============================================

  export namespace Patch {
    export type Response = {
      processed: { nodes: string[]; edges: string[] };
      failed: Array<{ id: string; reason: string }>;
    };

    // Outcome of a single try-op (create/update/delete). Mirrors the backend's
    // `Tried` shape without the `value` slot — Patch doesn't care about
    // return data, only success vs named reason.
    export type Outcome = { ok: true } | { ok: false; reason: string };

    export type Kind = 'nodes' | 'edges';

    export const newResponse = (): Response => ({ processed: { nodes: [], edges: [] }, failed: [] });

    export const isEmpty = (p: { dirtyNodes?: unknown[]; dirtyEdges?: unknown[]; deletedNodeIds?: string[]; deletedEdgeIds?: string[]; demotedNodeIds?: string[] }) =>
      !p.dirtyNodes?.length && !p.dirtyEdges?.length && !p.deletedNodeIds?.length && !p.deletedEdgeIds?.length && !p.demotedNodeIds?.length;

    // Record one outcome into the shared Response. Centralises the
    // "processed vs failed" ternary that used to repeat in every apply* step.
    export const record = (
      res: Response,
      kind: Kind,
      id: string,
      outcome: Outcome,
    ): void => {
      if (outcome.ok === true) {
        res.processed[kind].push(id);
        return;
      }
      res.failed.push({ id, reason: outcome.reason });
    };

    // Per-item collection: run `op` on each item in parallel, record each
    // outcome. `idOf` derives the id for the response slot — accepts both
    // string items (id === item) and object items ({ id, ...data }).
    export const collectPerItem = async <T>(
      items: T[],
      idOf: (item: T) => string,
      kind: Kind,
      res: Response,
      op: (item: T) => Promise<Outcome>,
    ): Promise<void> => {
      const outcomes = await Promise.all(
        items.map(async item => ({ id: idOf(item), outcome: await op(item) })),
      );
      outcomes.forEach(({ id, outcome }) => record(res, kind, id, outcome));
    };

    // Bulk collection: one operation covers many items (e.g. createMany).
    // All N ids get the same outcome.
    export const collectBulk = (
      ids: string[],
      kind: Kind,
      res: Response,
      outcome: Outcome,
    ): void => {
      ids.forEach(id => record(res, kind, id, outcome));
    };
  }

  // ============================================
  // EXPORT / IMPORT (portable JSON document format)
  // ============================================
  //
  // Design: a self-contained JSON document capturing the arrangement title,
  // its notes, and its edges — stripped of user-specific and runtime metadata
  // (user IDs, machine IDs, versions, DB timestamps). Import rewrites IDs so
  // documents can be re-imported into any account without conflicting.
  //
  // MACHINE / TERMINAL notes are intentionally excluded — machines are tied
  // to a specific daemon/host and don't round-trip through a JSON export.

  export namespace ExportDoc {
    export const VERSION = 1;

    /** Per-note fields that survive an export/import round-trip */
    export interface ExportedNote {
      id: string; // local id (will be remapped on import)
      type: Note.Type;
      content: string;
      label?: string | null;
      color?: string | null;
      tags: string[];
      layers: string[];
      pinned: boolean;
      isMergePoint: boolean;
      ancestorOverride: string[];
      scale: number;
      x: number;
      y: number;
      width?: number | null;
      height?: number | null;
      parentId?: string | null;
      style?: Note.Style; // Per-type rendering metadata (TEXT nodes' font config)
    }

    /** Per-edge fields that survive export/import */
    export interface ExportedEdge {
      id: string;
      sourceId: string;
      targetId: string;
      sourceHandleId?: string;
      targetHandleId?: string;
      type: string;
      label?: string;
    }

    /** Full portable document */
    export interface Document {
      version: number;
      exportedAt: string; // ISO timestamp
      title: string;
      notes: ExportedNote[];
      edges: ExportedEdge[];
    }

    const EXCLUDED_TYPES: Note.Type[] = ['MACHINE', 'TERMINAL'];

    /** Build a portable document from live arrangement + note + edge data. */
    export const toDocument = (
      title: string,
      notes: Note.Model[],
      edges: Edge.Model[]
    ): Document => {
      const exportableNotes = notes.filter(n => !EXCLUDED_TYPES.includes(n.type));
      const keepIds = new Set(exportableNotes.map(n => n.id));

      return {
        version: VERSION,
        exportedAt: new Date().toISOString(),
        title,
        notes: exportableNotes.map(n => ({
          id: n.id,
          type: n.type,
          content: n.content,
          label: n.label ?? null,
          color: n.color ?? null,
          tags: n.tags ?? [],
          layers: n.layers ?? [],
          pinned: n.pinned,
          isMergePoint: n.isMergePoint,
          ancestorOverride: n.ancestorOverride ?? [],
          scale: n.scale,
          x: n.x,
          y: n.y,
          width: n.width ?? null,
          height: n.height ?? null,
          parentId: n.parentId && keepIds.has(n.parentId) ? n.parentId : null,
          style: n.style ?? null, // TEXT-node font metadata survives the round-trip
        })),
        edges: edges
          .filter(e => keepIds.has(e.sourceId) && keepIds.has(e.targetId))
          .map(e => ({
            id: e.id,
            sourceId: e.sourceId,
            targetId: e.targetId,
            sourceHandleId: e.sourceHandleId,
            targetHandleId: e.targetHandleId,
            type: e.type,
            label: e.label,
          })),
      };
    };

    /** Zod schema — runtime validation of uploaded documents */
    export const DocumentSchema = z.object({
      version: z.number().int(),
      exportedAt: z.string().optional(),
      title: z.string().min(1).max(200),
      notes: z.array(z.object({
        id: z.string(),
        // TEXT is allowed; MACHINE/TERMINAL are not — they're filtered on export
        // because machines are tied to a specific daemon and don't round-trip.
        type: z.enum(['USER', 'ASSISTANT', 'SYSTEM', 'GROUP', 'TEXT']),
        content: z.string(),
        label: z.string().nullable().optional(),
        color: z.string().nullable().optional(),
        tags: z.array(z.string()).default([]),
        layers: z.array(z.string()).default([]),
        pinned: z.boolean().default(false),
        isMergePoint: z.boolean().default(false),
        ancestorOverride: z.array(z.string()).default([]),
        scale: z.number().default(1.0),
        x: z.number(),
        y: z.number(),
        width: z.number().nullable().optional(),
        height: z.number().nullable().optional(),
        parentId: z.string().nullable().optional(),
        style: z.record(z.string(), z.any()).nullable().optional(),
      })),
      edges: z.array(z.object({
        id: z.string(),
        sourceId: z.string(),
        targetId: z.string(),
        sourceHandleId: z.string().optional(),
        targetHandleId: z.string().optional(),
        type: z.string(),
        label: z.string().optional(),
      })),
    });

    export const validate = (data: unknown): Document => DocumentSchema.parse(data) as Document;

    /**
     * Remap IDs in an imported document so they're guaranteed unique.
     * Returns a new document where every note and edge has a freshly generated id,
     * and every parentId / sourceId / targetId references those new ids.
     */
    export const remapIds = (doc: Document, newId: () => string): Document => {
      const idMap = new Map<string, string>();
      for (const note of doc.notes) {
        idMap.set(note.id, newId());
      }
      return {
        ...doc,
        notes: doc.notes.map(n => ({
          ...n,
          id: idMap.get(n.id)!,
          parentId: n.parentId ? idMap.get(n.parentId) ?? null : null,
          ancestorOverride: n.ancestorOverride.map(id => idMap.get(id) ?? id),
        })),
        edges: doc.edges.map(e => ({
          ...e,
          id: newId(),
          sourceId: idMap.get(e.sourceId) ?? e.sourceId,
          targetId: idMap.get(e.targetId) ?? e.targetId,
        })),
      };
    };
  }

  // ============================================
  // VALIDATION & CREATION
  // ============================================

  export const validate = {
    create: (data: unknown): DTO.Create => DTO.CreateSchema.parse(data),
    update: (data: unknown): DTO.Update => DTO.UpdateSchema.parse(data),
    sync: (data: unknown): DTO.Sync => DTO.SyncSchema.parse(data),
    executeAction: (data: unknown): DTO.ExecuteAction => DTO.ExecuteActionSchema.parse(data),
  };

  export const create = (data: DTO.Create & { userId: string }): Omit<Model, 'id' | 'createdAt' | 'updatedAt'> => ({
    title: data.title,
    pinned: false,
    tags: data.tags ?? [],
    systemPrompt: null,
    config: null,
    userId: data.userId,
    lastVisitedAt: null,
  });

  // ============================================
  // DEFAULT WORKFLOW (seeded on account creation)
  // ============================================
  // Seeded into every new account (see the backend user-create hook) so the
  // canvas is never empty on first login. A small, self-explanatory research
  // pipeline that demonstrates the core loop: write a note → run an action →
  // connected children appear. Notes reference each other by `key`; the backend
  // maps keys to generated note ids when inserting. Positions assume
  // Canvas.NODE_DIMENSIONS (300×200), laid out top-to-bottom with two parallel
  // branches that merge into a synthesis note.

  export interface DefaultWorkflowNote {
    key: string;
    label: string;
    content: string;
    x: number;
    y: number;
    isMergePoint?: boolean;
  }

  export interface DefaultWorkflow {
    title: string;
    tags: string[];
    notes: DefaultWorkflowNote[];
    edges: { from: string; to: string }[];
  }

  export const DEFAULT_WORKFLOW: DefaultWorkflow = {
    title: 'Research workflow',
    tags: ['example'],
    notes: [
      {
        key: 'topic',
        label: '📚 Research topic',
        content:
          'Start here — replace this with the question or topic you want to research.\n\n' +
          'Then select this note and run an action from the toolbar: **Play** develops it further, **Split** breaks a list into separate notes. Results appear as connected child notes below.',
        x: 0,
        y: 0,
      },
      {
        key: 'subtopics',
        label: 'Subtopics',
        content:
          'List the angles or subtopics you want to explore, one per line, then run **Split** to fan each out into its own note you can research independently.',
        x: 0,
        y: 360,
      },
      {
        key: 'branchA',
        label: 'Subtopic A',
        content:
          'A branch for one subtopic. Drop sources, quotes, and findings here, then run **Play** to expand or refine them.',
        x: -260,
        y: 720,
      },
      {
        key: 'branchB',
        label: 'Subtopic B',
        content:
          'Another branch, researched independently. Both branches feed into the synthesis below.',
        x: 260,
        y: 720,
      },
      {
        key: 'synthesis',
        label: 'Synthesis',
        content:
          'This note has two parents — it is a merge point that pulls both branches together. Run **Summarize** to produce your final write-up.',
        x: 0,
        y: 1080,
        isMergePoint: true,
      },
    ],
    edges: [
      { from: 'topic', to: 'subtopics' },
      { from: 'subtopics', to: 'branchA' },
      { from: 'subtopics', to: 'branchB' },
      { from: 'branchA', to: 'synthesis' },
      { from: 'branchB', to: 'synthesis' },
    ],
  };

  // Map one DEFAULT_WORKFLOW note to its DB-create shape (a USER note; every
  // other column falls back to its schema default). Pairs with
  // Edge.childEdgeData for the edges — keeps the seeding service free of
  // inline object construction.
  export const toSeedNoteData = (
    note: DefaultWorkflowNote,
    arrangementId: string,
    userId: string,
  ) => ({
    arrangementId,
    userId,
    type: 'USER' as const,
    label: note.label,
    content: note.content,
    x: note.x,
    y: note.y,
    isMergePoint: note.isMergePoint ?? false,
  });
}
