// Generic "tried" result used across domain DB adapters. Controllers never
// see a rejected promise — adapters translate throws into this shape.
export type Tried<T = void> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

// Wrap a prisma call so it always resolves. Adapters build on this to expose
// `tryXxx(...)` variants; controllers just branch on `r.ok` without ever
// writing try/catch themselves.
export const tryDb = async <T>(op: () => Promise<T>): Promise<Tried<T>> => {
  try {
    return { ok: true, value: await op() };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? 'db error' };
  }
};

// Idempotent delete: treats "row not found" (Prisma P2025) as success, not as
// an error. Used anywhere a client retries a delete and we don't want the
// second call to blow up just because the first one already landed.
export const idempotentDelete = async (
  op: () => Promise<unknown>,
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  try {
    await op();
    return { ok: true };
  } catch (e: any) {
    if (e?.code === 'P2025') return { ok: true };
    return { ok: false, reason: e?.message ?? 'delete failed' };
  }
};

