"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

type Store = { id: string; name: string };

type BakeItem = { item_id: string; name: string };

type ExpectedRow = {
  store_id: string;
  item_id: string;
  day_of_week: number; // 0=Sun..6=Sat
  expected_qty: number;
};

// Matches JS Date.getDay(): 0=Sun..6=Sat. Display order in the grid is
// Mon..Sun to match how a store thinks about a week.
const DAYS: Array<{ value: number; short: string; long: string }> = [
  { value: 1, short: "Mon", long: "Monday" },
  { value: 2, short: "Tue", long: "Tuesday" },
  { value: 3, short: "Wed", long: "Wednesday" },
  { value: 4, short: "Thu", long: "Thursday" },
  { value: 5, short: "Fri", long: "Friday" },
  { value: 6, short: "Sat", long: "Saturday" },
  { value: 0, short: "Sun", long: "Sunday" },
];

export default function AdminBakeExpected() {
  const { loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState("");
  const [items, setItems] = useState<BakeItem[]>([]);
  const [rows, setRows] = useState<ExpectedRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isStoreManager) return;
    const loadStores = async () => {
      const { data } = await supabase.from("stores").select("id,name").order("name");
      if (data) setStores(data as Store[]);
    };
    loadStores();
  }, [isStoreManager]);

  // Empanada items active at the selected store. Bake schedule is empanada-
  // only for now; if HQ later wants Desserts in there, change this filter
  // (or move it to a per-item is_baked flag).
  const loadItems = useCallback(async () => {
    if (!selectedStoreId) {
      setItems([]);
      return;
    }
    const { data, error } = await supabase
      .from("store_items")
      .select("item_id, items!inner(name, sub_category)")
      .eq("store_id", selectedStoreId)
      .eq("is_active", true)
      .eq("items.sub_category", "Empanada");
    if (error) {
      setMessage(`Couldn't load items: ${error.message}`);
      setItems([]);
      return;
    }
    const mapped = ((data ?? []) as unknown as Array<{
      item_id: string;
      items: { name: string };
    }>)
      .map((row) => ({ item_id: row.item_id, name: row.items?.name ?? row.item_id }))
      .sort((a, b) => a.name.localeCompare(b.name));
    setItems(mapped);
  }, [selectedStoreId]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const loadRows = useCallback(async () => {
    if (!selectedStoreId) {
      setRows([]);
      return;
    }
    const { data, error } = await supabase
      .from("bake_expected_sales")
      .select("store_id,item_id,day_of_week,expected_qty")
      .eq("store_id", selectedStoreId);
    if (error) {
      setMessage(`Couldn't load expected sales: ${error.message}`);
      setRows([]);
      return;
    }
    setRows(((data as ExpectedRow[]) ?? []).map((r) => ({ ...r, expected_qty: Number(r.expected_qty) })));
  }, [selectedStoreId]);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  useRealtimeRefetch(
    selectedStoreId
      ? [
          { table: "bake_expected_sales", filter: `store_id=eq.${selectedStoreId}` },
          { table: "store_items", filter: `store_id=eq.${selectedStoreId}` },
          { table: "items" },
        ]
      : [],
    useCallback(() => {
      loadRows();
      loadItems();
    }, [loadRows, loadItems]),
    `admin-bake-expected-${selectedStoreId}`,
  );

  const cellKey = (item_id: string, day_of_week: number) => `${item_id}::${day_of_week}`;

  const valueMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const r of rows) map[cellKey(r.item_id, r.day_of_week)] = r.expected_qty;
    return map;
  }, [rows]);

  const handleCellSave = async (item_id: string, day_of_week: number) => {
    if (!selectedStoreId) return;
    const key = cellKey(item_id, day_of_week);
    const raw = drafts[key];
    const current = valueMap[key] ?? 0;
    if (raw === undefined) return; // no edit pending
    const parsed = raw.trim() === "" ? 0 : Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
      setMessage("Expected qty must be a non-negative integer.");
      return;
    }
    if (parsed === current) {
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    setSavingKey(key);
    setMessage(null);
    const { error } = await supabase.from("bake_expected_sales").upsert(
      [
        {
          store_id: selectedStoreId,
          item_id,
          day_of_week,
          expected_qty: parsed,
        },
      ],
      { onConflict: "store_id,item_id,day_of_week" },
    );
    setSavingKey(null);
    if (error) {
      setMessage(error.message);
      return;
    }
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    loadRows();
  };

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-white">Bake Count</h1>
          <p className="mt-3 text-slate-400">
            Set how many of each Empanada we expect to sell per day of the week, per store. The nightly bake form uses this to compute suggestions. Will be replaced by live POS data once that's wired up.
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
          <div className="flex items-center gap-2 flex-wrap">
            <label htmlFor="store" className="text-sm font-medium text-slate-300">Store:</label>
            <select
              id="store"
              value={selectedStoreId}
              onChange={(e) => setSelectedStoreId(e.target.value)}
              className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm"
            >
              <option value="">(Select a store)</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          {!selectedStoreId ? (
            <p className="text-sm text-slate-400">Pick a store to edit its expected sales.</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-slate-400">
              No Empanadas are active at this store yet. Activate them via the Items admin page.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-white/10 bg-slate-900/60 p-3">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                    <th className="px-3 py-2">Item</th>
                    {DAYS.map((d) => (
                      <th key={d.value} className="px-3 py-2 text-center" title={d.long}>
                        {d.short}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {items.map((item) => (
                    <tr key={item.item_id} className="text-slate-200">
                      <td className="px-3 py-2 font-medium">{item.name}</td>
                      {DAYS.map((d) => {
                        const key = cellKey(item.item_id, d.value);
                        const persisted = valueMap[key] ?? 0;
                        const draft = drafts[key];
                        const displayValue = draft ?? String(persisted);
                        const saving = savingKey === key;
                        return (
                          <td key={d.value} className="px-2 py-1 text-center">
                            <input
                              type="number"
                              min="0"
                              step="1"
                              inputMode="numeric"
                              value={displayValue}
                              onChange={(e) =>
                                setDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                              }
                              onBlur={() => handleCellSave(item.item_id, d.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  (e.target as HTMLInputElement).blur();
                                }
                              }}
                              disabled={saving}
                              className={`w-16 rounded border bg-slate-950 px-2 py-1 text-center text-sm text-white outline-none ${
                                draft !== undefined
                                  ? "border-cyan-400"
                                  : "border-slate-700"
                              }`}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-slate-500">
                Edits save when you tab out of a cell or press Enter. Cyan border = unsaved changes.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
