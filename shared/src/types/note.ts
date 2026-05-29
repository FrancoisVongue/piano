import { z } from 'zod';
import { Node as RfNode } from '@xyflow/react';
import { Canvas } from './canvas';
import { Edge } from './edge';
import { pickDefined } from '../utils/object';
import { Mention } from './mention';
import { MachineWindow } from './machine-window';

export namespace Note {
  // ============================================
  // CORE TYPES
  // ============================================
  
  // ZONE: a resizable rectangle used to group/organize the canvas (sits behind
  //   other nodes). DRAWING: a freehand stroke or straight line annotation.
  //   Both are first-class canvas annotations, persisted like any other note.
  export type Type = 'USER' | 'ASSISTANT' | 'SYSTEM' | 'GROUP' | 'MACHINE' | 'TERMINAL' | 'TEXT' | 'ZONE' | 'DRAWING';

  // ============================================
  // PER-TYPE RENDERING STYLE (structured, opaque to backend)
  // ============================================

  /**
   * TEXT nodes: font configuration for the standalone-text renderer.
   * Everything optional so callers can partially update without losing other fields.
   */
  export interface TextStyle {
    fontSize?: number // px
    fontWeight?: number // 400 / 700 / etc.
    fontFamily?: 'sans' | 'serif' | 'mono' | 'system'
  }

  /**
   * DRAWING nodes: the stroke geometry. `points` are in node-local coordinates
   * (relative to the node's top-left = its bounding box), so the path renders
   * the same wherever the node is moved. `freehand` → smoothed pen stroke;
   * `line` → a straight segment (exactly two points).
   */
  export interface DrawingStyle {
    tool: 'freehand' | 'line'
    points: Array<[number, number]>
    strokeWidth?: number
  }

  /**
   * Discriminated union keyed by note type. Add variants as new node types appear.
   * Kept intentionally loose (`any`) so Prisma's JsonValue-typed `note.style`
   * column assigns cleanly without casts in every controller.
   */
  export type Style = TextStyle | Record<string, any> | null | undefined | any
  // Match Prisma enum (keep all values for backward compatibility) + frontend-only states.
  // PROVISIONING: persisted state for a MACHINE/TERMINAL note whose daemon-side
  // resource is still being created. Transitions to RUNNING on success or
  // FROZEN on failure (orphan — user can delete). Same shape as
  // EXPECTING_AI_RESPONCE for AI nodes: "the row exists, the underlying
  // object is still on the way".
  export type Status = 'PROVISIONING' | 'EXPECTING_AI_RESPONCE' | 'FRESH_RESPONCE' | 'RUNNING' | 'FROZEN' | 'idle' | 'running' | 'completed' | 'error' | 'saving' | 'creating';

  export interface Model {
    id: string;
    arrangementId: string;
    userId: string;
    type: Type;
    status?: Status | null;
    content: string;
    label?: string | null;
    color?: string | null;
    tags: string[]; // Tags for categorization and filtering
    /**
     * Layer membership. `[]` is the canonical "global" shape — the note shows
     * up no matter which layer is active. A non-empty list opts the note into
     * specific layers; the canvas only renders it while at least one of those
     * layers is in the user's visible set. Layers are free-form strings, like
     * tags, but live in their own field because they're a first-class canvas
     * concept (active/visible state, layer-aware spawning) — not metadata.
     */
    layers: string[];
    pinned: boolean; // Pin important nodes
    isMergePoint: boolean; // Allow multiple parent edges (DAG support)
    ancestorOverride: string[]; // Explicit ancestor IDs to use instead of edge traversal
    scale: number; // Visual scale of the note (0.1 to 10.0)
    x: number;
    y: number;
    width?: number | null; // For resizable group nodes
    height?: number | null; // For resizable group nodes
    style?: Style; // Per-type rendering metadata (see TextStyle for TEXT nodes)
    assistantProvider?: string | null;
    parentId?: string | null;
    machineId?: string | null;
    parentMachineNodeId?: string | null;
    // Which paired daemon owns the machine (only meaningful when machineId
    // is set). Null for legacy machines and dev — DaemonService falls back
    // to the user's single legacy WS in that case.
    daemonId?: string | null;
    version: number; // For optimistic sync and LWW conflict resolution
    // Per-model cache anchors. Typed as `unknown` deliberately: Prisma's
    // Json column yields a wider type than our schema (primitives + arrays
    // would pass at the type level). Never read this field directly — go
    // through Note.CacheConfig morphisms (`get`, `isActiveFor`, `liveRuntime`)
    // which take `unknown` and narrow at one place. This is the parse
    // boundary; downstream sees the tight `Config` type or nothing.
    cacheConfig?: unknown;
    // For MACHINE nodes: in-window layout state (tabs, splits, drawer).
    // Same parse-boundary discipline as cacheConfig — `unknown` here,
    // narrowed through MachineWindow.validate.layout when read.
    windowLayout?: unknown;
    createdAt: Date;
    updatedAt: Date;
  }

  // ============================================
  // DTOs (what frontend sends)
  // ============================================
  
  export namespace DTO {
    export const TypeSchema = z.enum(['USER', 'ASSISTANT', 'SYSTEM', 'GROUP', 'MACHINE', 'TERMINAL', 'TEXT', 'ZONE', 'DRAWING']);

    /**
     * Structured style for TEXT nodes — validated at the boundary so the server
     * can trust it before writing to the JSONB column.
     */
    export const TextStyleSchema = z.object({
      fontSize: z.number().positive().max(1000).optional(),
      fontWeight: z.number().int().min(100).max(900).optional(),
      fontFamily: z.enum(['sans', 'serif', 'mono', 'system']).optional(),
    });

    // Accept any JSON object for now; discriminate by note.type in callers.
    export const StyleSchema = z.record(z.string(), z.any()).nullable().optional();

    // How a freshly-created MACHINE/TERMINAL note should be materialised on
    // its daemon. Discriminated by `kind` — each variant carries exactly the
    // ID the corresponding daemon command needs. The patch handler reads
    // this once at create-time and never persists it.
    //
    // `template` covers blank machines too — templateId === '' means "no
    // template, create empty". `branch`/`share` will be added when the
    // canvas store starts using them for those flows.
    export const ProvisioningIntentSchema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('template'), templateId: z.string() }),
      z.object({ kind: z.literal('branch'),   fromMachineId: z.string().min(1) }),
      z.object({ kind: z.literal('share'),    fromMachineId: z.string().min(1) }),
    ]);
    export type ProvisioningIntent = z.infer<typeof ProvisioningIntentSchema>;

    export const CreateSchema = z.object({
      type: TypeSchema,
      content: z.string().default(''),
      label: z.string().optional(),
      color: z.string().optional(),
      tags: z.array(z.string()).default([]),
      layers: z.array(z.string()).default([]),
      pinned: z.boolean().default(false),
      isMergePoint: z.boolean().default(false),
      ancestorOverride: z.array(z.string()).default([]),
      scale: z.number().min(0.1).max(10.0).default(1.0),
      x: z.number().default(100),
      y: z.number().default(100),
      parentId: z.string().optional(),
      machineId: z.string().optional(),
      parentMachineNodeId: z.string().optional(),
      daemonId: z.string().nullable().optional(),
    });

    export const UpdateSchema = z.object({
      content: z.string().max(10000).optional(),
      label: z.string().optional(),
      color: z.string().optional(),
      tags: z.array(z.string()).optional(),
      layers: z.array(z.string()).optional(),
      pinned: z.boolean().optional(),
      isMergePoint: z.boolean().optional(),
      ancestorOverride: z.array(z.string()).optional(),
      scale: z.number().min(0.1).max(10.0).optional(),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      parentId: z.string().nullable().optional(),
    });

    export const SyncSchema = z.object({
      nodes: z.array(z.any()), // Will be properly typed with RfNode when imported
      edges: z.array(z.any()), // Will be properly typed with RfEdge when imported
    });

    // NEW: Patch DTOs for optimistic sync (Chapter 2: structural changes only)
    export const PatchEntitySchema = z.object({
      id: z.string().min(1),
      // Structural fields (LWW - full state sent)
      type: TypeSchema.optional(), // Node type (USER, ASSISTANT, SYSTEM, GROUP)
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      width: z.number().finite().nullable().optional(), // For group nodes (resizable)
      height: z.number().finite().nullable().optional(), // For group nodes (resizable)
      label: z.string().nullable().optional(),
      color: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
      layers: z.array(z.string()).optional(),
      pinned: z.boolean().optional(),
      isMergePoint: z.boolean().optional(), // Allow multiple parent edges (DAG support)
      ancestorOverride: z.array(z.string()).optional(), // Explicit ancestor IDs to use instead of edge traversal
      scale: z.number().min(0.1).max(10.0).optional(), // Visual scale of the note
      parentId: z.string().nullable().optional(), // Parent node for React Flow groups
      parentMachineNodeId: z.string().nullable().optional(),
      machineId: z.string().nullable().optional(), // Daemon machine ID (MACHINE/TERMINAL nodes)
      daemonId: z.string().nullable().optional(),
      status: z.enum(['PROVISIONING', 'EXPECTING_AI_RESPONCE', 'FRESH_RESPONCE', 'RUNNING', 'FROZEN']).nullable().optional(),
      // Content (full state for Chapter 2, will add diffs in Chapter 3)
      content: z.string().optional(),
      // Per-type rendering metadata (TEXT nodes use TextStyle)
      style: StyleSchema,
      // For MACHINE nodes: in-window tabs+splits+drawer layout state.
      // Validated against MachineWindow.LayoutSchema; `null` clears it.
      windowLayout: MachineWindow.LayoutSchema.nullable().optional(),
      // Expected version for LWW validation
      expectedVersion: z.number().int().optional(),
      // Transient: tells the patch handler "after you've written this Note,
      // kick off the daemon-side provisioning that backs it". Not persisted —
      // it's an instruction to the controller, not state. When the daemon
      // command resolves, the controller flips status PROVISIONING → RUNNING
      // (or FROZEN on failure) and emits an SSE update. The frontend keeps
      // the terminal closed until status === 'RUNNING'.
      provisioning: ProvisioningIntentSchema.optional(),
    });

    export const PatchEdgeSchema = z.object({
      id: z.string().min(1),
      source: z.string().min(1).optional(),
      target: z.string().min(1).optional(),
      sourceHandle: z.string().nullable().optional(),
      targetHandle: z.string().nullable().optional(),
      type: z.string().optional(),
      label: z.string().optional(),
      expectedVersion: z.number().int().optional(),
    });

    export const PatchPayloadSchema = z.object({
      dirtyNodes: z.array(PatchEntitySchema).optional().default([]),
      dirtyEdges: z.array(PatchEdgeSchema).optional().default([]),
      deletedNodeIds: z.array(z.string()).optional().default([]),
      deletedEdgeIds: z.array(z.string()).optional().default([]),
      // Notes whose canvas presence is being moved into a machine window
      // pane (same daemon session, different UI surface). Backend deletes
      // the Note row but MUST NOT fire daemon `command:delete` — the pane
      // it's about to embed depends on that session staying alive. Empty
      // by default; populated only by the demoteTerminal flow.
      demotedNodeIds: z.array(z.string()).optional().default([]),
    });

    export type Type = z.infer<typeof TypeSchema>;
    export type Create = z.infer<typeof CreateSchema>;
    export type Update = z.infer<typeof UpdateSchema>;
    export type Sync = z.infer<typeof SyncSchema>;
    export type PatchEntity = z.infer<typeof PatchEntitySchema>;
    export type PatchEdge = z.infer<typeof PatchEdgeSchema>;
    export type PatchPayload = z.infer<typeof PatchPayloadSchema>;
  }

  // ============================================
  // VALIDATION & CREATION
  // ============================================
  
  export const validate = {
    create: (data: unknown): DTO.Create => DTO.CreateSchema.parse(data),
    update: (data: unknown): DTO.Update => DTO.UpdateSchema.parse(data),
    sync: (data: unknown): DTO.Sync => DTO.SyncSchema.parse(data),
    patchPayload: (data: unknown): DTO.PatchPayload => DTO.PatchPayloadSchema.parse(data),
  };

  export const create = (
    data: DTO.Create,
    arrangementId: string,
    userId: string
  ): Omit<Model, 'id' | 'createdAt' | 'updatedAt'> => ({
    arrangementId,
    userId,
    type: data.type,
    content: data.content,
    label: data.label,
    color: data.color,
    tags: data.tags,
    layers: data.layers,
    pinned: data.pinned,
    isMergePoint: data.isMergePoint,
    ancestorOverride: data.ancestorOverride,
    scale: data.scale,
    x: data.x,
    y: data.y,
    parentId: data.parentId,
    version: 1, // New notes start at version 1
  });

  // Agents often emit a full HTML document wrapped in prose ("here's your page:
  // <!doctype html>…</html> — let me know!"). To render it as a live artifact,
  // wrap any <html>…</html> document (optionally preceded by a doctype) that
  // sits OUTSIDE an existing code fence in a ```html block; surrounding prose
  // stays markdown. Idempotent — a fenced document is skipped on the next pass.
  // Partial/inline HTML (a stray <div>) is intentionally left alone: it's
  // ambiguous with markdown's own inline HTML and would false-positive.
  export const fenceHtmlDocuments = (content: string): string => {
    if (!/<html\b|<!doctype\s+html/i.test(content)) return content;

    const wrapDocs = (prose: string): string =>
      prose.replace(
        /(?:<!doctype\s+html[^>]*>\s*)?<html\b[\s\S]*?<\/html>/gi,
        (doc) => `\n\n\`\`\`html\n${doc.trim()}\n\`\`\`\n\n`,
      );

    // Walk the string, leaving already-fenced regions untouched and only
    // wrapping HTML documents found in the prose gaps between fences.
    let out = '';
    let last = 0;
    for (const fence of content.matchAll(/```[\s\S]*?```/g)) {
      const idx = fence.index ?? 0;
      out += wrapDocs(content.slice(last, idx)) + fence[0];
      last = idx + fence[0].length;
    }
    return out + wrapDocs(content.slice(last));
  };

  // ============================================
  // PATCH OPERATIONS (Pure business logic)
  // ============================================

  // Defaults for new nodes
  const NODE_DEFAULTS = {
    content: '',
    label: null,
    color: null,
    tags: [] as string[],
    layers: [] as string[],
    pinned: false,
    isMergePoint: false,
    parentId: null,
    scale: 1.0,
    width: null,
    height: null,
    style: null as Style,
    type: 'USER' as Type,
  };

  // Fields that can be updated
  type UpdatableFields = 'type' | 'x' | 'y' | 'width' | 'height' | 'scale' | 'label' | 'color' | 'tags' | 'layers' | 'pinned' | 'isMergePoint' | 'parentId' | 'content' | 'status' | 'style' | 'windowLayout';

  export namespace Patch {
    // Types derived from existing types - no duplication.
    // Status is narrowed to DTO.PatchEntity['status'] (the 4 Prisma-persistable
    // values) rather than Model.Status (which includes transient UI-only states),
    // so toUpdateData's output is safe to pass straight to Prisma.
    export type CreateData = typeof NODE_DEFAULTS & { id: string; arrangementId: string; userId: string; x: number; y: number };
    export type UpdateData = {
      id: string;
      data: Partial<Pick<Model, Exclude<UpdatableFields, 'status'>>> & { status?: DTO.PatchEntity['status'] };
    };

    // Fields the PatchEntity carries that are NOT Prisma columns — they're
    // instructions to the controller, not state. Stripped before any DB write.
    const TRANSIENT_FIELDS = ['expectedVersion', 'provisioning'] as const;

    /** Build create data with defaults */
    export const toCreateData = (
      dirty: DTO.PatchEntity,
      arrangementId: string,
      userId: string
    ): CreateData => {
      const persisted = { ...dirty };
      for (const k of TRANSIENT_FIELDS) delete (persisted as Record<string, unknown>)[k];
      return {
        ...NODE_DEFAULTS,
        ...pickDefined(persisted) as Partial<CreateData>,
        id: dirty.id,
        arrangementId,
        userId,
        x: dirty.x!,
        y: dirty.y!,
      };
    };

    /** Extract only defined updatable fields */
    export const toUpdateData = (dirty: DTO.PatchEntity): UpdateData | null => {
      const { id, expectedVersion, provisioning, ...rest } = dirty;
      void expectedVersion; void provisioning;
      const data = pickDefined(rest);
      return Object.keys(data).length ? { id, data } : null;
    };

    /** Pure mapping from a React Flow node into the wire-shape the patch
     *  endpoint speaks. Lives here so the canvas sync hook can't drift its
     *  own version of "which fields are persisted" — one place to add a
     *  new persistable field. */
    export const fromRfNode = (node: RfNode): DTO.PatchEntity => {
      const d = node.data as Partial<Model> & { [k: string]: unknown };
      const status = d.status;
      // Only the five persistable statuses make it onto the wire — UI-only
      // states (`running`, `error`, `saving`, …) are stripped here.
      const persistableStatus =
        status === 'EXPECTING_AI_RESPONCE'
        || status === 'FRESH_RESPONCE'
        || status === 'RUNNING'
        || status === 'FROZEN'
        || status === 'PROVISIONING'
          ? status
          : undefined;
      const type = (d.type as Type) ?? 'USER';
      // Only MACHINE / TERMINAL nodes carry daemon-side identity; stamping
      // those fields on a USER note would persist garbage. Authoritative
      // gate is the type itself (frontend `isInfra` is just shorthand).
      const isInfra = type === 'MACHINE' || type === 'TERMINAL';
      return {
        id: node.id,
        type,
        x: node.position.x,
        y: node.position.y,
        width: (node.width as number | undefined) ?? null,
        height: (node.height as number | undefined) ?? null,
        label: d.label ?? null,
        color: d.color ?? null,
        scale: d.scale ?? 1.0,
        tags: d.tags ?? [],
        layers: d.layers ?? [],
        pinned: d.pinned ?? false,
        isMergePoint: d.isMergePoint ?? false,
        content: d.content ?? '',
        parentId: (node as { parentId?: string | null }).parentId ?? null,
        status: persistableStatus,
        parentMachineNodeId: isInfra ? (d.parentMachineNodeId ?? null) : null,
        machineId: isInfra ? (d.machineId as string | undefined) : undefined,
        daemonId: isInfra ? ((d as { daemonId?: string | null }).daemonId ?? null) : null,
        style: d.style ?? undefined,
      };
    };

    /** Categorize into create/update batches */
    export const categorize = (
      dirtyNodes: DTO.PatchEntity[],
      existingIds: Set<string>,
      arrangementId: string,
      userId: string
    ) => {
      const toCreate: CreateData[] = [];
      const toUpdate: UpdateData[] = [];

      for (const dirty of dirtyNodes) {
        if (!existingIds.has(dirty.id)) {
          toCreate.push(toCreateData(dirty, arrangementId, userId));
        } else {
          const update = toUpdateData(dirty);
          if (update) toUpdate.push(update);
        }
      }

      return { toCreate, toUpdate };
    };
  }

  // Layer membership for a note. `[]` = global (its own toggleable layer);
  // non-empty = visible iff any of its layers is in `visible`.
  export namespace Layers {
    const list = (n: { layers?: string[] | null }): string[] => n.layers ?? [];

    export const isGlobal = (n: { layers?: string[] | null }): boolean => list(n).length === 0;

    export const isVisibleOn = (
      n: { layers?: string[] | null },
      visible: ReadonlySet<string>,
      globalVisible: boolean = true,
    ): boolean => {
      const ls = list(n);
      if (ls.length === 0) return globalVisible;
      for (const l of ls) if (visible.has(l)) return true;
      return false;
    };

    export const withLayer = (n: { layers?: string[] | null }, layer: string): string[] => {
      const ls = list(n);
      return ls.includes(layer) ? ls : [...ls, layer];
    };

    export const withoutLayer = (n: { layers?: string[] | null }, layer: string): string[] =>
      list(n).filter(l => l !== layer);

    export const replace = (layers: string[]): string[] =>
      Array.from(new Set(layers)).sort();

    export const collectKnown = (notes: Array<{ layers?: string[] | null }>): string[] =>
      Array.from(new Set(notes.flatMap(list))).sort();
  }

  // ============================================
  // BRANCH / SELECTION HELPERS (pure functions)
  // ============================================

  /**
   * Collect the text of a node and all its ancestors, root-first, joined with a separator.
   * Used by "copy branch" and similar features that want the whole thinking chain as text.
   *
   * Merge-point handling: a node may have multiple paths to root. In that case
   * we emit each path as its own block, separated by `pathSeparator` (defaults
   * to a heavier divider so the reader can see where one ancestry ends and
   * another begins). For single-parent trees the behavior is identical to a
   * plain root→leaf concatenation.
   *
   * Empty content is skipped so the joined output never has dangling separators.
   */
  export const collectBranchText = (
    nodeId: string,
    notes: Model[],
    edges: Edge.Model[],
    separator: string = '\n\n---\n\n',
    pathSeparator: string = '\n\n=== PATH ===\n\n'
  ): string => {
    const noteMap = new Map(notes.map(n => [n.id, n]));
    // `getAllPathsToRoots` returns an array of paths, each ordered root→parent
    // (excluding the node itself). For a plain tree this is a single path.
    const paths = Edge.getAllPathsToRoots(nodeId, edges);

    const renderPath = (ancestorIds: string[]) => {
      const chain = [...ancestorIds, nodeId];
      return chain
        .map(id => {
          const raw = noteMap.get(id)?.content?.trim() ?? '';
          return Mention.expandTokens(raw, noteMap);
        })
        .filter(text => text.length > 0)
        .join(separator);
    };

    // If the node is a root with no ancestors, paths === [[]] (one empty path).
    // Still render — we'll just get the node's own content.
    if (paths.length === 0) {
      return renderPath([]);
    }
    return paths.map(renderPath).filter(p => p.length > 0).join(pathSeparator);
  };

  /**
   * Collect the text of a list of notes (in the given order) into a single string.
   * Used by multi-select "copy selected as text" so ordering is caller-controlled.
   */
  export const collectTextFromIds = (
    ids: string[],
    notes: Model[],
    separator: string = '\n\n---\n\n'
  ): string => {
    const noteMap = new Map(notes.map(n => [n.id, n]));
    return ids
      .map(id => {
        const raw = noteMap.get(id)?.content?.trim() ?? '';
        return Mention.expandTokens(raw, noteMap);
      })
      .filter(text => text.length > 0)
      .join(separator);
  };

  // ============================================
  // CAPABILITIES — single decision table for domain rules
  // ============================================

  /**
   * A note on the canvas can play several roles, and each role asks a
   * different question. Rather than scattering predicates or `type === 'X'`
   * checks across the codebase, every domain rule about "what can this note
   * do" lives here, in one pure function.
   *
   * Each flag is a concrete answer to a concrete question a use case asks.
   * Adding a new rule means adding a flag here — nothing else has to change
   * at the call sites.
   */
  export type Kind = 'annotation' | 'content' | 'infra' | 'unknown'

  // Types whose lifecycle is mirrored on the daemon (machine + terminal).
  // Exposed as a constant so DB-layer queries can spell the filter as
  // `type: { in: [...DAEMON_BACKED_TYPES] }` instead of string literals.
  export const DAEMON_BACKED_TYPES: Type[] = ['MACHINE', 'TERMINAL'];

  export const isDaemonBacked = (note: { type?: Type | null } | null | undefined): boolean =>
    !!note?.type && DAEMON_BACKED_TYPES.includes(note.type);

  // Structural minimum needed to route a daemon RPC: a daemon-backed note
  // (MACHINE/TERMINAL) that knows both its machine and its owning daemon.
  export type DaemonRoutable<T extends { machineId?: string | null; daemonId?: string | null; type?: Type | null }> =
    T & { machineId: string; daemonId: string };

  export const isDaemonRoutable = <T extends { machineId?: string | null; daemonId?: string | null; type?: Type | null }>(
    note: T | null | undefined,
  ): note is DaemonRoutable<T> =>
    !!note && !!note.machineId && !!note.daemonId && isDaemonBacked(note);

  export interface Capabilities {
    /** What kind of object is this, in domain terms. */
    kind: Kind
    /** Can be the source of an Action (a human prompt given to the AI). */
    canRunAction: boolean
    /** Can be aggregated by a Unifier (its content feeds the LLM). */
    canBeUnifierSource: boolean
    /** Its content is valid ancestor context for an LLM prompt. */
    canBeAIContext: boolean
    /** Clicking opens a floating edit window / side panel. */
    canOpenEditPanel: boolean
    /**
     * The node's lifecycle is fully owned by the local sync pipeline (DB
     * upserts/deletes via the patch endpoint, no external coordination).
     * False for daemon-backed types (MACHINE / TERMINAL) whose creation,
     * branching and freezing have side effects on the daemon that the local
     * undo/redo or naive sync flow can't reverse.
     *
     * Use this flag for any "should the local sync layer treat this as a
     * plain reversible record" decision — undo/redo history filtering,
     * clipboard import paths, bulk-delete dialogs, etc.
     */
    syncable: boolean
  }

  /**
   * Derive the full capability set of a note from its type.
   *
   * - annotation (TEXT): visual label only — no AI role, no panel.
   * - content (USER / ASSISTANT / SYSTEM / legacy GROUP): full AI citizen.
   * - infra (MACHINE / TERMINAL): can't originate an action (an action is a
   *   human prompt, and a machine doesn't prompt), but its content — logs,
   *   descriptions, terminal output — IS legitimate AI context and a valid
   *   unifier input, and it has its own edit panel.
   */
  export const capabilities = (note: { type?: Type | null } | null | undefined): Capabilities => {
    const t = note?.type
    const kind: Kind =
      (t === 'TEXT' || t === 'ZONE' || t === 'DRAWING') ? 'annotation'
      : (t === 'MACHINE' || t === 'TERMINAL') ? 'infra'
      : (t === 'USER' || t === 'ASSISTANT' || t === 'SYSTEM' || t === 'GROUP') ? 'content'
      : 'unknown'

    const isContent = kind === 'content'
    const isInfra = kind === 'infra'

    return {
      kind,
      canRunAction:       isContent,
      canBeUnifierSource: isContent || isInfra,
      canBeAIContext:     isContent || isInfra,
      canOpenEditPanel:   isContent || isInfra,
      // Daemon-backed nodes pierce the simple sync model — keep them out.
      syncable:           !isInfra,
    }
  }

  // ============================================
  // TRANSFORMS
  // ============================================

  export const Transform = {
    toRfNode: (note: Model): RfNode => {
      // Determine React Flow node type based on database type.
      // GROUP is legacy — groups were removed; old GROUP notes fall through to
      // the regular note renderer so existing data keeps rendering.
      const rfNodeType =
        note.type === 'MACHINE' ? 'machine'
        : note.type === 'TERMINAL' ? 'terminal'
        : note.type === 'TEXT' ? 'text'
        : note.type === 'ZONE' ? 'zone'
        : note.type === 'DRAWING' ? 'drawing'
        : 'note';

      // Calculate scaled dimensions for React Flow hit-testing
      // CSS zoom scales the visual appearance, but React Flow needs to know the actual dimensions
      const scale = note.scale || 1.0;
      const scaledWidth = Canvas.NODE_DIMENSIONS.WIDTH * scale;
      const scaledHeight = Canvas.NODE_DIMENSIONS.HEIGHT * scale;

      // GROUP: legacy fixed-dim container.
      // TEXT:  no explicit dims — TextNode auto-measures from fontSize × content;
      //        forcing 300 × 200 here would freeze hit-testing at the wrong box
      //        for short headings or wide multi-line text.
      // Other (USER/ASSISTANT/MACHINE/TERMINAL): card-shaped, scaled fixed dims.
      const dimensionProps = note.type === 'GROUP' ? {
        width: note.width ?? 400,
        height: note.height ?? 300,
        style: { width: note.width ?? 400, height: note.height ?? 300 },
      } : (note.type === 'ZONE' || note.type === 'DRAWING') ? {
        // Free-form annotations carry their own bounding box (set on create,
        // updated by NodeResizer for zones). The component fills 100%.
        width: note.width ?? 200,
        height: note.height ?? 150,
      } : note.type === 'TEXT' ? {} : {
        width: scaledWidth,
        height: scaledHeight,
      };

      // Parent-child relationship props
      const parentProps = note.parentId ? {
        parentId: note.parentId,
        extent: 'parent' as const, // Constrain child to parent bounds
      } : {};

      return {
        id: note.id,
        type: rfNodeType,
        position: { x: note.x, y: note.y },
        data: {
          // Include all note data that NoteCard component expects
          ...note,
          // For group nodes, use label as the group label
          label: note.label || (note.type === 'GROUP' ? 'New Group' : note.label),
          // Preserve actual status from database (don't override)
          status: note.status || undefined,
        },
        ...dimensionProps,
        ...parentProps,
      } as RfNode;
    },

    fromRfNode: (
      node: RfNode,
      arrangementId: string,
      userId: string
    ) => ({
      id: node.id,
      arrangementId,
      userId,
      content: node.data.content as string,
      type: node.data.type as Type,
      label: node.data.label as string | undefined,
      color: node.data.color as string | undefined,
      scale: (node.data.scale as number) ?? 1.0, // Visual scale of the note
      layers: ((node.data.layers as string[] | undefined) ?? []),
      x: node.position.x,
      y: node.position.y,
      parentId: node.data.parentId as string | undefined,
    }),
  };

  // ============================================
  // PER-MODEL CACHE ANCHOR — user-facing knob.
  //
  // A note can carry a separate cache configuration per model. The backend
  // walks ancestors from the leaf upward during prompt assembly and stops at
  // the first note with `cacheConfig[currentModel]?.enabled === true`. That
  // note becomes the "anchor": everything above is the cached prefix,
  // everything at-and-below is fresh content.
  //
  // This type is user intent only. Infra state (e.g. Gemini CachedContent
  // handles) lives in a separate backend table — we never smear user-facing
  // configuration with provider-owned lifecycle artefacts.
  // ============================================

  export namespace CacheConfig {
    // Backend-managed runtime state. Lives inside the same entry because
    // handle lifecycle is 100% coupled to user intent: TTL change, toggle,
    // content edit — all wipe the handle in lockstep. Nesting it under
    // `runtime` labels it as "infra, don't touch" so UI code reads the
    // sibling ttl/enabled and ignores this block.
    //
    // Currently only Gemini (CachedContent API) populates this. Anthropic
    // caches are stateless; OpenAI caches are opaque server-side.
    export type Runtime = {
      handle: string;
      expiresAt: string; // ISO — JSON-safe
      tokens: number;
    };

    export type Entry = {
      ttl: string;      // one of the model's LLM.CacheCapability.ttlOptions values
      enabled: boolean; // soft toggle — lets user pause/resume without losing TTL choice
      runtime?: Runtime;
    };

    // Sparse map: absent key ⇒ no cache for that model on this note.
    export type Config = Record<string, Entry>;

    export const RuntimeSchema = z.object({
      handle: z.string().min(1),
      expiresAt: z.string().min(1),
      tokens: z.number().int().nonnegative(),
    });

    export const EntrySchema = z.object({
      ttl: z.string().min(1),
      enabled: z.boolean(),
      runtime: RuntimeSchema.optional(),
    });
    export const ConfigSchema = z.record(z.string(), EntrySchema);

    // DTOs for the per-note routes.
    export const SetSchema = z.object({
      modelId: z.string().min(1),
      ttl: z.string().min(1),
      enabled: z.boolean().default(true),
    });
    export type Set = z.infer<typeof SetSchema>;

    export const ToggleSchema = z.object({
      modelId: z.string().min(1),
      enabled: z.boolean(),
    });
    export type Toggle = z.infer<typeof ToggleSchema>;

    // Parse boundary: narrow Prisma's JsonValue-typed cacheConfig to our
    // domain shape. Returns null on anything that isn't an object-like
    // value, so downstream morphisms never see primitives/arrays.
    export const asConfig = (raw: unknown): Config | null => {
      if (raw === null || raw === undefined) return null;
      if (typeof raw !== 'object' || Array.isArray(raw)) return null;
      return raw as Config;
    };

    export const get = (config: unknown, modelId: string): Entry | undefined =>
      asConfig(config)?.[modelId];

    export const isActiveFor = (config: unknown, modelId: string): boolean =>
      !!get(config, modelId)?.enabled;

    export const withModel = (
      config: unknown,
      modelId: string,
      entry: Entry,
    ): Config => ({ ...(asConfig(config) ?? {}), [modelId]: entry });

    export const withoutModel = (config: unknown, modelId: string): Config => {
      const next = { ...(asConfig(config) ?? {}) };
      delete next[modelId];
      return next;
    };

    // Read the live runtime handle for (note, model). Returns undefined if
    // no handle exists or if it's past its expiry.
    export const liveRuntime = (
      config: unknown,
      modelId: string,
      now = Date.now(),
    ): Runtime | undefined => {
      const rt = get(config, modelId)?.runtime;
      if (!rt) return undefined;
      return new Date(rt.expiresAt).getTime() > now ? rt : undefined;
    };

    // Attach/refresh the runtime block without touching user intent fields.
    // Throws on missing entry — the worker only mints handles for enabled
    // anchors, so the entry must already exist. Silent no-op would hide a
    // sync bug (runtime persisted but never readable).
    export const withRuntime = (
      config: unknown,
      modelId: string,
      runtime: Runtime,
    ): Config => {
      const entry = get(config, modelId);
      if (!entry) {
        throw new Error(`withRuntime: no entry for model ${modelId} — caller invariant violated`);
      }
      return withModel(config, modelId, { ...entry, runtime });
    };

    // Drop the runtime block; keep user intent (ttl, enabled) intact. Used
    // when content changes, TTL changes, or the user toggles off — the user
    // may re-enable and wants their TTL preserved.
    export const withoutRuntime = (config: unknown, modelId: string): Config => {
      const entry = get(config, modelId);
      if (!entry) return asConfig(config) ?? {};
      const { runtime, ...rest } = entry;
      return withModel(config, modelId, rest);
    };

    // Compute the next entry shape for a user-set op. Preserves the existing
    // runtime handle only when TTL is unchanged — otherwise the handle is
    // stale (wrong duration) and the caller is expected to drop it remotely.
    // Single place for "what does 'set' mean for an Entry?".
    export const upsertEntry = (prev: Entry | undefined, dto: Set): Entry => {
      const ttlChanged = !!prev && prev.ttl !== dto.ttl;
      return {
        ttl: dto.ttl,
        enabled: dto.enabled,
        ...(ttlChanged ? {} : (prev?.runtime ? { runtime: prev.runtime } : {})),
      };
    };

    export const validate = {
      set: (data: unknown): Set => SetSchema.parse(data),
      toggle: (data: unknown): Toggle => ToggleSchema.parse(data),
    };
  }

}
