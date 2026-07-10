// Races a promise (typically a Supabase call) against a deadline so a stalled
// request can't hang a "Saving…" state forever. On timeout the returned promise
// REJECTS, so the caller's try/catch/finally runs and the UI recovers. The
// underlying request may keep going in the background — we just stop waiting.
export function withTimeout<T>(
  work: PromiseLike<T>,
  label = "Operation",
  ms = 20_000,
): Promise<T> {
  return Promise.race([
    Promise.resolve(work),
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out — check your connection and try again`)),
        ms,
      ),
    ),
  ]);
}
