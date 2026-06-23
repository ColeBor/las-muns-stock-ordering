"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";

type Item = { id: string; name: string; sub_category: string | null };
type Store = { id: string; name: string };

const key = (itemId: string, storeId: string) => `${itemId}|${storeId}`;

// Bulk activate/deactivate items across stores. Rows = items, columns = stores.
// Edits are staged locally and written in two batched upserts on Save, so you
// can flip a whole grid's worth of activations at once. Re-activating an item
// preserves its existing capacity (we never send `capacity` in the upsert).
export default function StoreItemMatrix({ viewSelector }: { viewSelector?: React.ReactNode } = {}) {
  const { loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
  const [items, setItems] = useState<Item[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [original, setOriginal] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Set<string>>(new Set());
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
        supabase.from("store_items").select("store_id,item_id,is_active"),
      ]);
      if (itemsRes.data) setItems(itemsRes.data as Item[]);
      if (storesRes.data) setStores(storesRes.data as Store[]);
      const active = new Set<string>();
      for (const r of (siRes.data as Array<{ store_id: string; item_id: string; is_active: boolean }>) ?? []) {
        if (r.is_active) active.add(key(r.item_id, r.store_id));
      }
      setOriginal(active);
      setDraft(new Set(active));
    } catch (err) {
      setMessage(err instanceof Error ? `Couldn't load: ${err.message}` : "Couldn't load (network timeout). Try again.");
    } finally {
      setLoading(false);
    }
  }, [isStoreManager]);

  useEffect(() => {
    load();
  }, [load]);

  // Sort items grouped by sub_category then name (already ordered server-side).
  const sortedItems = items;

  const isActive = (itemId: string, storeId: string) => draft.has(key(itemId, storeId));

  const toggle = (itemId: string, storeId: string) => {
    setDraft((prev) => {
      const next = new Set(prev);
      const k = key(itemId, storeId);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  // Row "all": if every store is active for this item, clear them; else set all.
  const toggleRow = (itemId: string) => {
    setDraft((prev) => {
      const next = new Set(prev);
      const allOn = stores.every((s) => next.has(key(itemId, s.id)));
      for (const s of stores) {
        const k = key(itemId, s.id);
        if (allOn) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  };

  const toggleCol = (storeId: string) => {
    setDraft((prev) => {
      const next = new Set(prev);
      const allOn = sortedItems.every((it) => next.has(key(it.id, storeId)));
      for (const it of sortedItems) {
        const k = key(it.id, storeId);
        if (allOn) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  };

  const { toActivate, toDeactivate } = useMemo(() => {
    const a: string[] = [];
    const d: string[] = [];
    for (const k of draft) if (!original.has(k)) a.push(k);
    for (const k of original) if (!draft.has(k)) d.push(k);
    return { toActivate: a, toDeactivate: d };
  }, [draft, original]);
  const pending = toActivate.length + toDeactivate.length;

  const handleSave = async () => {
    if (pending === 0) return;
    setSaving(true);
    setMessage(null);
    const now = new Date().toISOString();
    const split = (k: string) => {
      const [item_id, store_id] = k.split("|");
      return { item_id, store_id };
    };
    try {
      if (toActivate.length > 0) {
        const { error } = await supabase.from("store_items").upsert(
          toActivate.map((k) => ({ ...split(k), is_active: true, activated_at: now })),
          { onConflict: "store_id,item_id" },
        );
        if (error) {
          setMessage(error.message);
          return;
        }
      }
      if (toDeactivate.length > 0) {
        const { error } = await supabase.from("store_items").upsert(
          toDeactivate.map((k) => ({ ...split(k), is_active: false, deactivated_at: now })),
          { onConflict: "store_id,item_id" },
        );
        if (error) {
          setMessage(error.message);
          return;
        }
      }
      setMessage(`Saved — ${toActivate.length} activated, ${toDeactivate.length} deactivated.`);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? `Couldn't save: ${err.message}` : "Couldn't save (network timeout). Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-white">Store Availability</h1>
          <p className="mt-3 text-slate-400">
            Tick which items are active at which store. Use the row / column toggles to
            flip a whole item or store at once, then Save.
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
              <button
                type="button"
                onClick={() => setDraft(new Set(original))}
                className="text-sm text-slate-400 hover:text-slate-200"
              >
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
            <div className="overflow-x-auto">
              <table className="text-sm">
                <thead>
                  <tr>
                    <th className="sticky left-0 z-10 bg-slate-950/90 px-3 py-2 text-left text-xs uppercase tracking-wider text-slate-400">
                      Item
                    </th>
                    {stores.map((s) => (
                      <th key={s.id} className="px-3 py-2 text-center">
                        <div className="text-xs font-semibold text-slate-200">{s.name}</div>
                        <button
                          type="button"
                          onClick={() => toggleCol(s.id)}
                          className="mt-1 text-[10px] text-cyan-300 hover:text-cyan-200 underline-offset-2 hover:underline"
                        >
                          all
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {sortedItems.map((it, idx) => {
                    const prevCat = idx > 0 ? sortedItems[idx - 1].sub_category : undefined;
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
                          <td className="sticky left-0 z-10 bg-slate-950/90 px-3 py-2 whitespace-nowrap">
                            <span className="font-medium">{it.name}</span>
                            <button
                              type="button"
                              onClick={() => toggleRow(it.id)}
                              className="ml-2 text-[10px] text-cyan-300 hover:text-cyan-200 underline-offset-2 hover:underline"
                            >
                              all
                            </button>
                          </td>
                          {stores.map((s) => (
                            <td key={s.id} className="px-3 py-2 text-center">
                              <input
                                type="checkbox"
                                checked={isActive(it.id, s.id)}
                                onChange={() => toggle(it.id, s.id)}
                                className="h-4 w-4 rounded border-slate-600 bg-slate-800"
                              />
                            </td>
                          ))}
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
