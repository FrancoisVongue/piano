import { z } from 'zod';
import { Note } from './note';

export namespace Unifier {
  // ============================================
  // CORE TYPES
  // ============================================

  export type OutputStyle = 'SINGLE_NODE' | 'MULTIPLE_NODES';

  export interface Model {
    id: string;
    name: string;
    outputStyle: OutputStyle;
    prompt: string;
    userId: string;
    createdAt: Date;
  }

  // ============================================
  // DTOs (what frontend sends)
  // ============================================

  export namespace DTO {
    export const OutputStyleSchema = z.enum(['SINGLE_NODE', 'MULTIPLE_NODES']);

    export const CreateSchema = z.object({
      name: z.string().min(1).max(100),
      outputStyle: OutputStyleSchema.default('SINGLE_NODE'),
      prompt: z.string().min(1).max(5000),
    });

    export const UpdateSchema = z.object({
      name: z.string().min(1).max(100).optional(),
      outputStyle: OutputStyleSchema.optional(),
      prompt: z.string().min(1).max(5000).optional(),
    });

    export const ExecuteSchema = z.object({
      noteIds: z.array(z.string().min(1)).min(1),
      userPrompt: z.string().max(5000).optional(), // Additional user context when executing
    });

    export type Create = z.infer<typeof CreateSchema>;
    export type Update = z.infer<typeof UpdateSchema>;
    export type Execute = z.infer<typeof ExecuteSchema>;
  }

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
   * Combine multiple note contents with clear start/end markers.
   * Used for building context from multiple selected notes.
   */
  export const combineNoteContents = (notes: Pick<Note.Model, 'content' | 'label'>[]): string => {
    return notes
      .filter(note => note.content.trim())
      .map((note, index) => {
        const noteNum = index + 1;
        const labelInfo = note.label?.trim() ? ` - ${note.label.trim()}` : '';
        
        return `---------- Note ${noteNum}${labelInfo} (start)
${note.content}
---------- Note ${noteNum}${labelInfo} (end)`;
      })
      .join('\n\n');
  };

  /**
   * Build the final prompt for unifier execution.
   * Combines unifier prompt + user prompt + note contents with clear structure.
   */
  export const buildFinalPrompt = (
    unifierPrompt: string,
    userPrompt: string | undefined,
    noteContents: string
  ): string => {
    let prompt = `[SYSTEM INSTRUCTION]
${unifierPrompt}`;

    if (userPrompt?.trim()) {
      prompt += `\n\n[USER INSTRUCTION]
${userPrompt.trim()}`;
    }

    prompt += `\n\n[INPUT NOTES]
${noteContents}`;

    return prompt;
  };

  /**
   * Generate structured prompt for MULTIPLE_NODES output style.
   * Instructs the AI to return a JSON array of results.
   */
  export const wrapForMultipleNodes = (prompt: string): string => {
    return `${prompt}\n\nRespond with a JSON object following this schema: { "results": ["string", "string", ...] }. Each string in the 'results' array should be a distinct, self-contained piece of content.`;
  };

  /**
   * Parse AI response for MULTIPLE_NODES output style.
   * Attempts to parse JSON, falls back to splitting by newline.
   */
  export const parseMultipleNodesResponse = (rawResponse: string): string[] => {
    try {
      const parsed = JSON.parse(rawResponse);
      if (Array.isArray(parsed.results)) {
        return parsed.results;
      }
    } catch {
      // Fall through to newline split
    }

    // Fallback: split by newline
    return rawResponse.split('\n').filter(line => line.trim().length > 0);
  };

  /**
   * Calculate the centroid position of multiple notes.
   * Used to position the resulting unified node(s).
   */
  export const calculateCentroid = (
    notes: Pick<Note.Model, 'x' | 'y'>[]
  ): { x: number; y: number } => {
    if (notes.length === 0) {
      return { x: 0, y: 0 };
    }

    const sumX = notes.reduce((sum, note) => sum + note.x, 0);
    const sumY = notes.reduce((sum, note) => sum + note.y, 0);

    return {
      x: sumX / notes.length,
      y: sumY / notes.length,
    };
  };

  /**
   * Calculate position for unified result node.
   * Places it below and to the right of the centroid.
   */
  export const calculateResultPosition = (
    notes: Pick<Note.Model, 'x' | 'y'>[],
    offset: { x: number; y: number } = { x: 100, y: 200 }
  ): { x: number; y: number } => {
    const centroid = calculateCentroid(notes);
    return {
      x: centroid.x + offset.x,
      y: centroid.y + offset.y,
    };
  };

  // ============================================
  // WORKER TYPES (Temporal activities)
  // ============================================

  export namespace Worker {
    export type BuildPromptInput = {
      unifierId: string;
      sourceNoteIds: string[];
      userPrompt: string | undefined;
      arrangementId: string;
      userId: string;
    };

    export type CallAIInput = {
      prompt: string;
      model: string;
      outputStyle: OutputStyle;
    };

    export type ProcessResultsInput = {
      unifier: { outputStyle: OutputStyle };
      aiResponse: string | string[];
      sourceNoteIds: string[];
      optimisticTargetNodeId: string;
      arrangementId: string;
      userId: string;
    };
  }
}
