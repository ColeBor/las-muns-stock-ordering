"use client";

import { useEffect } from "react";
import { supabase } from "@/lib/supabaseClient";
import { hasUnsaved } from "@/lib/unsavedGuard";

// Keeps a long-lived Android-tablet PWA session healthy across idle and sleep —
// the exact conditions that broke it: a tablet left open a long time, or one
// that goes to sleep/idle.
//
// When a tablet sleeps (or the app sits idle), the OS FREEZES JavaScript timers,
// so the access token quietly expires and nothing refreshes it. On wake the app
// has a dead session and the next action fails. The usual "we're back" signal
// (visibilitychange) is unreliable on Android screen-off/on, so we ALSO detect
// sleep directly by watching how much wall-clock time elapsed between timer
// ticks — a big jump means the device was frozen.
//
// Recovery ladder (never over unsaved input; only reload while visible):
//   - short doze      → refresh the token in place
//   - long sleep/idle → one hard reload for a clean session + the latest bundle

const STALE_AFTER_MS = 5 * 60 * 1000; // away/asleep >= 5 min -> reload on return
const TICK_MS = 30 * 1000; // watchdog cadence
const KEEPALIVE_EVERY = 8; // ~ every 4 min while visible, proactively refresh

export default function ResumeReload() {
  // Reload when returning to the foreground after a long background. Covers the
  // app-switch case (which DOES fire visibilitychange/focus); the watchdog below
  // covers screen-off/on, which often doesn't.
  useEffect(() => {
    if (typeof document === "undefined") return;

    let hiddenAt: number | null =
      document.visibilityState === "hidden" ? Date.now() : null;

    const onResume = () => {
      if (document.visibilityState === "hidden") {
        if (hiddenAt === null) hiddenAt = Date.now();
        return;
      }
      if (hiddenAt !== null && Date.now() - hiddenAt >= STALE_AFTER_MS && !hasUnsaved()) {
        window.location.reload();
        return;
      }
      hiddenAt = null;
      // Back after a short absence — make sure the token is live for the next tap.
      void supabase.auth.getSession().catch(() => {});
    };

    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);
    return () => {
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
    };
  }, []);

  // Sleep watchdog + keep-alive, in one timer. If the wall clock jumped far past
  // the tick interval, the device was asleep/frozen (its timers stopped) —
  // recover. Otherwise, periodically refresh the token while the app is visible
  // so an idle-but-awake tablet always has a live session ready.
  useEffect(() => {
    if (typeof document === "undefined") return;

    let cancelled = false;
    let last = Date.now();
    let count = 0;

    const tick = async () => {
      if (cancelled) return;
      const now = Date.now();
      const drift = now - last;
      last = now;
      count += 1;
      const visible = document.visibilityState === "visible";

      // A jump well beyond the interval means the device slept/froze for `drift`.
      if (drift > TICK_MS * 2) {
        if (drift >= STALE_AFTER_MS && visible && !hasUnsaved()) {
          window.location.reload();
          return;
        }
        // Short doze (or hidden / mid-entry): revive the token in place.
        try {
          await supabase.auth.getSession();
        } catch {
          // Bounded by the client's fetch timeout; nothing to do here.
        }
        return;
      }

      // Normal keep-alive while visible.
      if (visible && count % KEEPALIVE_EVERY === 0) {
        try {
          await supabase.auth.getSession();
        } catch {
          // ignore
        }
      }
    };

    const timer = window.setInterval(tick, TICK_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return null;
}
