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
// fetch (REST queries, storage uploads, …) at 10s. If something stalls
// beyond that, AbortController kicks in and the caller receives a rejection
// it can recover from instead of the UI sitting on Loading… / Running…
// forever. Honor a caller-supplied signal if there is one — don't double-abort.
//
// AUTH requests (/auth/v1/* — getSession, token refresh) get a much longer
// cap. When the app resumes from background on mobile, the radio is cold and
// that first refresh can legitimately take >10s; aborting it dropped the
// session and bounced the user to the login screen even though they were
// signed in. The auth gate's own 4s/5s safety timers still keep the UI from
// hanging, so the longer cap here can't cause an infinite spinner — it just
// lets a slow-but-valid refresh finish.
const REQUEST_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 30_000;
// Storage uploads (photos) legitimately take longer, so give them more room —
// but still a hard cap so a stalled upload can't hang forever.
const STORAGE_TIMEOUT_MS = 60_000;
const urlOf = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
const fetchWithTimeout: typeof fetch = (input, init) => {
  const url = urlOf(input);
  const timeout = url.includes("/auth/v1/")
    ? AUTH_TIMEOUT_MS
    : url.includes("/storage/v1/")
      ? STORAGE_TIMEOUT_MS
      : REQUEST_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException("Request timed out", "TimeoutError")),
    timeout,
  );
  // ALWAYS enforce the timeout — even when supabase-js supplies its own signal
  // (auth refreshes and storage uploads do). Previously we bailed out and used
  // the caller's signal alone; a hung auth refresh then held the auth lock
  // forever and wedged every later request (the perma-saving / stuck-loading /
  // photos-won't-save everyone kept hitting). Combine both signals so whichever
  // aborts first wins: a request can never outlive the timeout, so the auth
  // lock is always released and the app self-heals instead of freezing.
  const caller = init?.signal;
  if (caller) {
    if (caller.aborted) ctrl.abort(caller.reason);
    else caller.addEventListener("abort", () => ctrl.abort(caller.reason), { once: true });
  }
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
};

export const supabase: SupabaseClient =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: { lock: processLock },
        global: { fetch: fetchWithTimeout },
      })
    : ({} as SupabaseClient);
