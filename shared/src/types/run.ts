export namespace Run {
  // ============================================
  // CORE MODEL
  // ============================================
  
  export interface Model {
    id: string;
    noteId: string;
    arrangementId: string;
    userId: string;
    fullContext: string;
    response: string;
    tokensUsed: number;
    model: string;
    createdAt: Date;
    updatedAt: Date;
  }

  // ============================================
  // HELPER FUNCTIONS
  // ============================================
  
  export const create = (data: {
    noteId: string;
    arrangementId: string;
    userId: string;
    fullContext: string;
    response: string;
    tokensUsed: number;
    model: string;
  }): Omit<Model, 'id' | 'createdAt' | 'updatedAt'> => ({
    noteId: data.noteId,
    arrangementId: data.arrangementId,
    userId: data.userId,
    fullContext: data.fullContext,
    response: data.response,
    tokensUsed: data.tokensUsed,
    model: data.model,
  });
}
