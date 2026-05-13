// Postgres `date` columns come back as "YYYY-MM-DD" strings. JS's
// `new Date("YYYY-MM-DD")` parses as UTC midnight, then toLocaleDateString
// converts to local time, shifting the displayed date back by one day in
// any timezone west of UTC. These helpers parse as LOCAL midnight so the
// displayed date matches what's stored in the DB.

export function parseLocalDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  // Tolerate full ISO timestamps and date-only strings alike. For
  // "YYYY-MM-DD", append T00:00:00 so it parses as local midnight.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  return new Date(dateOnly ? `${s}T00:00:00` : s);
}

export function formatLocalDate(
  s: string | null | undefined,
  fallback = "",
): string {
  const d = parseLocalDate(s);
  return d ? d.toLocaleDateString() : fallback;
}
