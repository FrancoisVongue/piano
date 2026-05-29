import { LLM } from '@piano/shared';
import { services } from '../../services/init';

// -----------------------------------------------------------------------------
// Single source of truth for writing a Run row. Both action and unifier
// workers call this after their processResults finishes — the content write
// and the usage persist stay in one activity boundary for retry atomicity.
//
// We don't store the raw prompt or response: fullContext/response are the
// legacy columns, kept empty for user-data privacy. tokensUsed is the old
// aggregate column — kept updated so any legacy reader still works.
// -----------------------------------------------------------------------------

export const persistRun = (input: {
  noteId: string;
  arrangementId: string;
  userId: string;
  usage: LLM.RunUsage;
}) =>
  services.prisma.run.create({
    data: {
      noteId: input.noteId,
      arrangementId: input.arrangementId,
      userId: input.userId,
      model: input.usage.modelId,
      fullContext: '',
      response: '',
      tokensUsed: input.usage.inputTokens + input.usage.outputTokens,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cachedTokens: input.usage.cachedTokens,
    },
  });
