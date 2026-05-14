"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

// One row per fridge that has at least one configured target. The view runs
// with security_invoker so RLS on store_fridges / temperature_log_entries
// determines which rows the caller sees — Store Manager sees every store.
type FridgeAlertRow = {
  fridge_id: string;
  fridge_name: string;
  store_id: string;
  store_name: string;
  target_min_c: number | null;
  target_max_c: number | null;
  severe_deviation_c: number | null;
  readings_count: number;
  out_of_range_count: number;
  severe_excursion_count: number;
  latest_reading_at: string | null;
  alert_resolved_at: string | null;
  alert_resolved_by: string | null;
  alert_resolved_note: string | null;
  is_active_alert: boolean;
};

// Drift rule: 3-of-last-7 out of range. Spike rule: any single reading in
// the last 7 readings further outside targets than `severe_deviation_c`.
const DRIFT_THRESHOLD = 3;
const SPIKE_THRESHOLD = 1;

export default function AdminTemperatureAlerts() {
  const { session, loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
  const [rows, setRows] = useState<FridgeAlertRow[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolveNote, setResolveNote] = useState("");
  const [savingResolution, setSavingResolution] = useState(false);

  const loadAlerts = useCallback(async () => {
    if (!isStoreManager) {
      setRows([]);
      return;
    }
    setLoading(true);
    setMessage(null);
    const { data, error } = await supabase
      .from("fridge_alerts")
      .select(
        "fridge_id,fridge_name,store_id,store_name,target_min_c,target_max_c,severe_deviation_c,readings_count,out_of_range_count,severe_excursion_count,latest_reading_at,alert_resolved_at,alert_resolved_by,alert_resolved_note,is_active_alert",
      )
      .order("store_name", { ascending: true })
      .order("fridge_name", { ascending: true });
    setLoading(false);
    if (error) {
      setMessage(error.message);
      return;
    }
    setRows(
      ((data as FridgeAlertRow[]) ?? []).map((r) => ({
        ...r,
        target_min_c: r.target_min_c === null ? null : Number(r.target_min_c),
        target_max_c: r.target_max_c === null ? null : Number(r.target_max_c),
        severe_deviation_c:
          r.severe_deviation_c === null ? null : Number(r.severe_deviation_c),
        readings_count: Number(r.readings_count),
        out_of_range_count: Number(r.out_of_range_count),
        severe_excursion_count: Number(r.severe_excursion_count),
      })),
    );
  }, [isStoreManager]);

  useEffect(() => {
    loadAlerts();
  }, [loadAlerts]);

  // Refetch when readings or fridge configs change anywhere. We don't filter
  // by store here — HQ wants cross-store visibility, and the alerts view
  // aggregates everything.
  useRealtimeRefetch(
    isStoreManager
      ? [
          { table: "temperature_log_entries" },
          { table: "store_fridges" },
        ]
      : [],
    loadAlerts,
    `admin-temp-alerts`,
  );

  const isDrifting = (r: FridgeAlertRow) => r.out_of_range_count >= DRIFT_THRESHOLD;
  const isSpiking = (r: FridgeAlertRow) =>
    r.severe_deviation_c !== null && r.severe_excursion_count >= SPIKE_THRESHOLD;
  const isFlagging = (r: FridgeAlertRow) => isDrifting(r) || isSpiking(r);
  const isResolved = (r: FridgeAlertRow) =>
    r.alert_resolved_at !== null && !r.is_active_alert && isFlagging(r);

  const activeRows = useMemo(() => rows.filter((r) => r.is_active_alert), [rows]);
  const resolvedRows = useMemo(() => rows.filter(isResolved), [rows]);

  const visibleRows = useMemo(() => {
    if (showAll) return rows;
    return rows.filter((r) => r.is_active_alert || (showResolved && isResolved(r)));
  }, [rows, showAll, showResolved]);

  const handleResolve = async (fridgeId: string) => {
    setSavingResolution(true);
    setMessage(null);
    const { error } = await supabase
      .from("store_fridges")
      .update({
        alert_resolved_at: new Date().toISOString(),
        alert_resolved_by: session?.user?.email ?? session?.user?.id ?? null,
        alert_resolved_note: resolveNote.trim() || null,
      })
      .eq("id", fridgeId);
    setSavingResolution(false);
    if (error) {
      setMessage(error.message);
      return;
    }
    setResolvingId(null);
    setResolveNote("");
    loadAlerts();
  };

  const handleUnresolve = async (fridgeId: string) => {
    setMessage(null);
    const { error } = await supabase
      .from("store_fridges")
      .update({
        alert_resolved_at: null,
        alert_resolved_by: null,
        alert_resolved_note: null,
      })
      .eq("id", fridgeId);
    if (error) {
      setMessage(error.message);
      return;
    }
    loadAlerts();
  };

  const openResolveForm = (fridgeId: string) => {
    setResolvingId(fridgeId);
    setResolveNote("");
    setMessage(null);
  };

  const cancelResolveForm = () => {
    setResolvingId(null);
    setResolveNote("");
  };

  const grouped = useMemo(() => {
    const map = new Map<string, { store_name: string; rows: FridgeAlertRow[] }>();
    for (const row of visibleRows) {
      const existing = map.get(row.store_id);
      if (existing) {
        existing.rows.push(row);
      } else {
        map.set(row.store_id, { store_name: row.store_name, rows: [row] });
      }
    }
    return Array.from(map.entries()).map(([store_id, value]) => ({
      store_id,
      ...value,
    }));
  }, [visibleRows]);

  const formatTarget = (row: FridgeAlertRow): string => {
    if (row.target_min_c !== null && row.target_max_c !== null) {
      return `${row.target_min_c}°C – ${row.target_max_c}°C`;
    }
    if (row.target_min_c !== null) return `≥ ${row.target_min_c}°C`;
    if (row.target_max_c !== null) return `≤ ${row.target_max_c}°C`;
    return "—";
  };

  const formatDateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-white">Temperature Alerts</h1>
          <p className="mt-3 text-slate-400">
            All store fridges and freezers. A fridge is flagged for
            <span className="text-rose-300"> Drift</span> if {DRIFT_THRESHOLD} of the last 7 readings are out of range, or
            <span className="text-rose-400 font-semibold"> Spike</span> if any single reading is way off.
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
                Show all fridges with targets
              </label>
            </div>
          </div>

          {message && <p className="text-sm text-rose-300">{message}</p>}

          {grouped.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 text-slate-400">
              {showAll
                ? "No fridges with targets set up yet."
                : showResolved
                  ? "No alerts. Turn on \"Show all fridges with targets\" to review every fridge."
                  : "No active alerts. Turn on \"Show resolved\" to see ones already handled."}
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
                          <th className="px-3 py-2">Fridge</th>
                          <th className="px-3 py-2">Target</th>
                          <th className="px-3 py-2">Spike threshold</th>
                          <th className="px-3 py-2">Out of range</th>
                          <th className="px-3 py-2">Spikes</th>
                          <th className="px-3 py-2">Latest reading</th>
                          <th className="px-3 py-2">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {group.rows.map((row) => {
                          const drifting = isDrifting(row);
                          const spiking = isSpiking(row);
                          const flagging = drifting || spiking;
                          const resolved = isResolved(row);
                          const active = row.is_active_alert;
                          const resolving = resolvingId === row.fridge_id;
                          return (
                            <tr key={row.fridge_id} className="text-slate-200">
                              <td className="px-3 py-2 font-medium">{row.fridge_name}</td>
                              <td className="px-3 py-2 text-slate-300">{formatTarget(row)}</td>
                              <td className="px-3 py-2 text-slate-300">
                                {row.severe_deviation_c === null
                                  ? "—"
                                  : `> ${row.severe_deviation_c}°C`}
                              </td>
                              <td className="px-3 py-2">
                                {row.out_of_range_count} / {row.readings_count}
                              </td>
                              <td className="px-3 py-2">
                                {row.severe_deviation_c === null
                                  ? "—"
                                  : `${row.severe_excursion_count} / ${row.readings_count}`}
                              </td>
                              <td className="px-3 py-2 text-slate-400">
                                {formatDateTime(row.latest_reading_at)}
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex flex-col gap-2">
                                  <div className="flex flex-wrap gap-1">
                                    {active && spiking && (
                                      <span className="inline-flex items-center whitespace-nowrap rounded-full bg-rose-500/30 px-2 py-0.5 text-xs font-semibold text-rose-200">
                                        ⚠ Spike
                                      </span>
                                    )}
                                    {active && drifting && (
                                      <span className="inline-flex items-center whitespace-nowrap rounded-full bg-rose-500/20 px-2 py-0.5 text-xs font-semibold text-rose-300">
                                        ⚠ Drift
                                      </span>
                                    )}
                                    {resolved && (
                                      <span className="inline-flex items-center whitespace-nowrap rounded-full bg-sky-500/20 px-2 py-0.5 text-xs font-semibold text-sky-300">
                                        ✓ Resolved
                                      </span>
                                    )}
                                    {!flagging && row.readings_count === 0 && (
                                      <span className="inline-flex items-center whitespace-nowrap rounded-full bg-slate-700/40 px-2 py-0.5 text-xs font-semibold text-slate-300">
                                        No data
                                      </span>
                                    )}
                                    {!flagging && row.readings_count > 0 && (
                                      <span className="inline-flex items-center whitespace-nowrap rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-semibold text-emerald-300">
                                        ✓ OK
                                      </span>
                                    )}
                                  </div>
                                  {active && !resolving && (
                                    <button
                                      type="button"
                                      onClick={() => openResolveForm(row.fridge_id)}
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
                                        placeholder="What did you do? (optional)"
                                        className="w-full px-2 py-1 bg-slate-800 border border-slate-600 rounded text-white text-xs"
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") handleResolve(row.fridge_id);
                                        }}
                                      />
                                      <div className="flex items-center gap-2">
                                        <button
                                          type="button"
                                          onClick={() => handleResolve(row.fridge_id)}
                                          disabled={savingResolution}
                                          className="rounded-full bg-emerald-500 px-3 py-1 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                                        >
                                          {savingResolution ? "Saving..." : "Confirm"}
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
                                        by {row.alert_resolved_by ?? "—"} ·{" "}
                                        {formatDateTime(row.alert_resolved_at)}
                                      </div>
                                      {row.alert_resolved_note && (
                                        <div className="italic">“{row.alert_resolved_note}”</div>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => handleUnresolve(row.fridge_id)}
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
