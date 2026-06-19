"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

type Store = {
  id: string;
  name: string;
};

type Fridge = {
  id: string;
  store_id: string;
  name: string;
  kind: "fridge" | "freezer";
  // Effective thresholds, injected from the global temperature_targets for
  // this unit's kind at load time (thresholds are no longer per-unit).
  target_min_c: number | null;
  target_max_c: number | null;
  severe_deviation_c: number | null;
  created_at: string;
};

type ReadingStatus = "in" | "out" | "severe" | "unknown";

function readingStatus(
  temperature_c: number,
  fridge: {
    target_min_c: number | null;
    target_max_c: number | null;
    severe_deviation_c: number | null;
  },
): ReadingStatus {
  if (fridge.target_min_c === null && fridge.target_max_c === null) return "unknown";
  const overshootMin =
    fridge.target_min_c !== null ? fridge.target_min_c - temperature_c : -Infinity;
  const overshootMax =
    fridge.target_max_c !== null ? temperature_c - fridge.target_max_c : -Infinity;
  const overshoot = Math.max(overshootMin, overshootMax);
  if (overshoot <= 0) return "in";
  if (fridge.severe_deviation_c !== null && overshoot > fridge.severe_deviation_c) {
    return "severe";
  }
  return "out";
}

function statusTextClass(status: ReadingStatus | null): string {
  if (status === "severe") return "text-rose-400 font-semibold";
  if (status === "out") return "text-rose-300";
  if (status === "in") return "text-emerald-300";
  return "text-slate-400";
}

function formatTargetRange(fridge: {
  target_min_c: number | null;
  target_max_c: number | null;
}): string {
  const { target_min_c: min, target_max_c: max } = fridge;
  if (min === null && max === null) return "Target: not set";
  if (min !== null && max !== null) return `Target: ${min}°C – ${max}°C`;
  if (min !== null) return `Target: ≥ ${min}°C`;
  return `Target: ≤ ${max}°C`;
}

type TemperatureEntry = {
  id: string;
  store_id: string;
  fridge_id: string;
  temperature_c: number;
  recorded_at: string;
  recorded_by: string | null;
  notes: string | null;
};

export default function TemperatureLog() {
  const { session, profile, loading: authLoading, isSignedIn, isStoreManager, isEmployee } = useAuthGate();
  const [store, setStore] = useState<Store | null>(null);
  const [allStores, setAllStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState("");
  const [fridges, setFridges] = useState<Fridge[]>([]);
  const [entries, setEntries] = useState<TemperatureEntry[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [newFridgeName, setNewFridgeName] = useState("");
  const [savingFridge, setSavingFridge] = useState(false);
  const [draftTemps, setDraftTemps] = useState<Record<string, string>>({});
  const [draftNotes, setDraftNotes] = useState<Record<string, string>>({});
  const [savingFridgeId, setSavingFridgeId] = useState<string | null>(null);
  const [newFridgeKind, setNewFridgeKind] = useState<"fridge" | "freezer">("fridge");
  const [savingKindId, setSavingKindId] = useState<string | null>(null);
  const [deletingFridgeId, setDeletingFridgeId] = useState<string | null>(null);

  const hasAssignedStore = useMemo(() => !!profile?.store_id, [profile]);
  const effectiveStoreId = useMemo(
    () => (isStoreManager ? selectedStoreId || null : profile?.store_id ?? null),
    [isStoreManager, selectedStoreId, profile?.store_id],
  );
  const canManage = (isEmployee && hasAssignedStore) || (isStoreManager && !!effectiveStoreId);

  useEffect(() => {
    if (!isStoreManager) return;
    const loadStores = async () => {
      const { data } = await supabase.from("stores").select("id,name").order("name");
      if (data) setAllStores(data as Store[]);
    };
    loadStores();
  }, [isStoreManager]);

  useEffect(() => {
    if (!effectiveStoreId) {
      setStore(null);
      return;
    }
    const loadStore = async () => {
      const { data } = await supabase
        .from("stores")
        .select("id,name")
        .eq("id", effectiveStoreId)
        .single();
      if (data) setStore(data as Store);
    };
    loadStore();
  }, [effectiveStoreId]);

  const loadFridges = useCallback(async () => {
    if (!effectiveStoreId) {
      setFridges([]);
      return;
    }
    const [fridgesRes, targetsRes] = await Promise.all([
      supabase
        .from("store_fridges")
        .select("id,store_id,name,kind,created_at")
        .eq("store_id", effectiveStoreId)
        .order("name"),
      supabase
        .from("temperature_targets")
        .select("kind,target_min_c,target_max_c,severe_deviation_c"),
    ]);
    if (fridgesRes.error) {
      setMessage(`Couldn't load fridges: ${fridgesRes.error.message}`);
      setFridges([]);
      return;
    }
    // Standard thresholds per kind (global), injected into each unit so the
    // status / range helpers keep working off `fridge.target_*`.
    const byKind: Record<string, { min: number | null; max: number | null; severe: number | null }> = {};
    for (const t of (targetsRes.data as Array<{
      kind: string;
      target_min_c: number | null;
      target_max_c: number | null;
      severe_deviation_c: number | null;
    }>) ?? []) {
      byKind[t.kind] = {
        min: t.target_min_c === null ? null : Number(t.target_min_c),
        max: t.target_max_c === null ? null : Number(t.target_max_c),
        severe: t.severe_deviation_c === null ? null : Number(t.severe_deviation_c),
      };
    }
    setFridges(
      ((fridgesRes.data as Array<{
        id: string;
        store_id: string;
        name: string;
        kind: "fridge" | "freezer";
        created_at: string;
      }>) ?? []).map((f) => {
        const t = byKind[f.kind] ?? { min: null, max: null, severe: null };
        return {
          ...f,
          target_min_c: t.min,
          target_max_c: t.max,
          severe_deviation_c: t.severe,
        };
      }),
    );
  }, [effectiveStoreId]);

  useEffect(() => {
    loadFridges();
  }, [loadFridges]);

  // Pull the last 14 days of readings for this store. Keeps the history
  // table useful for week-over-week review without dragging the whole table
  // over the wire.
  const loadEntries = useCallback(async () => {
    if (!effectiveStoreId) {
      setEntries([]);
      return;
    }
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);
    const { data, error } = await supabase
      .from("temperature_log_entries")
      .select("id,store_id,fridge_id,temperature_c,recorded_at,recorded_by,notes")
      .eq("store_id", effectiveStoreId)
      .gte("recorded_at", cutoff.toISOString())
      .order("recorded_at", { ascending: false });
    if (error) {
      setMessage(`Couldn't load readings: ${error.message}`);
      setEntries([]);
      return;
    }
    if (data) {
      setEntries(
        (data as TemperatureEntry[]).map((e) => ({
          ...e,
          temperature_c: Number(e.temperature_c),
        })),
      );
    }
  }, [effectiveStoreId]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  useRealtimeRefetch(
    effectiveStoreId
      ? [
          { table: "store_fridges", filter: `store_id=eq.${effectiveStoreId}` },
          { table: "temperature_log_entries", filter: `store_id=eq.${effectiveStoreId}` },
          { table: "temperature_targets" },
        ]
      : [],
    useCallback(() => {
      loadFridges();
      loadEntries();
    }, [loadFridges, loadEntries]),
    `temp-log-${effectiveStoreId}`,
  );

  const handleAddFridge = async () => {
    if (!effectiveStoreId || !newFridgeName.trim()) return;
    const trimmed = newFridgeName.trim();
    setSavingFridge(true);
    setMessage(null);
    try {
      const { error } = await supabase
        .from("store_fridges")
        .insert([{ store_id: effectiveStoreId, name: trimmed, kind: newFridgeKind }]);
      if (error) {
        // Postgres unique_violation — friendly message instead of the raw
        // "duplicate key value violates unique constraint ..." string.
        if (error.code === "23505") {
          setMessage(`A fridge named "${trimmed}" already exists in this store.`);
        } else {
          setMessage(error.message);
        }
        return;
      }
      setNewFridgeName("");
      setMessage("Fridge added.");
      loadFridges();
    } catch (err) {
      setMessage(
        err instanceof Error
          ? `Couldn't add fridge: ${err.message}`
          : "Couldn't add fridge (network timeout). Try again.",
      );
    } finally {
      setSavingFridge(false);
    }
  };

  const handleRecord = async (fridgeId: string) => {
    if (!effectiveStoreId) return;
    const raw = draftTemps[fridgeId];
    if (raw === undefined || raw === "") {
      setMessage("Enter a temperature first.");
      return;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      setMessage("Temperature must be a number.");
      return;
    }
    setSavingFridgeId(fridgeId);
    setMessage(null);
    const note = draftNotes[fridgeId]?.trim() || null;
    try {
      const { error } = await supabase.from("temperature_log_entries").insert([
        {
          store_id: effectiveStoreId,
          fridge_id: fridgeId,
          temperature_c: value,
          recorded_by: session?.user?.email ?? session?.user?.id ?? null,
          notes: note,
        },
      ]);
      if (error) {
        setMessage(error.message);
        return;
      }
      setDraftTemps((prev) => ({ ...prev, [fridgeId]: "" }));
      setDraftNotes((prev) => ({ ...prev, [fridgeId]: "" }));
      setMessage("Reading saved.");
      loadEntries();
    } catch (err) {
      setMessage(
        err instanceof Error
          ? `Couldn't save reading: ${err.message}`
          : "Couldn't save reading (network timeout). Try again.",
      );
    } finally {
      setSavingFridgeId(null);
    }
  };

  // Reclassify a unit as fridge or freezer. Thresholds follow the kind
  // (set globally in the Temperature Alerts admin), so this is the only
  // per-unit temperature setting now.
  const handleSetKind = async (fridgeId: string, kind: "fridge" | "freezer") => {
    setSavingKindId(fridgeId);
    setMessage(null);
    try {
      const { error } = await supabase
        .from("store_fridges")
        .update({ kind })
        .eq("id", fridgeId);
      if (error) {
        setMessage(error.message);
        return;
      }
      loadFridges();
    } catch (err) {
      setMessage(
        err instanceof Error
          ? `Couldn't update type: ${err.message}`
          : "Couldn't update type (network timeout). Try again.",
      );
    } finally {
      setSavingKindId(null);
    }
  };

  // Remove a fridge/freezer entirely. Its temperature_log_entries cascade-
  // delete with it (FK on delete cascade), so this also clears that unit's
  // reading history.
  const handleDeleteFridge = async (fridge: Fridge) => {
    if (
      !confirm(
        `Delete "${fridge.name}"? This removes the unit and all of its recorded temperature readings. This can't be undone.`,
      )
    ) {
      return;
    }
    setDeletingFridgeId(fridge.id);
    setMessage(null);
    try {
      const { error } = await supabase.from("store_fridges").delete().eq("id", fridge.id);
      if (error) {
        setMessage(error.message);
        return;
      }
      setMessage(`"${fridge.name}" deleted.`);
      loadFridges();
      loadEntries();
    } catch (err) {
      setMessage(
        err instanceof Error
          ? `Couldn't delete: ${err.message}`
          : "Couldn't delete (network timeout). Try again.",
      );
    } finally {
      setDeletingFridgeId(null);
    }
  };

  const handleDeleteEntry = async (entryId: string) => {
    setMessage(null);
    const { error } = await supabase.from("temperature_log_entries").delete().eq("id", entryId);
    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage("Reading deleted.");
    loadEntries();
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  const latestByFridge = useMemo(() => {
    const map: Record<string, TemperatureEntry> = {};
    for (const entry of entries) {
      const existing = map[entry.fridge_id];
      if (!existing || new Date(entry.recorded_at) > new Date(existing.recorded_at)) {
        map[entry.fridge_id] = entry;
      }
    }
    return map;
  }, [entries]);

  const fridgeNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const f of fridges) map[f.id] = f.name;
    return map;
  }, [fridges]);

  const fridgeById = useMemo(() => {
    const map: Record<string, Fridge> = {};
    for (const f of fridges) map[f.id] = f;
    return map;
  }, [fridges]);

  const formatDateTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString();
  };

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-white">Temperature Log</h1>
          <p className="mt-3 text-slate-400">
            Log fridge and freezer temperatures every day. Each reading saves automatically.
          </p>
        </div>
        {isSignedIn && (
          <button
            type="button"
            onClick={handleSignOut}
            className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-slate-200"
          >
            Sign out
          </button>
        )}
      </div>

      {authLoading ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Loading…</p>
        </div>
      ) : !isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in to access this page.</p>
        </div>
      ) : !isEmployee && !isStoreManager ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to Employees and Store Managers.</p>
        </div>
      ) : isEmployee && !hasAssignedStore ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>You are not assigned to a store. Please contact an administrator.</p>
        </div>
      ) : isStoreManager && !selectedStoreId ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300 space-y-3">
          <p>Pick a store to manage:</p>
          <select
            value={selectedStoreId}
            onChange={(event) => setSelectedStoreId(event.target.value)}
            className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm"
          >
            <option value="">(Select a store)</option>
            {allStores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="mt-8 space-y-8">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <h2 className="text-xl font-semibold text-white">{store?.name || "Loading..."}</h2>
            {isStoreManager && (
              <div className="flex items-center gap-2">
                <label htmlFor="store" className="text-sm font-medium text-slate-300">
                  Store:
                </label>
                <select
                  id="store"
                  value={selectedStoreId}
                  onChange={(event) => setSelectedStoreId(event.target.value)}
                  className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm"
                >
                  {allStores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          {canManage && (
            <>
              {isStoreManager && (
                <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6">
                  <h3 className="text-lg font-semibold text-white">Fridges</h3>
                  <p className="mt-1 text-sm text-slate-400">
                    Add each fridge or freezer here and pick its type. Thresholds are
                    standardized per type — set them in Temperature Alerts.
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={newFridgeName}
                      onChange={(e) => setNewFridgeName(e.target.value)}
                      placeholder="e.g. Walk-in fridge"
                      className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm flex-1 min-w-[200px]"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleAddFridge();
                      }}
                    />
                    <select
                      value={newFridgeKind}
                      onChange={(e) => setNewFridgeKind(e.target.value as "fridge" | "freezer")}
                      className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm"
                    >
                      <option value="fridge">Fridge</option>
                      <option value="freezer">Freezer</option>
                    </select>
                    <button
                      type="button"
                      onClick={handleAddFridge}
                      disabled={savingFridge || !newFridgeName.trim()}
                      className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                    >
                      {savingFridge ? "Adding..." : "Add fridge"}
                    </button>
                  </div>
                </div>
              )}

              {fridges.length === 0 ? (
                <p className="text-sm text-slate-400">
                  {isStoreManager
                    ? "No fridges yet. Add one above to start logging."
                    : "No fridges set up yet. Ask a Store Manager to configure this store."}
                </p>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  {fridges.map((fridge) => {
                    const latest = latestByFridge[fridge.id];
                    const status = latest ? readingStatus(latest.temperature_c, fridge) : null;
                    return (
                      <div
                        key={fridge.id}
                        className="rounded-2xl border border-white/10 bg-slate-900/60 p-5"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <h4 className="text-base font-semibold text-white">{fridge.name}</h4>
                          {latest ? (
                            <span className={`text-xs ${statusTextClass(status)}`}>
                              Last: {latest.temperature_c}°C · {formatDateTime(latest.recorded_at)}
                              {status === "severe" && (
                                <> · <span className="whitespace-nowrap">⚠ severe spike</span></>
                              )}
                              {status === "out" && (
                                <> · <span className="whitespace-nowrap">⚠ out of range</span></>
                              )}
                              {status === "in" && " · ✓"}
                            </span>
                          ) : (
                            <span className="text-xs text-slate-500">No readings yet</span>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                          <span className="inline-flex items-center rounded-full bg-slate-800 px-2 py-0.5 font-semibold text-slate-200">
                            {fridge.kind === "freezer" ? "❄️ Freezer" : "🧊 Fridge"}
                          </span>
                          <span>{formatTargetRange(fridge)}</span>
                          {fridge.severe_deviation_c !== null && (
                            <span>· Spike if &gt; {fridge.severe_deviation_c}°C out</span>
                          )}
                          {fridge.target_min_c === null && fridge.target_max_c === null && (
                            <span className="text-amber-300">· standard not set</span>
                          )}
                        </div>
                        {isStoreManager && (
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                            <span>Type:</span>
                            {(["fridge", "freezer"] as const).map((k) => (
                              <button
                                key={k}
                                type="button"
                                onClick={() => handleSetKind(fridge.id, k)}
                                disabled={savingKindId === fridge.id || fridge.kind === k}
                                className={`rounded-full px-3 py-1 font-semibold transition disabled:cursor-default ${
                                  fridge.kind === k
                                    ? "bg-cyan-500 text-slate-950"
                                    : "bg-slate-800 text-slate-200 hover:bg-slate-700"
                                }`}
                              >
                                {k === "freezer" ? "Freezer" : "Fridge"}
                              </button>
                            ))}
                            <button
                              type="button"
                              onClick={() => handleDeleteFridge(fridge)}
                              disabled={deletingFridgeId === fridge.id}
                              className="ml-auto text-rose-300 hover:text-rose-200 underline-offset-2 hover:underline disabled:opacity-50"
                            >
                              {deletingFridgeId === fridge.id ? "Deleting…" : "Delete"}
                            </button>
                          </div>
                        )}
                        <div className="mt-4 flex flex-wrap items-center gap-2">
                          <input
                            type="number"
                            step="0.1"
                            inputMode="decimal"
                            value={draftTemps[fridge.id] ?? ""}
                            onChange={(e) =>
                              setDraftTemps((prev) => ({ ...prev, [fridge.id]: e.target.value }))
                            }
                            placeholder="°C"
                            className="w-24 px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm"
                          />
                          <input
                            type="text"
                            value={draftNotes[fridge.id] ?? ""}
                            onChange={(e) =>
                              setDraftNotes((prev) => ({ ...prev, [fridge.id]: e.target.value }))
                            }
                            placeholder="Notes (optional)"
                            className="flex-1 min-w-[140px] px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm"
                          />
                          <button
                            type="button"
                            onClick={() => handleRecord(fridge.id)}
                            disabled={savingFridgeId === fridge.id || !draftTemps[fridge.id]}
                            className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
                          >
                            {savingFridgeId === fridge.id ? "Saving..." : "Record"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6">
                <h3 className="text-lg font-semibold text-white">Recent readings</h3>
                <p className="mt-1 text-sm text-slate-400">Last 14 days, most recent first.</p>
                {entries.length === 0 ? (
                  <p className="mt-4 text-sm text-slate-500">No readings in the last 14 days.</p>
                ) : (
                  <div className="mt-4 overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                          <th className="px-3 py-2">When</th>
                          <th className="px-3 py-2">Fridge</th>
                          <th className="px-3 py-2">Temp (°C)</th>
                          <th className="px-3 py-2">By</th>
                          <th className="px-3 py-2">Notes</th>
                          <th className="px-3 py-2"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {entries.map((entry) => {
                          const fridge = fridgeById[entry.fridge_id];
                          const status = fridge ? readingStatus(entry.temperature_c, fridge) : null;
                          return (
                            <tr key={entry.id} className="text-slate-200">
                              <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(entry.recorded_at)}</td>
                              <td className="px-3 py-2">{fridgeNameById[entry.fridge_id] ?? "—"}</td>
                              <td className={`px-3 py-2 ${statusTextClass(status)}`}>
                                {entry.temperature_c}
                                {status === "severe" && " ⚠⚠"}
                                {status === "out" && " ⚠"}
                              </td>
                              <td className="px-3 py-2 text-slate-400">{entry.recorded_by ?? "—"}</td>
                              <td className="px-3 py-2 text-slate-400">{entry.notes ?? ""}</td>
                              <td className="px-3 py-2 text-right">
                                <button
                                  type="button"
                                  onClick={() => handleDeleteEntry(entry.id)}
                                  className="text-xs text-rose-300 hover:text-rose-200"
                                >
                                  Delete
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
