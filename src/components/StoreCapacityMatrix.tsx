"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";

type Item = { id: string; name: string; sub_category: string | null };
type Store = { id: string; name: string };

const key = (itemId: string, storeId: string) => `${itemId}|${storeId}`;

// Bulk-edit per-store capacity (the "full stock" par level the allocator
// fills each store up to). Rows = items, columns = stores. Only cells where
// the item is active at the store are editable — capacity is meaningless for
// inactive items and the allocator ignores it. Edits are staged locally and
// written in one batched upsert on Save, so you can re-capacity a whole grid
// at once instead of opening each store's panel one by one. The upsert only
// sends `capacity`, so it never flips `is_active`.
export default function StoreCapacityMatrix({ viewSelector }: { viewSelector?: React.ReactNode } = {}) {
  const { loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
  const [items, setItems] = useState<Item[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  // Active (item|store) pairs — only these are editable.
  const [active, setActive] = useState<Set<string>>(new Set());
  // Saved capacities, keyed item|store. Missing key = active but capacity 0.
  const [original, setOriginal] = useState<Record<string, number>>({});
  // Current edited values as strings (controlled inputs). Seeded from original.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isStoreManager) return;
    setLoading(true);
    setMessage(null);
    try {
      const [itemsRes, storesRes, siRes] = await Promise.all([
        supabase.from("items").select("id,name,sub_category").order("sub_category").order("name"),
        supabase.from("stores").select("id,name").order("name"),
        supabase.from("store_items").select("store_id,item_id,is_active,capacity"),
      ]);
      if (itemsRes.data) setItems(itemsRes.data as Item[]);
      if (storesRes.data) setStores(storesRes.data as Store[]);
      const activeSet = new Set<string>();
      const caps: Record<string, number> = {};
      const seed: Record<string, string> = {};
      for (const r of (siRes.data as Array<{
        store_id: string;
        item_id: string;
        is_active: boolean;
        capacity: number;
      }>) ?? []) {
        if (!r.is_active) continue;
        const k = key(r.item_id, r.store_id);
        activeSet.add(k);
        caps[k] = Number(r.capacity) || 0;
        seed[k] = String(caps[k]);
      }
      setActive(activeSet);
      setOriginal(caps);
      setDrafts(seed);
    } catch (err) {
      setMessage(err instanceof Error ? `Couldn't load: ${err.message}` : "Couldn't load (network timeout). Try again.");
    } finally {
      setLoading(false);
    }
  }, [isStoreManager]);

  useEffect(() => {
    load();
  }, [load]);

  const isActive = (itemId: string, storeId: string) => active.has(key(itemId, storeId));

  const setCell = (itemId: string, storeId: string, value: string) => {
    const k = key(itemId, storeId);
    setDrafts((prev) => ({ ...prev, [k]: value }));
  };

  // Apply one value to every active cell in a row (item) or column (store).
  const fillRow = (itemId: string) => {
    const v = window.prompt("Set capacity for every store carrying this item:");
    if (v == null) return;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 0) {
      setMessage("Capacity must be a whole number ≥ 0.");
      return;
    }
    setDrafts((prev) => {
      const next = { ...prev };
      for (const s of stores) {
        const k = key(itemId, s.id);
        if (active.has(k)) next[k] = String(n);
      }
      return next;
    });
  };

  const fillCol = (storeId: string) => {
    const v = window.prompt("Set capacity for every item this store carries:");
    if (v == null) return;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 0) {
      setMessage("Capacity must be a whole number ≥ 0.");
      return;
    }
    setDrafts((prev) => {
      const next = { ...prev };
      for (const it of items) {
        const k = key(it.id, storeId);
        if (active.has(k)) next[k] = String(n);
      }
      return next;
    });
  };

  // Changed, valid cells. A blank/invalid draft is ignored (not saved).
  // `changedKeys` lets the grid mark dirty cells in O(1) instead of scanning
  // the whole change list per cell (which is quadratic once you've edited a
  // few hundred cells, and was enough to lock the tab up mid-edit).
  const { changed, changedKeys } = useMemo(() => {
    const out: Array<{ item_id: string; store_id: string; capacity: number }> = [];
    const keys = new Set<string>();
    for (const k of active) {
      const raw = drafts[k];
      if (raw == null || raw.trim() === "") continue;
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0) continue;
      if (n !== (original[k] ?? 0)) {
        const [item_id, store_id] = k.split("|");
        out.push({ item_id, store_id, capacity: n });
        keys.add(k);
      }
    }
    return { changed: out, changedKeys: keys };
  }, [active, drafts, original]);

  const pending = changed.length;

  const handleSave = async () => {
    if (pending === 0) return;
    setSaving(true);
    setMessage(null);
    try {
      // Write in chunks rather than one giant upsert — a single request with
      // hundreds of rows can stall long enough to look frozen. Chunking keeps
      // each round-trip small and lets us show progress.
      const CHUNK = 100;
      for (let i = 0; i < changed.length; i += CHUNK) {
        const slice = changed.slice(i, i + CHUNK);
        const { error } = await supabase
          .from("store_items")
          .upsert(slice, { onConflict: "store_id,item_id" });
        if (error) {
          setMessage(`Saved ${i} of ${changed.length}, then failed: ${error.message}`);
          await load();
          return;
        }
        if (changed.length > CHUNK) {
          setMessage(`Saving… ${Math.min(i + CHUNK, changed.length)} / ${changed.length}`);
        }
      }
      setMessage(`Saved — ${pending} capacit${pending === 1 ? "y" : "ies"} updated.`);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? `Couldn't save: ${err.message}` : "Couldn't save (network timeout). Try again.");
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    const seed: Record<string, string> = {};
    for (const k of active) seed[k] = String(original[k] ?? 0);
    setDrafts(seed);
    setMessage(null);
  };

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-white">Store Capacity</h1>
          <p className="mt-3 text-slate-400">
            Set each store&apos;s full capacity (how many it holds when fully stocked) for every
            item it carries. Use the row / column <span className="text-cyan-300">fill</span> buttons to
            set a whole item or store at once, then Save. Only items active at a store are editable.
          </p>
        </div>
        {viewSelector}
      </div>

      {authLoading ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">Loading…</div>
      ) : !isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">Please sign in.</div>
      ) : !isStoreManager ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          This page is only available to Store Managers.
        </div>
      ) : (
        <div className="mt-8 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || pending === 0}
              className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
            >
              {saving ? "Saving…" : pending === 0 ? "No changes" : `Save ${pending} change${pending === 1 ? "" : "s"}`}
            </button>
            {pending > 0 && (
              <button type="button" onClick={discard} className="text-sm text-slate-400 hover:text-slate-200">
                Discard
              </button>
            )}
            {message && <span className="text-sm text-cyan-300">{message}</span>}
          </div>

          {loading ? (
            <p className="text-sm text-slate-400">Loading…</p>
          ) : items.length === 0 || stores.length === 0 ? (
            <p className="text-sm text-slate-500">Need at least one item and one store.</p>
          ) : (
            <div className="max-h-[70vh] overflow-auto rounded-2xl border border-white/10">
              <table className="text-sm">
                <thead>
                  <tr>
                    <th className="sticky left-0 top-0 z-30 bg-slate-950 px-3 py-2 text-left text-xs uppercase tracking-wider text-slate-400">
                      Item
                    </th>
                    {stores.map((s) => (
                      <th key={s.id} className="sticky top-0 z-20 bg-slate-950 px-3 py-2 text-center">
                        <div className="text-xs font-semibold text-slate-200">{s.name}</div>
                        <button
                          type="button"
                          onClick={() => fillCol(s.id)}
                          className="mt-1 text-[10px] text-cyan-300 hover:text-cyan-200 underline-offset-2 hover:underline"
                        >
                          fill
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {items.map((it, idx) => {
                    const prevCat = idx > 0 ? items[idx - 1].sub_category : undefined;
                    const showCat = it.sub_category && it.sub_category !== prevCat;
                    return (
                      <Fragment key={it.id}>
                        {showCat && (
                          <tr>
                            <td
                              colSpan={stores.length + 1}
                              className="bg-slate-900/60 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-slate-500"
                            >
                              {it.sub_category}
                            </td>
                          </tr>
                        )}
                        <tr className="text-slate-200">
                          <td className="sticky left-0 z-10 bg-slate-950 px-3 py-2 whitespace-nowrap">
                            <span className="font-medium">{it.name}</span>
                            <button
                              type="button"
                              onClick={() => fillRow(it.id)}
                              className="ml-2 text-[10px] text-cyan-300 hover:text-cyan-200 underline-offset-2 hover:underline"
                            >
                              fill
                            </button>
                          </td>
                          {stores.map((s) => {
                            const k = key(it.id, s.id);
                            const editable = isActive(it.id, s.id);
                            const dirty = editable && changedKeys.has(k);
                            return (
                              <td key={s.id} className="px-2 py-1 text-center">
                                {editable ? (
                                  <input
                                    type="number"
                                    min={0}
                                    step={1}
                                    inputMode="numeric"
                                    value={drafts[k] ?? ""}
                                    onChange={(e) => setCell(it.id, s.id, e.target.value)}
                                    className={`w-16 rounded-lg border bg-slate-900 px-2 py-1 text-center text-sm text-white outline-none focus:border-cyan-400 ${
                                      dirty ? "border-cyan-400" : "border-white/10"
                                    }`}
                                  />
                                ) : (
                                  <span className="text-slate-600">—</span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
