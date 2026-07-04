// Tracks whether any form currently holds unsaved user input. App-level
// auto-recovery (ResumeReload) consults this before doing a hard reload so it
// never discards what someone is halfway through typing — the reload waits
// until the form is clean (submitted or cleared).
//
// This is a plain module-level set, not React state: it's read imperatively
// from event handlers/timers that live outside the React tree, and it must be
// shared across unrelated components.
const dirtyKeys = new Set<string>();

export function setUnsaved(key: string, isDirty: boolean): void {
  if (isDirty) dirtyKeys.add(key);
  else dirtyKeys.delete(key);
}

export function hasUnsaved(): boolean {
  return dirtyKeys.size > 0;
}
