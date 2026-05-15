import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { processLock } from "@supabase/auth-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// supabase-js v2's default lock is navigator.locks, which can deadlock
// across tabs (bfcached / backgrounded tabs hold the lock indefinitely
// and new loads hang forever waiting on it). A pure pass-through fixed
// the hang but introduced a separate bug — concurrent auth operations
// within a single tab raced and could clobber localStorage tokens,
// leaving fresh page mounts with a null session even though the user
// was clearly signed in (saw it on the worker log pages).
//
// processLock is the supabase-js-provided alternative: an in-memory
// mutex scoped to the current tab/process. It serialises auth
// operations within the tab (no internal races) without coordinating
// across tabs (no cross-tab deadlock). Best of both worlds for a
// small-team tool where cross-tab refresh races are negligible.

// Belt-and-suspenders for the same family of hangs: cap every outgoing
// fetch (REST queries, auth refreshes, storage uploads, …) at 20s. If
// something stalls beyond that, AbortController kicks in and the caller
// receives a rejection it can recover from instead of the UI sitting on
// Loading… / Running… forever. Honor a caller-supplied signal if there
// is one — don't double-abort.
const REQUEST_TIMEOUT_MS = 10_000;
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
        auth: { lock: processLock },
        global: { fetch: fetchWithTimeout },
      })
    : ({} as SupabaseClient);
