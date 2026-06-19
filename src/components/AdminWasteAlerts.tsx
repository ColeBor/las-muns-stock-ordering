"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

// One row per (store, day) in the last 30 days that has any countable waste.
// `is_active_alert` already folds in the cap comparison AND the resolution /
// re-arm logic — see migration 20260604120000_waste_daily_cap.sql. Reasons
// Influencer / Sample / Promotion / Owners are excluded from counted_qty by
// the view.
type WasteCapAlertRow = {
  store_id: string;
  store_name: string;
  wasted_on: string;
  counted_qty: number;
  store_cap: number | null;
  default_cap: number | null;
  effective_cap: number | null;
  last_entry_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_note: string | null;
  is_active_alert: boolean;
};

// Reasons that count toward the cap, shown to admins so the number is
// explainable. Kept in sync with the NOT IN (...) list in the view.
const EXCLUDED_REASONS = ["Influencer", "Sample", "Promotion", "Owners"];

export default function AdminWasteAlerts() {
  const { session, loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
  const [rows, setRows] = useState<WasteCapAlertRow[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Resolve form state — keyed by `${store_id}|${wasted_on}`.
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const [resolveNote, setResolveNote] = useState("");
  const [savingResolution, setSavingResolution] = useState(false);

  // Global default cap config.
  const [defaultCap, setDefaultCap] = useState<number | null>(null);
  const [defaultCapInput, setDefaultCapInput] = useState("");
  const [savingDefault, setSavingDefault] = useState(false);
  const [defaultMessage, setDefaultMessage] = useState<string | null>(null);

  const rowKey = (r: { store_id: string; wasted_on: string }) =>
    `${r.store_id}|${r.wasted_on}`;

  const loadDefault = useCallback(async () => {
    if (!isStoreManager) return;
    const { data } = await supabase
      .from("app_config")
      .select("default_daily_waste_cap")
      .eq("id", true)
      .maybeSingle();
    const cap =
      data?.default_daily_waste_cap == null ? null : Number(data.default_daily_waste_cap);
    setDefaultCap(cap);
    setDefaultCapInput(cap == null ? "" : String(cap));
  }, [isStoreManager]);

  const loadAlerts = useCallback(async () => {
    if (!isStoreManager) {
      setRows([]);
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const { data, error } = await supabase
        .from("waste_cap_alerts")
        .select(
          "store_id,store_name,wasted_on,counted_qty,store_cap,default_cap,effective_cap,last_entry_at,resolved_at,resolved_by,resolved_note,is_active_alert",
        )
        .order("wasted_on", { ascending: false })
        .order("store_name", { ascending: true });
      if (error) {
        setMessage(error.message);
        return;
      }
      setRows(
        ((data as WasteCapAlertRow[]) ?? []).map((r) => ({
          ...r,
          counted_qty: Number(r.counted_qty),
          store_cap: r.store_cap == null ? null : Number(r.store_cap),
          default_cap: r.default_cap == null ? null : Number(r.default_cap),
          effective_cap: r.effective_cap == null ? null : Number(r.effective_cap),
        })),
      );
    } catch (err) {
      setMessage(
        `Couldn't load alerts: ${
          err instanceof Error ? err.message : "network timeout"
        }. Try again.`,
      );
    } finally {
      setLoading(false);
    }
  }, [isStoreManager]);

  useEffect(() => {
    loadDefault();
  }, [loadDefault]);

  useEffect(() => {
    loadAlerts();
  }, [loadAlerts]);

  // Refetch when waste, caps, the global default, or resolutions change
  // anywhere — HQ wants cross-store visibility, so no store filter.
  useRealtimeRefetch(
    isStoreManager
      ? [
          { table: "waste_log_entries" },
          { table: "waste_cap_resolutions" },
          { table: "stores" },
          { table: "app_config" },
        ]
      : [],
    useCallback(() => {
      loadAlerts();
      loadDefault();
    }, [loadAlerts, loadDefault]),
    "admin-waste-cap-alerts",
  );

  const isBreaching = (r: WasteCapAlertRow) =>
    r.effective_cap !== null && r.counted_qty >= r.effective_cap;
  const isResolved = (r: WasteCapAlertRow) =>
    r.resolved_at !== null && !r.is_active_alert && isBreaching(r);

  const activeRows = useMemo(() => rows.filter((r) => r.is_active_alert), [rows]);
  const resolvedRows = useMemo(() => rows.filter(isResolved), [rows]);

  const visibleRows = useMemo(() => {
    if (showAll) return rows;
    return rows.filter((r) => r.is_active_alert || (showResolved && isResolved(r)));
  }, [rows, showAll, showResolved]);

  const handleSaveDefault = async () => {
    setDefaultMessage(null);
    const trimmed = defaultCapInput.trim();
    const parsed = trimmed === "" ? null : parseInt(trimmed, 10);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) {
      setDefaultMessage("Default cap must be a positive whole number, or blank to disable.");
      return;
    }
    setSavingDefault(true);
    try {
      const { error } = await supabase
        .from("app_config")
        .update({
          default_daily_waste_cap: parsed,
          updated_at: new Date().toISOString(),
          updated_by: session?.user?.email ?? session?.user?.id ?? null,
        })
        .eq("id", true);
      if (error) {
        setDefaultMessage(error.message);
        return;
      }
      setDefaultMessage("Default cap saved.");
      setDefaultCap(parsed);
      loadAlerts();
    } catch (err) {
      setDefaultMessage(
        err instanceof Error
          ? `Couldn't save: ${err.message}`
          : "Couldn't save (network timeout). Try again.",
      );
    } finally {
      setSavingDefault(false);
    }
  };

  const handleResolve = async (row: WasteCapAlertRow) => {
    setSavingResolution(true);
    setMessage(null);
    try {
      const { error } = await supabase.from("waste_cap_resolutions").upsert(
        {
          store_id: row.store_id,
          wasted_on: row.wasted_on,
          resolved_at: new Date().toISOString(),
          resolved_by: session?.user?.email ?? session?.user?.id ?? null,
          note: resolveNote.trim() || null,
        },
        { onConflict: "store_id,wasted_on" },
      );
      if (error) {
        setMessage(error.message);
        return;
      }
      setResolvingKey(null);
      setResolveNote("");
      loadAlerts();
    } catch (err) {
      setMessage(
        err instanceof Error
          ? `Couldn't resolve: ${err.message}`
          : "Couldn't resolve (network timeout). Try again.",
      );
    } finally {
      setSavingResolution(false);
    }
  };

  const handleUnresolve = async (row: WasteCapAlertRow) => {
    setMessage(null);
    const { error } = await supabase
      .from("waste_cap_resolutions")
      .delete()
      .eq("store_id", row.store_id)
      .eq("wasted_on", row.wasted_on);
    if (error) {
      setMessage(error.message);
      return;
    }
    loadAlerts();
  };

  const openResolveForm = (key: string) => {
    setResolvingKey(key);
    setResolveNote("");
    setMessage(null);
  };

  const cancelResolveForm = () => {
    setResolvingKey(null);
    setResolveNote("");
  };

  const grouped = useMemo(() => {
    const map = new Map<string, { store_name: string; rows: WasteCapAlertRow[] }>();
    for (const row of visibleRows) {
      const existing = map.get(row.store_id);
      if (existing) existing.rows.push(row);
      else map.set(row.store_id, { store_name: row.store_name, rows: [row] });
    }
    return Array.from(map.entries()).map(([store_id, value]) => ({ store_id, ...value }));
  }, [visibleRows]);

  const formatDate = (iso: string) => {
    // wasted_on is a YYYY-MM-DD date — parse as local so it doesn't shift a day.
    const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
    if (!y || !m || !d) return iso;
    return new Date(y, m - 1, d).toLocaleDateString();
  };
  const formatDateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-white">Waste Alerts</h1>
          <p className="mt-3 text-slate-400">
            A store-day is flagged when its countable waste meets or exceeds the
            store&apos;s daily cap. Deliberate give-aways{" "}
            <span className="text-slate-300">({EXCLUDED_REASONS.join(", ")})</span> don&apos;t count.
          </p>
        </div>
      </div>

      {authLoading ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Loading…</p>
        </div>
      ) : !isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in.</p>
        </div>
      ) : !isStoreManager ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to Store Managers.</p>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          {/* Global default config */}
          <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-5">
            <h2 className="text-lg font-semibold text-white">Global default cap</h2>
            <p className="mt-1 text-sm text-slate-400">
              Applies to every store that doesn&apos;t set its own cap in the Directory.
              Leave blank to turn off default alerting.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={defaultCapInput}
                onChange={(e) => setDefaultCapInput(e.target.value)}
                placeholder="No default"
                className="w-40 rounded-2xl border border-white/10 bg-slate-950 px-4 py-2.5 text-sm text-white outline-none focus:border-cyan-400"
              />
              <span className="text-sm text-slate-400">items / day</span>
              <button
                type="button"
                onClick={handleSaveDefault}
                disabled={savingDefault || defaultCapInput.trim() === (defaultCap == null ? "" : String(defaultCap))}
                className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
              >
                {savingDefault ? "Saving…" : "Save default"}
              </button>
              {defaultMessage && <span className="text-sm text-cyan-300">{defaultMessage}</span>}
            </div>
          </div>

          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="text-sm text-slate-300">
              {loading
                ? "Loading…"
                : activeRows.length === 0
                  ? `No active alerts.${resolvedRows.length ? ` ${resolvedRows.length} resolved.` : ""}`
                  : `${activeRows.length} active ${activeRows.length === 1 ? "alert" : "alerts"}${resolvedRows.length ? ` · ${resolvedRows.length} resolved` : ""}`}
            </div>
            <div className="flex items-center gap-4 flex-wrap">
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={showResolved}
                  onChange={(e) => setShowResolved(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800"
                />
                Show resolved
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(e) => setShowAll(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800"
                />
                Show all store-days with waste
              </label>
            </div>
          </div>

          {message && <p className="text-sm text-rose-300">{message}</p>}

          {grouped.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 text-slate-400">
              {showAll
                ? "No waste recorded in the last 30 days."
                : showResolved
                  ? 'No alerts. Turn on "Show all store-days with waste" to review everything.'
                  : 'No active alerts. Turn on "Show resolved" to see ones already handled.'}
            </div>
          ) : (
            <div className="space-y-6">
              {grouped.map((group) => (
                <div
                  key={group.store_id}
                  className="rounded-2xl border border-white/10 bg-slate-900/60 p-5"
                >
                  <h2 className="text-lg font-semibold text-white">{group.store_name}</h2>
                  <div className="mt-3 overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                          <th className="px-3 py-2">Date</th>
                          <th className="px-3 py-2">Waste (counted)</th>
                          <th className="px-3 py-2">Cap</th>
                          <th className="px-3 py-2">Latest entry</th>
                          <th className="px-3 py-2">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {group.rows.map((row) => {
                          const breaching = isBreaching(row);
                          const resolved = isResolved(row);
                          const active = row.is_active_alert;
                          const key = rowKey(row);
                          const resolving = resolvingKey === key;
                          return (
                            <tr key={key} className="text-slate-200">
                              <td className="px-3 py-2 whitespace-nowrap">{formatDate(row.wasted_on)}</td>
                              <td className="px-3 py-2">
                                <span className={breaching ? "font-semibold text-rose-200" : ""}>
                                  {row.counted_qty}
                                </span>
                                {row.effective_cap !== null && (
                                  <span className="text-slate-500"> / {row.effective_cap}</span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-slate-300">
                                {row.effective_cap === null ? (
                                  "—"
                                ) : (
                                  <>
                                    {row.effective_cap}
                                    <span className="ml-1 text-xs text-slate-500">
                                      {row.store_cap !== null ? "(store)" : "(default)"}
                                    </span>
                                  </>
                                )}
                              </td>
                              <td className="px-3 py-2 text-slate-400">
                                {formatDateTime(row.last_entry_at)}
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex flex-col gap-2">
                                  <div className="flex flex-wrap gap-1">
                                    {active && (
                                      <span className="inline-flex items-center whitespace-nowrap rounded-full bg-rose-500/30 px-2 py-0.5 text-xs font-semibold text-rose-200">
                                        ⚠ Over cap
                                      </span>
                                    )}
                                    {resolved && (
                                      <span className="inline-flex items-center whitespace-nowrap rounded-full bg-sky-500/20 px-2 py-0.5 text-xs font-semibold text-sky-300">
                                        ✓ Resolved
                                      </span>
                                    )}
                                    {!active && !resolved && (
                                      <span className="inline-flex items-center whitespace-nowrap rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-semibold text-emerald-300">
                                        ✓ Under cap
                                      </span>
                                    )}
                                  </div>
                                  {active && !resolving && (
                                    <button
                                      type="button"
                                      onClick={() => openResolveForm(key)}
                                      className="self-start rounded-full bg-emerald-500 px-3 py-1 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400"
                                    >
                                      Resolve
                                    </button>
                                  )}
                                  {active && resolving && (
                                    <div className="rounded-xl bg-slate-950/60 p-2 space-y-2">
                                      <input
                                        type="text"
                                        value={resolveNote}
                                        onChange={(e) => setResolveNote(e.target.value)}
                                        placeholder="What happened? (optional)"
                                        className="w-full px-2 py-1 bg-slate-800 border border-slate-600 rounded text-white text-xs"
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") handleResolve(row);
                                        }}
                                      />
                                      <div className="flex items-center gap-2">
                                        <button
                                          type="button"
                                          onClick={() => handleResolve(row)}
                                          disabled={savingResolution}
                                          className="rounded-full bg-emerald-500 px-3 py-1 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                                        >
                                          {savingResolution ? "Saving…" : "Confirm"}
                                        </button>
                                        <button
                                          type="button"
                                          onClick={cancelResolveForm}
                                          className="text-xs text-slate-400 hover:text-slate-200"
                                        >
                                          Cancel
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                  {resolved && (
                                    <div className="text-xs text-slate-400 space-y-1">
                                      <div>
                                        by {row.resolved_by ?? "—"} · {formatDateTime(row.resolved_at)}
                                      </div>
                                      {row.resolved_note && (
                                        <div className="italic">“{row.resolved_note}”</div>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => handleUnresolve(row)}
                                        className="text-cyan-300 hover:text-cyan-200 underline-offset-2 hover:underline"
                                      >
                                        Unresolve
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
