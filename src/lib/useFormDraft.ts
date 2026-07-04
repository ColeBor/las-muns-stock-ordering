"use client";

import { useCallback, useEffect, useRef } from "react";
import { setUnsaved } from "./unsavedGuard";

// Reusable "don't lose what I typed" primitive for the app's data-entry forms.
//
// Home-screen PWAs are resumed rather than reloaded, so a stale session can make
// a save fail and force a refresh — and a refresh (or the app's own auto-recovery
// reload) throws away whatever was in the form. This hook autosaves a form's
// typed values to localStorage and restores them on the next mount, so a
// reload/refresh mid-entry is a non-event. It also registers the form's "dirty"
// state in the shared unsavedGuard so app-level auto-reloads hold off while
// there's unsaved input.
//
// Wire-up per form (a few scalar fields):
//   useFormDraft({
//     key: "temperature-log",
//     values: { fridge, freezer, note },
//     isDirty: (v) => v.fridge !== "" || v.freezer !== "" || v.note !== "",
//     onRestore: (v) => { setFridge(v.fridge); setFreezer(v.freezer); setNote(v.note); },
//     onRestored: () => setMessage("Restored your unsaved entry."),
//   });
// Call the returned clear() after a successful submit if you don't clear the
// fields yourself (clearing them also empties the draft via the autosave effect).
//
// `values` must be JSON-serialisable. Keep `key` stable and unique per form.

type UseFormDraftOptions<T extends object> = {
  key: string;
  values: T;
  isDirty: (values: T) => boolean;
  onRestore: (values: T) => void;
  onRestored?: () => void;
  maxAgeMs?: number;
};

const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

export function useFormDraft<T extends object>(options: UseFormDraftOptions<T>): {
  clear: () => void;
} {
  const { key, values, isDirty, onRestore, onRestored, maxAgeMs = DEFAULT_MAX_AGE_MS } = options;
  const storageKey = `lasmuns.draft.${key}.v1`;

  // The restore effect runs once on mount, so it only ever needs the callbacks
  // as they were on the first render — capture them in refs (their initial value
  // is enough) to keep them out of the effect's dependency array without
  // re-running it when the parent re-creates the callbacks each render.
  const onRestoreRef = useRef(onRestore);
  const onRestoredRef = useRef(onRestored);

  const clear = useCallback(() => {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
    setUnsaved(key, false);
  }, [storageKey, key]);

  // Restore any saved draft on mount (client-only, so no hydration mismatch).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as { savedAt?: number; values?: T };
        if (
          typeof parsed.savedAt === "number" &&
          Date.now() - parsed.savedAt <= maxAgeMs &&
          parsed.values
        ) {
          onRestoreRef.current(parsed.values);
          onRestoredRef.current?.();
        } else {
          window.localStorage.removeItem(storageKey);
        }
      }
    } catch {
      // Corrupt/blocked storage — start blank.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // Autosave on change + flag dirtiness for the reload guard. Serialise once so
  // it doubles as both the persisted payload and the effect's change key.
  const dirty = isDirty(values);
  const serialised = JSON.stringify(values);
  const armed = useRef(false);
  useEffect(() => {
    // Skip the initial pass: fields are still at their defaults and the restore
    // effect's state updates haven't applied yet, so persisting now would wipe a
    // draft we just read. Restore's setState re-runs this with the real values.
    if (!armed.current) {
      armed.current = true;
      return;
    }
    setUnsaved(key, dirty);
    try {
      if (dirty) {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify({ savedAt: Date.now(), values: JSON.parse(serialised) }),
        );
      } else {
        window.localStorage.removeItem(storageKey);
      }
    } catch {
      // Storage unavailable — autosave is best-effort.
    }
  }, [key, storageKey, dirty, serialised]);

  // Clear the dirty flag when the form unmounts so it can't wedge the reload
  // guard for other pages.
  useEffect(() => {
    return () => setUnsaved(key, false);
  }, [key]);

  return { clear };
}
