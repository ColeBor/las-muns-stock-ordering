"use client";

import { useEffect } from "react";
import { supabase } from "@/lib/supabaseClient";
import { hasUnsaved } from "@/lib/unsavedGuard";

// Keeps a long-lived PWA session healthy. Two distinct staleness modes bite this
// app, and each needs its own remedy.
//
// 1. RESUMED AFTER BACKGROUND. Installed to the home screen, the app is resumed
//    rather than reloaded, so after a long spell in the background it keeps the
//    exact JS bundle and in-memory Supabase session it held when last
//    foregrounded. Both go stale: the access token expires and its background
//    refresh can wedge (throttled timers + a held processLock), surfacing as
//    spurious "Please sign in" screens and requests — e.g. a waste-photo upload
//    — that hang forever; and the code misses any deploy shipped meanwhile.
//    useAuthGate revalidates on resume, which is enough for a brief background,
//    but past a threshold the only reliable recovery is one hard reload: it
//    re-fetches the current bundle and re-bootstraps auth from storage with no
//    wedged locks. To the user it just looks like the app refreshing on return.
//
// 2. LEFT OPEN BUT IDLE. A device left on a page (screen on, untouched — e.g. a
//    store tablet) never fires visibilitychange, so #1 never triggers, yet the
//    access token still ages out and supabase-js's own refresh can be throttled
//    or wedged. The next action then fires with a dead token and hangs. While
//    the page is visible we proactively refresh the session on a timer so a live
//    token is always ready. This never reloads — it must be safe to run while
//    someone is mid-entry — so it can only ever keep the session alive, not
//    discard work.
const STALE_AFTER_MS = 10 * 60 * 1000; // hidden ≥ 10 min → reload on return
const KEEPALIVE_MS = 4 * 60 * 1000; // refresh the session every 4 min while visible

export default function ResumeReload() {
  // Mode 1: reload when returning to the foreground after a long background.
  useEffect(() => {
    if (typeof document === "undefined") return;

    let hiddenAt: number | null =
      document.visibilityState === "hidden" ? Date.now() : null;

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        // Remember when we went away; only stamp the first hide of a streak.
        if (hiddenAt === null) hiddenAt = Date.now();
        return;
      }
      // Back in the foreground. Reload only if we were gone long enough that the
      // session/bundle is likely stale — quick app-switches fall through and are
      // handled by useAuthGate's lightweight revalidate instead. Never reload
      // over unsaved input: hold off and let the keep-alive refresh below revive
      // the session in place, so a half-finished entry is not thrown away.
      if (hiddenAt !== null && Date.now() - hiddenAt >= STALE_AFTER_MS && !hasUnsaved()) {
        window.location.reload();
        return;
      }
      hiddenAt = null;
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Mode 2: keep the token fresh while the app sits open and visible. Purely
  // additive — it refreshes and never reloads, so it is safe to fire at any
  // moment, including mid-entry.
  useEffect(() => {
    if (typeof document === "undefined") return;

    let cancelled = false;

    const tick = async () => {
      if (cancelled || document.visibilityState !== "visible") return;
      try {
        // getSession() returns the stored session and refreshes it if expired, so
        // an idle-but-open tab keeps a valid access token ready for the next call.
        await supabase.auth.getSession();
      } catch {
        // Swallow — the auth gate's own safety timers and the client's fetch
        // timeouts still keep the UI from hanging.
      }
    };

    const timer = window.setInterval(tick, KEEPALIVE_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
