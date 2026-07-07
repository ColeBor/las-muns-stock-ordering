"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import { useFormDraft } from "@/lib/useFormDraft";

type Factory = { id: string; name: string };

// Frozen-box tracing is for Empanadas and Desserts only — same set as the
// store box trace.
const TRACED_SUB_CATEGORIES = ["Empanada", "Dessert"];

type TraceItem = {
  item_id: string;
  name: string;
  sub_category: string | null;
};

type FreezerTraceEntry = {
  id: string;
  factory_id: string;
  item_id: string;
  finished_on: string; // date the box left the freezer
  box_prepared_on: string; // date stamped on the box
  recorded_by: string | null;
  created_at: string;
};

function todayIso() {
  const now = new Date();
  const tzOffsetMs = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - tzOffsetMs).toISOString().slice(0, 10);
}

function ymd(d: Date): string {
  const tzOffsetMs = d.getTimezoneOffset() * 60 * 1000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 10);
}

const MONTHS = [
  { value: 1, label: "January" },
  { value: 2, label: "February" },
  { value: 3, label: "March" },
  { value: 4, label: "April" },
  { value: 5, label: "May" },
  { value: 6, label: "June" },
  { value: 7, label: "July" },
  { value: 8, label: "August" },
  { value: 9, label: "September" },
  { value: 10, label: "October" },
  { value: 11, label: "November" },
  { value: 12, label: "December" },
];

function formatDate(iso: string) {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString();
}

export default function FreezerBoxTraceLog() {
  const { session, profile, loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
  const isFactoryWorker = profile?.role === "factory_worker";
  const [factory, setFactory] = useState<Factory | null>(null);
  const [allFactories, setAllFactories] = useState<Factory[]>([]);
  const [selectedFactoryId, setSelectedFactoryId] = useState("");
  const [items, setItems] = useState<TraceItem[]>([]);
  const [entries, setEntries] = useState<FreezerTraceEntry[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Form state
  const [finishedOn, setFinishedOn] = useState<string>(todayIso());
  const [itemId, setItemId] = useState<string>("");
  const [boxPreparedOn, setBoxPreparedOn] = useState<string>("");

  useFormDraft({
    key: "freezer-trace",
    values: { finishedOn, itemId, boxPreparedOn },
    isDirty: (v) => !!v.itemId,
    onRestore: (v) => {
      if (v.finishedOn) setFinishedOn(v.finishedOn);
      if (v.itemId) setItemId(v.itemId);
      if (v.boxPreparedOn) setBoxPreparedOn(v.boxPreparedOn);
    },
    onRestored: () => setMessage("Restored your unsaved entry."),
  });

  const _today = new Date();
  const [filterYear, setFilterYear] = useState<number>(_today.getFullYear());
  const [filterMonth, setFilterMonth] = useState<number>(_today.getMonth() + 1);

  const hasAssignedFactory = useMemo(() => !!profile?.factory_id, [profile]);
  const effectiveFactoryId = useMemo(
    () => (isStoreManager ? selectedFactoryId || null : profile?.factory_id ?? null),
    [isStoreManager, selectedFactoryId, profile?.factory_id],
  );
  const canManage = (isFactoryWorker && hasAssignedFactory) || (isStoreManager && !!effectiveFactoryId);

  useEffect(() => {
    if (!isStoreManager) return;
    const loadFactories = async () => {
      const { data } = await supabase.from("factories").select("id,name").order("name");
      if (data) setAllFactories(data as Factory[]);
    };
    loadFactories();
  }, [isStoreManager]);

  useEffect(() => {
    if (!effectiveFactoryId) {
      setFactory(null);
      return;
    }
    const loadFactory = async () => {
      const { data } = await supabase
        .from("factories")
        .select("id,name")
        .eq("id", effectiveFactoryId)
        .single();
      if (data) setFactory(data as Factory);
    };
    loadFactory();
  }, [effectiveFactoryId]);

  // The factory bakes all Empanadas/Desserts, so the traceable list is simply
  // every item in those categories (not scoped to a store's activation).
  const loadItems = useCallback(async () => {
    const { data, error } = await supabase
      .from("items")
      .select("id,name,sub_category")
      .in("sub_category", TRACED_SUB_CATEGORIES)
      .order("name");
    if (error) {
      setMessage(`Couldn't load items: ${error.message}`);
      setItems([]);
      return;
    }
    const mapped = ((data ?? []) as Array<{ id: string; name: string; sub_category: string | null }>).map(
      (row) => ({ item_id: row.id, name: row.name, sub_category: row.sub_category }),
    );
    setItems(mapped);
  }, []);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const loadEntries = useCallback(async () => {
    if (!effectiveFactoryId) {
      setEntries([]);
      return;
    }
    const { data, error } = await supabase
      .from("freezer_trace_entries")
      .select("id,factory_id,item_id,finished_on,box_prepared_on,recorded_by,created_at")
      .eq("factory_id", effectiveFactoryId)
      .order("finished_on", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) {
      setMessage(`Couldn't load history: ${error.message}`);
      setEntries([]);
      return;
    }
    setEntries((data as FreezerTraceEntry[]) ?? []);
  }, [effectiveFactoryId]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  useRealtimeRefetch(
    effectiveFactoryId
      ? [
          { table: "freezer_trace_entries", filter: `factory_id=eq.${effectiveFactoryId}` },
          { table: "items" },
        ]
      : [],
    useCallback(() => {
      loadEntries();
      loadItems();
    }, [loadEntries, loadItems]),
    `freezer-trace-${effectiveFactoryId}`,
  );

  const itemNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const i of items) map[i.item_id] = i.name;
    return map;
  }, [items]);

  const activeRange = useMemo(() => {
    const start = new Date(filterYear, filterMonth - 1, 1);
    const end = new Date(filterYear, filterMonth, 0);
    return { start: ymd(start), end: ymd(end) };
  }, [filterYear, filterMonth]);

  const visibleEntries = useMemo(
    () => entries.filter((e) => e.finished_on >= activeRange.start && e.finished_on <= activeRange.end),
    [entries, activeRange],
  );

  const yearOptions = useMemo(() => {
    const years = new Set<number>();
    years.add(_today.getFullYear());
    for (const e of entries) {
      const y = parseInt(e.finished_on.slice(0, 4), 10);
      if (!Number.isNaN(y)) years.add(y);
    }
    years.add(filterYear);
    return Array.from(years).sort((a, b) => b - a);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, filterYear]);

  const resetForm = () => {
    setItemId("");
    setBoxPreparedOn("");
  };

  const handleSubmit = async () => {
    if (!effectiveFactoryId) return;
    if (!itemId) {
      setMessage("Pick an item.");
      return;
    }
    if (!finishedOn) {
      setMessage("Pick a finished date.");
      return;
    }
    if (!boxPreparedOn) {
      setMessage("Enter the date stamped on the box.");
      return;
    }
    if (boxPreparedOn > finishedOn) {
      setMessage("Box prepared date can't be after the finished date.");
      return;
    }

    setSaving(true);
    setMessage(null);
    const payload = {
      factory_id: effectiveFactoryId,
      item_id: itemId,
      finished_on: finishedOn,
      box_prepared_on: boxPreparedOn,
      recorded_by: session?.user?.email ?? session?.user?.id ?? null,
    };
    try {
      const { error } = await supabase.from("freezer_trace_entries").insert([payload]);
      if (error) {
        setMessage(error.message);
        return;
      }
      setMessage("Box logged — factory stock decremented.");
      resetForm();
      loadEntries();
    } catch (err) {
      setMessage(
        err instanceof Error
          ? `Couldn't log box: ${err.message}`
          : "Couldn't log box (network timeout). Try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteEntry = async (entryId: string) => {
    setMessage(null);
    const { error } = await supabase.from("freezer_trace_entries").delete().eq("id", entryId);
    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage("Entry deleted — box refunded to factory stock.");
    loadEntries();
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-white">Freezer Box Trace</h1>
          <p className="mt-3 text-slate-400">
            Log every box as it leaves the freezer. Each one deducts from factory stock and
            traces which batch shipped when.
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
      ) : !isFactoryWorker && !isStoreManager ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to Factory Workers and Store Managers.</p>
        </div>
      ) : isFactoryWorker && !hasAssignedFactory ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>You are not assigned to a factory. Please contact an administrator.</p>
        </div>
      ) : isStoreManager && !selectedFactoryId ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300 space-y-3">
          <p>Pick a factory to manage:</p>
          <select
            value={selectedFactoryId}
            onChange={(event) => setSelectedFactoryId(event.target.value)}
            className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm"
          >
            <option value="">(Select a factory)</option>
            {allFactories.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="mt-8 space-y-8">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <h2 className="text-xl font-semibold text-white">{factory?.name || "Loading..."}</h2>
            {isStoreManager && (
              <div className="flex items-center gap-2">
                <label htmlFor="factory" className="text-sm font-medium text-slate-300">
                  Factory:
                </label>
                <select
                  id="factory"
                  value={selectedFactoryId}
                  onChange={(event) => setSelectedFactoryId(event.target.value)}
                  className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm"
                >
                  {allFactories.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          {canManage && (
            <>
              <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6 space-y-4">
                <h3 className="text-lg font-semibold text-white">Log Box Out Of Freezer</h3>
                {items.length === 0 ? (
                  <p className="text-sm text-slate-400">No traceable items set up yet.</p>
                ) : (
                  <>
                    <div className="grid gap-4 sm:grid-cols-3">
                      <div>
                        <label htmlFor="finished-on" className="block text-sm font-medium text-slate-300">
                          Today&apos;s Date
                        </label>
                        <input
                          id="finished-on"
                          type="date"
                          value={finishedOn}
                          onChange={(e) => setFinishedOn(e.target.value)}
                          onClick={(e) => e.currentTarget.showPicker?.()}
                          max={todayIso()}
                          className="mt-1 w-full cursor-pointer rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                        />
                        <p className="mt-1 text-xs text-slate-500">Defaults to today. Change if logging late.</p>
                      </div>
                      <div>
                        <label htmlFor="item" className="block text-sm font-medium text-slate-300">
                          Item
                        </label>
                        <select
                          id="item"
                          value={itemId}
                          onChange={(e) => setItemId(e.target.value)}
                          className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                        >
                          <option value="">(Select an item)</option>
                          {items.map((i) => (
                            <option key={i.item_id} value={i.item_id}>
                              {i.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor="box-prepared" className="block text-sm font-medium text-slate-300">
                          Date On The Box
                        </label>
                        <input
                          id="box-prepared"
                          type="date"
                          value={boxPreparedOn}
                          onChange={(e) => setBoxPreparedOn(e.target.value)}
                          onClick={(e) => e.currentTarget.showPicker?.()}
                          max={finishedOn}
                          className="mt-1 w-full cursor-pointer rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                        />
                        <p className="mt-1 text-xs text-slate-500">Preparation date stamped on the box.</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleSubmit}
                        disabled={saving}
                        className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
                      >
                        {saving ? "Saving..." : "Log Box"}
                      </button>
                    </div>
                  </>
                )}
              </div>

              <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-6">
                <div className="flex items-end justify-between flex-wrap gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-white">Box History</h3>
                    <p className="mt-1 text-sm text-slate-400">
                      {formatDate(activeRange.start)} – {formatDate(activeRange.end)}.{" "}
                      {visibleEntries.length} {visibleEntries.length === 1 ? "entry" : "entries"}.
                    </p>
                  </div>
                  <div className="flex items-end gap-2">
                    <div>
                      <label htmlFor="filter-month" className="block text-xs font-medium text-slate-400">
                        Month
                      </label>
                      <select
                        id="filter-month"
                        value={filterMonth}
                        onChange={(e) => setFilterMonth(parseInt(e.target.value, 10))}
                        className="mt-1 rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                      >
                        {MONTHS.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="filter-year" className="block text-xs font-medium text-slate-400">
                        Year
                      </label>
                      <select
                        id="filter-year"
                        value={filterYear}
                        onChange={(e) => setFilterYear(parseInt(e.target.value, 10))}
                        className="mt-1 rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                      >
                        {yearOptions.map((y) => (
                          <option key={y} value={y}>
                            {y}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
                {entries.length === 0 ? (
                  <p className="mt-4 text-sm text-slate-500">No boxes logged yet.</p>
                ) : visibleEntries.length === 0 ? (
                  <p className="mt-4 text-sm text-slate-500">No boxes logged in this month.</p>
                ) : (
                  <div className="mt-4 overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                          <th className="px-3 py-2">Finished</th>
                          <th className="px-3 py-2">Item</th>
                          <th className="px-3 py-2">Box Prepared</th>
                          <th className="px-3 py-2">By</th>
                          <th className="px-3 py-2"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {visibleEntries.map((entry) => (
                          <tr key={entry.id} className="text-slate-200">
                            <td className="px-3 py-2 whitespace-nowrap">{formatDate(entry.finished_on)}</td>
                            <td className="px-3 py-2">{itemNameById[entry.item_id] ?? entry.item_id}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{formatDate(entry.box_prepared_on)}</td>
                            <td className="px-3 py-2 text-slate-400">{entry.recorded_by ?? "—"}</td>
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
                        ))}
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
