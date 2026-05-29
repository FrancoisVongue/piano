import { services } from '../../services/init';

// -----------------------------------------------------------------------------
// Note-runs controller.
//
// Thin read-only morda over the Run table, scoped to "the run that produced
// this note". Used by the frontend's Info dialog to show usage + estimated
// cost without exposing full prompt/response text (kept empty in DB for
// privacy — legacy columns).
// -----------------------------------------------------------------------------

export class NoteRunsController {
  // Latest Run row for a given note. Ownership-scoped: note must belong
  // to the caller (we filter by userId on the Run row, which is written
  // from the worker with the job's userId).
  static async latestForNote(userId: string, noteId: string) {
    return services.prisma.run.findFirst({
      where: { noteId, userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        noteId: true,
        model: true,
        inputTokens: true,
        outputTokens: true,
        cachedTokens: true,
        createdAt: true,
      },
    });
  }
}
