import { z } from 'zod';
import { Note } from './note';

export namespace Action {
  // ============================================
  // CORE TYPES
  // ============================================

  export type OutputStyle = 'SINGLE_CHILD' | 'MULTIPLE_CHILDREN';

  /** Schema for AI responses returning multiple results */
  export const MultipleResultsSchema = z.object({ results: z.array(z.string()) });

  export interface Model {
    id: string;
    name: string;
    useAncestors: boolean;
    resolveContent: boolean;
    outputStyle: OutputStyle;
    prompt: string;
    userId: string;
    createdAt: Date;
  }

  // ============================================
  // DTOs (what frontend sends)
  // ============================================
  
  export namespace DTO {
    export const OutputStyleSchema = z.enum(['SINGLE_CHILD', 'MULTIPLE_CHILDREN']);

    export const CreateSchema = z.object({
      name: z.string().min(1).max(100),
      useAncestors: z.boolean().default(true),
      resolveContent: z.boolean().default(true),
      outputStyle: OutputStyleSchema.default('SINGLE_CHILD'),
      prompt: z.string().min(1).max(5000),
    });

    export const UpdateSchema = z.object({
      name: z.string().min(1).max(100).optional(),
      useAncestors: z.boolean().optional(),
      resolveContent: z.boolean().optional(),
      outputStyle: OutputStyleSchema.optional(),
      prompt: z.string().min(1).max(5000).optional(),
    });

    export const ExecuteSchema = z.object({
      noteIds: z.array(z.string().min(1)).min(1),
    });

    export type Create = z.infer<typeof CreateSchema>;
    export type Update = z.infer<typeof UpdateSchema>;
    export type Execute = z.infer<typeof ExecuteSchema>;
  }

  export const DEFAULTS = [
    {
      name: 'Split',
      prompt:
        'Split the input on its highest-level enumeration. Each top-level item becomes one result, with everything underneath it — subchapters, nested lists, code blocks, paragraphs — preserved verbatim inside that item.\n\n' +
        'Example. Given:\n' +
        '```\n' +
        'intro paragraph\n' +
        '1. Chapter 1\n' +
        '   subchapter A\n' +
        '   subchapter B\n' +
        '2. Chapter 2\n' +
        '   subchapter A\n' +
        '3. Chapter 3\n' +
        '   subchapter A\n' +
        'trailing paragraph\n' +
        '```\n' +
        'Return three items, one per chapter, each carrying its subchapters intact. Drop the intro and trailing paragraphs — only the enumerated knowledge is split.\n\n' +
        'Rules:\n' +
        '- Split only at the top level; never split inside an item.\n' +
        '- Preserve all formatting and nested content within each item.\n' +
        '- Strip any prefix/suffix that isn\'t part of an enumerated item.',
      useAncestors: true,
      resolveContent: true,
      outputStyle: 'MULTIPLE_CHILDREN',
    },
    {
      name: 'Play',
      prompt:
        'Continue or develop the input into the next useful version. Keep the same language, preserve important context, and produce one strong next-step response.',
      useAncestors: true,
      resolveContent: true,
      outputStyle: 'SINGLE_CHILD',
    },
    {
      name: 'Summarize',
      prompt:
        'Summarize the input into a concise, information-dense note. Preserve the main ideas, decisions, and constraints. Use short paragraphs or bullets when it improves clarity.',
      useAncestors: true,
      resolveContent: true,
      outputStyle: 'SINGLE_CHILD',
    },
  ] satisfies DTO.Create[];

  // ============================================
  // VALIDATION HELPERS
  // ============================================
  
  export namespace validate {
    export const create = (data: unknown): DTO.Create => {
      return DTO.CreateSchema.parse(data);
    };

    export const update = (data: unknown): DTO.Update => {
      return DTO.UpdateSchema.parse(data);
    };

    export const execute = (data: unknown): DTO.Execute => {
      return DTO.ExecuteSchema.parse(data);
    };
  }

  // ============================================
  // PURE BUSINESS LOGIC
  // ============================================

  /**
   * Combine multiple note contents with a separator.
   * Used for building context from ancestors or multiple selected notes.
   */
  export const combineNoteContents = (notes: Pick<Note.Model, 'content'>[]): string => {
    return notes
      .filter(note => note.content.trim())
      .map(note => note.content)
      .join('\n\n---\n\n');
  };

  /**
   * Build full prompt context from ancestors + current note.
   * Pure function - no database access required.
   */
  export const buildPromptContext = (
    sourceNote: Pick<Note.Model, 'content'>,
    ancestors: Pick<Note.Model, 'content'>[]
  ): string => {
    const ancestorContext = combineNoteContents(ancestors);

    if (ancestorContext) {
      return `Previous context:\n${ancestorContext}\n\n---\n\nCurrent message:\n${sourceNote.content}`;
    }

    return sourceNote.content;
  };

  /**
   * Build the final prompt by prepending the action prompt to the content.
   */
  export const buildFinalPrompt = (
    actionPrompt: string,
    content: string
  ): string => {
    return `${actionPrompt}\n\n${content}`;
  };

  /**
   * Build prompt with ancestor context for action execution.
   * Used when action.useAncestors is true.
   */
  export const buildPromptWithAncestors = (
    actionPrompt: string,
    sourceNoteContent: string,
    ancestorContents: Pick<Note.Model, 'content'>[]
  ): string => {
    const contextString = combineNoteContents(ancestorContents);
    const taskContent = contextString
      ? `Context:\n${contextString}\n\n---\n\nTask:\n${sourceNoteContent}`
      : sourceNoteContent;

    return buildFinalPrompt(actionPrompt, taskContent);
  };

  /**
   * Generate structured prompt for MULTIPLE_CHILDREN output style.
   * Instructs the AI to return a JSON array of results.
   */
  export const wrapForMultipleChildren = (prompt: string): string => {
    return `${prompt}\n\nRespond with a JSON object following this schema: { "results": ["string", "string", ...] }. Each string in the 'results' array should be a distinct, self-contained piece of content.`;
  };

  /**
   * Parse AI response for MULTIPLE_CHILDREN output style.
   */
  export const parseMultipleChildrenResponse = (raw: string): string[] => {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.results)) return parsed.results;
    } catch { /* fall through */ }
    return raw.split('\n').filter(line => line.trim().length > 0);
  };

  // ============================================
  // ACTION EXECUTION HELPERS (Pure)
  // ============================================

  export namespace Execution {
    /** Extract note IDs from note array */
    export const extractAncestorIds = (notes: Pick<Note.Model, 'id'>[]): string[] =>
      notes.map(n => n.id);

    /** Calculate horizontal positions for Cartesian product children */
    export const calculateCartesianPositions = (
      base: { x: number; y: number },
      count: number,
      spacing: number
    ): { x: number; y: number }[] =>
      Array.from({ length: count - 1 }, (_, i) => ({
        x: base.x + (i + 1) * spacing,
        y: base.y,
      }));

  }

  // ============================================
  // WORKER JOB — wire payload for the NATS queue / Temporal workflow.
  // -----------------------------------------------------------------
  // Two named variants. Replaces the old tristate dance of nullable
  // `optimisticTargetNodeId` + optional `childNodePosition`:
  //
  //   kind === 'fill'   → worker writes AI output into `targetNoteId`
  //                       (the optimistic placeholder child, or the result
  //                       node from a unifier-style flow)
  //   kind === 'create' → worker creates a new child at `position` under
  //                       parent = sourceNoteIds[0] (Cartesian path #N>0)
  //
  // Both variants share the Common fields so the prompt-building activity
  // can read them uniformly and only processResults discriminates on kind.
  // ============================================

  export namespace Job {
    type Common = {
      actionId: string;
      sourceNoteIds: string[];
      userId: string;
      arrangementId: string;
      model: string;
      ancestorContext?: string[];
    };

    export type Fill = Common & {
      kind: 'fill';
      targetNoteId: string;
    };

    export type Create = Common & {
      kind: 'create';
      position: { x: number; y: number };
    };

    export type Any = Fill | Create;

    export const fill = (p: Omit<Fill, 'kind'>): Fill => ({ kind: 'fill', ...p });
    export const create = (p: Omit<Create, 'kind'>): Create => ({ kind: 'create', ...p });
  }

  // ============================================
  // WORKER TYPES (Temporal activities)
  // ============================================

  export namespace Worker {
    // Shape buildPrompt activity accepts. `model` arrives via the job's
    // Common fields; activity wraps the call with whatever it already has.
    export type BuildPromptInput = {
      actionId: string;
      sourceNoteIds: string[];
      arrangementId: string;
      userId: string;
      ancestorContext?: string[];
    };
  }

  export namespace Result {
    /** Build node data for Cartesian child */
    export const buildCartesianChildData = (p: {
      content: string;
      position: { x: number; y: number };
      arrangementId: string;
      userId: string;
      ancestorContext?: string[];
      /** Inherited from the spawn parent so the child stays on the same
       *  canvas layer instead of silently dropping to global. */
      layers?: string[];
    }) => ({
      arrangementId: p.arrangementId,
      userId: p.userId,
      content: p.content,
      type: 'ASSISTANT' as const,
      status: null,
      x: p.position.x,
      y: p.position.y,
      ancestorOverride: p.ancestorContext ?? [],
      layers: p.layers ?? [],
    });

    /** Build node data for multiple children (positions offset from base) */
    export const buildMultipleChildrenData = (p: {
      contents: string[];
      basePosition: { x: number; y: number };
      spacing: number;
      arrangementId: string;
      userId: string;
      /** Inherited from the spawn parent — same reason as Cartesian above. */
      layers?: string[];
    }) =>
      p.contents.map((content, i) => ({
        arrangementId: p.arrangementId,
        userId: p.userId,
        content,
        type: 'ASSISTANT' as const,
        status: null,
        x: p.basePosition.x + (i + 1) * p.spacing,
        y: p.basePosition.y,
        layers: p.layers ?? [],
      }));
  }
}
