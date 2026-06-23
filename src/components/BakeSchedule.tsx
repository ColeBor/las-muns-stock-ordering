"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

type Store = { id: string; name: string };
type BakeItem = { item_id: string; name: string };
type ExpectedRow = { item_id: string; day_of_week: number; expected_qty: number };

function todayIso() {
  const now = new Date();
  const tzOffsetMs = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - tzOffsetMs).toISOString().slice(0, 10);
}

function tomorrowIso() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const tzOffsetMs = d.getTimezoneOffset() * 60 * 1000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 10);
}

function dayOfWeekFromIso(iso: string): number {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return 0;
  return new Date(y, m - 1, d).getDay();
}

function formatDate(iso: string) {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function BakeSchedule() {
  const { session, profile, loading: authLoading, isSignedIn, isStoreManager, isEmployee } = useAuthGate();
  const [store, setStore] = useState<Store | null>(null);
  const [allStores, setAllStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState("");
  const [items, setItems] = useState<BakeItem[]>([]);
  const [expected, setExpected] = useState<ExpectedRow[]>([]);
  // End-of-day "had to bake extra today" — checkbox state + what's already
  // recorded for today, so re-submitting just syncs the difference.
  const [bakeMoreChecked, setBakeMoreChecked] = useState<Record<string, boolean>>({});
  const [recordedToday, setRecordedToday] = useState<Set<string>>(new Set());
  const [savingBakeMore, setSavingBakeMore] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // The closing shift always bakes for the NEXT day, so the counts shown are
  // tomorrow's. Not editable — this is purely "what to bake tonight/morning".
  const bakeForDate = tomorrowIso();
  const today = todayIso();

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
      const { data } = await supabase.from("stores").select("id,name").eq("id", effectiveStoreId).single();
      if (data) setStore(data as Store);
    };
    loadStore();
  }, [effectiveStoreId]);

  const loadItems = useCallback(async () => {
    if (!effectiveStoreId) {
      setItems([]);
      return;
    }
    const { data, error } = await supabase
      .from("store_items")
      .select("item_id, items!inner(name, sub_category)")
      .eq("store_id", effectiveStoreId)
      .eq("is_active", true)
      .eq("items.sub_category", "Empanada");
    if (error) {
      setMessage(`Couldn't load items: ${error.message}`);
      setItems([]);
      return;
    }
    const mapped = ((data ?? []) as unknown as Array<{ item_id: string; items: { name: string } }>)
      .map((row) => ({ item_id: row.item_id, name: row.items?.name ?? row.item_id }))
      .sort((a, b) => a.name.localeCompare(b.name));
    setItems(mapped);
  }, [effectiveStoreId]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const loadExpected = useCallback(async () => {
    if (!effectiveStoreId) {
      setExpected([]);
      return;
    }
    const { data, error } = await supabase
      .from("bake_expected_sales")
      .select("item_id,day_of_week,expected_qty")
      .eq("store_id", effectiveStoreId);
    if (error) {
      setMessage(`Couldn't load bake counts: ${error.message}`);
      setExpected([]);
      return;
    }
    setExpected(
      ((data as ExpectedRow[]) ?? []).map((r) => ({
        ...r,
        expected_qty: Number(r.expected_qty),
        day_of_week: Number(r.day_of_week),
      })),
    );
  }, [effectiveStoreId]);

  useEffect(() => {
    loadExpected();
  }, [loadExpected]);

  const loadSignals = useCallback(async () => {
    if (!effectiveStoreId) {
      setRecordedToday(new Set());
      setBakeMoreChecked({});
      return;
    }
    const { data, error } = await supabase
      .from("bake_more_signals")
      .select("item_id")
      .eq("store_id", effectiveStoreId)
      .eq("signal_date", today);
    if (error) {
      // Non-fatal — the prompt just starts empty.
      return;
    }
    const ids = new Set<string>((data as Array<{ item_id: string }>).map((r) => r.item_id));
    setRecordedToday(ids);
    setBakeMoreChecked(Object.fromEntries([...ids].map((id) => [id, true])));
  }, [effectiveStoreId, today]);

  useEffect(() => {
    loadSignals();
  }, [loadSignals]);

  useRealtimeRefetch(
    effectiveStoreId
      ? [
          { table: "bake_expected_sales", filter: `store_id=eq.${effectiveStoreId}` },
          { table: "store_items", filter: `store_id=eq.${effectiveStoreId}` },
          { table: "items" },
        ]
      : [],
    useCallback(() => {
      loadExpected();
      loadItems();
    }, [loadExpected, loadItems]),
    `bake-schedule-${effectiveStoreId}`,
  );

  const dayOfWeek = useMemo(() => dayOfWeekFromIso(bakeForDate), [bakeForDate]);

  const countByItem = useMemo(() => {
    const map: Record<string, number> = {};
    for (const e of expected) {
      if (e.day_of_week === dayOfWeek) map[e.item_id] = e.expected_qty;
    }
    return map;
  }, [expected, dayOfWeek]);

  const handleSubmitBakeMore = async () => {
    if (!effectiveStoreId) return;
    setSavingBakeMore(true);
    setMessage(null);
    try {
      const checkedIds = items.filter((it) => bakeMoreChecked[it.item_id]).map((it) => it.item_id);
      const toAdd = checkedIds.filter((id) => !recordedToday.has(id));
      const toRemove = [...recordedToday].filter((id) => !checkedIds.includes(id));

      if (toAdd.length > 0) {
        const { error } = await supabase.from("bake_more_signals").upsert(
          toAdd.map((item_id) => ({
            store_id: effectiveStoreId,
            item_id,
            signal_date: today,
            recorded_by: session?.user?.email ?? session?.user?.id ?? null,
          })),
          { onConflict: "store_id,item_id,signal_date" },
        );
        if (error) {
          setMessage(error.message);
          return;
        }
      }
      if (toRemove.length > 0) {
        const { error } = await supabase
          .from("bake_more_signals")
          .delete()
          .eq("store_id", effectiveStoreId)
          .eq("signal_date", today)
          .in("item_id", toRemove);
        if (error) {
          setMessage(error.message);
          return;
        }
      }
      setRecordedToday(new Set(checkedIds));
      setMessage(
        checkedIds.length === 0
          ? "Thanks — noted that nothing ran short today."
          : "Thanks — your closing notes were saved.",
      );
    } catch (err) {
      setMessage(`Couldn't save: ${err instanceof Error ? err.message : "network timeout"}. Try again.`);
    } finally {
      setSavingBakeMore(false);
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-white">Bake Schedule</h1>
          <p className="mt-3 text-slate-400">
            How many of each Empanada to bake for <strong>{formatDate(bakeForDate)}</strong>.
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
          <p>Please sign in.</p>
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
          <p>Pick a store:</p>
          <select
            value={selectedStoreId}
            onChange={(event) => setSelectedStoreId(event.target.value)}
            className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm"
          >
            <option value="">(Select a store)</option>
            {allStores.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <h2 className="text-xl font-semibold text-white">{store?.name || "Loading..."}</h2>
            {isStoreManager && (
              <div className="flex items-center gap-3 flex-wrap">
                <label htmlFor="store" className="text-sm font-medium text-slate-300">Store:</label>
                <select
                  id="store"
                  value={selectedStoreId}
                  onChange={(e) => setSelectedStoreId(e.target.value)}
                  className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm"
                >
                  {allStores.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          {canManage && (
            <>
              {items.length === 0 ? (
                <p className="text-sm text-slate-400">
                  No Empanadas are set up for this store yet. Ask a Store Manager to add them.
                </p>
              ) : (
                <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-3 overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                        <th className="px-3 py-2">Item</th>
                        <th className="px-3 py-2 text-right">Bake</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {items.map((item) => (
                        <tr key={item.item_id} className="text-slate-200">
                          <td className="px-3 py-2 font-medium">{item.name}</td>
                          <td className="px-3 py-2 text-right text-lg font-semibold tabular-nums">
                            {countByItem[item.item_id] ?? 0}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* End-of-day closing note: did anything run short today? */}
              {items.length > 0 && (
                <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-5">
                  <h2 className="text-lg font-semibold text-white">End of day</h2>
                  <p className="mt-1 text-sm text-slate-400">
                    Did you have to bake <strong>extra</strong> of any flavour today (you ran short)?
                    Tick them — no amounts needed. This helps managers fine-tune the counts.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {items.map((item) => {
                      const on = !!bakeMoreChecked[item.item_id];
                      return (
                        <button
                          key={item.item_id}
                          type="button"
                          onClick={() =>
                            setBakeMoreChecked((prev) => ({ ...prev, [item.item_id]: !prev[item.item_id] }))
                          }
                          className={`rounded-full px-3 py-1.5 text-sm font-semibold transition ${
                            on
                              ? "bg-amber-500 text-slate-950 hover:bg-amber-400"
                              : "bg-slate-800 text-slate-200 hover:bg-slate-700"
                          }`}
                        >
                          {on ? "✓ " : ""}
                          {item.name}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={handleSubmitBakeMore}
                    disabled={savingBakeMore}
                    className="mt-4 rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
                  >
                    {savingBakeMore ? "Saving…" : "Save closing notes"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
