import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Default supabase-js uses navigator.locks to coordinate JWT refreshes
// across browser tabs. If a tab holds the lock and goes stale (bfcache,
// service-worker eviction, etc.) other tabs / new loads hang waiting on
// it — which is what we kept seeing: the page sits on "Loading…", going
// home and refreshing temporarily clears it. Replace the lock with a
// pass-through. Tradeoff: two tabs could in theory refresh the token at
// the same time; for a small-team internal tool that's fine.
const passthroughLock = <R>(
  _name: string,
  _acquireTimeout: number,
  fn: () => Promise<R>,
) => fn();

// Belt-and-suspenders for the same family of hangs: cap every outgoing
// fetch (REST queries, auth refreshes, storage uploads, …) at 20s. If
// something stalls beyond that, AbortController kicks in and the caller
// receives a rejection it can recover from instead of the UI sitting on
// Loading… / Running… forever. Honor a caller-supplied signal if there
// is one — don't double-abort.
const REQUEST_TIMEOUT_MS = 20_000;
const fetchWithTimeout: typeof fetch = (input, init) => {
  if (init?.signal) {
    return fetch(input, init);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() =>
    clearTimeout(timer),
  );
};

export const supabase: SupabaseClient =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: { lock: passthroughLock },
        global: { fetch: fetchWithTimeout },
      })
    : ({} as SupabaseClient);
