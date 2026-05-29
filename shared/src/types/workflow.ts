import { z } from 'zod';

// -----------------------------------------------------------------------------
// Workflow — declarative table-style automation.
//
// A workflow is an ordered list of "levels" forming a dependency graph. Each
// level is a coordinate with a single semantic meaning:
//
//   - `contexts`  — an array of static texts that get planted as USER nodes
//                   on the canvas under each parent in the input frontier.
//   - `actionId`  — the single Action that runs over each newly-planted USER
//                   node. The Action's existing pipeline (prompt building,
//                   cache, system prompts, MULTIPLE_CHILDREN, retry) is
//                   reused as-is — workflow has no AI logic of its own.
//
// Per level: cells = parents × contexts. Under each parent we plant
// `contexts.length` USER nodes; under each USER we run `actionId` once. The
// resulting ASSISTANT children are the level's frontier.
//
// Two-array fan-out (parents × contexts) gives variation of inputs.
// "Different transformation" is expressed as a separate level with the same
// `inputLevelId` — naming a level IS the API.
//
// Levels are stored as one JSON document because the shape evolves and is
// always read/written as a whole.
// -----------------------------------------------------------------------------

export namespace Workflow {
  // ============================================
  // CORE TYPES
  // ============================================

  export interface Level {
    /** Stable id within this workflow — used by inputLevelId. */
    id: string;
    name: string;
    /**
     * Which level's output feeds this one. null = "use the target node the
     * user clicked Run on". Empty string is treated like null (defensive).
     */
    inputLevelId: string | null;
    /** ≥1 — texts of USER nodes to plant under each parent. */
    contexts: string[];
    /** Exactly one Action per level — its outputStyle decides fan-out. */
    actionId: string;
  }

  export interface Model {
    id: string;
    name: string;
    levels: Level[];
    userId: string;
    createdAt: Date;
    updatedAt: Date;
  }

  // ============================================
  // ZOD SCHEMAS
  // ============================================

  export const LevelSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(100),
    inputLevelId: z.string().nullable(),
    contexts: z.array(z.string().min(1).max(20000)).min(1),
    actionId: z.string().min(1),
  });

  export namespace DTO {
    export const CreateSchema = z.object({
      name: z.string().min(1).max(120),
      levels: z.array(LevelSchema).min(1),
    });

    export const UpdateSchema = z.object({
      name: z.string().min(1).max(120).optional(),
      levels: z.array(LevelSchema).min(1).optional(),
    });

    export const RunSchema = z.object({
      targetNoteId: z.string().min(1),
      model: z.string().min(1),
    });

    export type Create = z.infer<typeof CreateSchema>;
    export type Update = z.infer<typeof UpdateSchema>;
    export type Run = z.infer<typeof RunSchema>;
  }

  export namespace validate {
    export const create = (data: unknown): DTO.Create => DTO.CreateSchema.parse(data);
    export const update = (data: unknown): DTO.Update => DTO.UpdateSchema.parse(data);
    export const run = (data: unknown): DTO.Run => DTO.RunSchema.parse(data);
  }

  // ============================================
  // PURE HELPERS
  // ============================================

  /**
   * Topologically sort levels so each level appears after the one feeding
   * it. Levels in a saved workflow are usually already in this order, but
   * the executor must never depend on that. Cycles (impossible by
   * construction at save time) degrade to skipping the back-edge — the
   * cycle level just becomes a no-op rather than throwing.
   */
  export const topoSort = (levels: Level[]): Level[] => {
    const byId = new Map(levels.map(l => [l.id, l]));
    const visited = new Set<string>();
    const out: Level[] = [];
    const visit = (l: Level) => {
      if (visited.has(l.id)) return;
      visited.add(l.id);
      const parent = l.inputLevelId ? byId.get(l.inputLevelId) : null;
      if (parent) visit(parent);
      out.push(l);
    };
    for (const l of levels) visit(l);
    return out;
  };

  // ============================================
  // RUNTIME JOB SHAPES (NATS / Temporal payloads)
  // ============================================

  export namespace Job {
    /** Top-level "user clicked Run on a node" payload. */
    export type Run = {
      workflowId: string;
      runId: string;
      targetNoteId: string;
      arrangementId: string;
      userId: string;
      model: string;
    };
  }
}
