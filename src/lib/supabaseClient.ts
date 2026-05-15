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

export const supabase: SupabaseClient =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: { lock: passthroughLock },
      })
    : ({} as SupabaseClient);
