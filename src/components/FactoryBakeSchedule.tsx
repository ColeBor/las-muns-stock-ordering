"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { formatLocalDate } from "@/lib/dateOnly";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

const EMPANADAS_PER_BOX = 30;

type Item = { id: string; name: string };
type Ingredient = { id: string; name: string; unit: string; on_hand_qty: number };
type RecipeLine = { item_id: string; ingredient_id: string; qty_per_batch: number };
type BakeLine = { planned_qty: number; baked_qty: number };
type Cycle = { id: string; status: string; order_date: string };

export default function FactoryBakeSchedule() {
  const { profile, loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
  const isFactoryWorker = profile?.role === "factory_worker";
  const canManage = isFactoryWorker || isStoreManager;

  const [items, setItems] = useState<Item[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [batchByItem, setBatchByItem] = useState<Record<string, number>>({});
  const [recipeByItem, setRecipeByItem] = useState<Record<string, RecipeLine[]>>({});
  const [bakeByItem, setBakeByItem] = useState<Record<string, BakeLine>>({});
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [selectedCycleId, setSelectedCycleId] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const [plannedDrafts, setPlannedDrafts] = useState<Record<string, string>>({});
  const [confirmDrafts, setConfirmDrafts] = useState<Record<string, string>>({});
  const [savingItemId, setSavingItemId] = useState<string | null>(null);
  const [confirmingItemId, setConfirmingItemId] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  const load = useCallback(async () => {
    if (!canManage) return;
    const [itemsRes, ingRes, recRes, lineRes, bakeRes, activeRes, deliveredRes] = await Promise.all([
      supabase.from("items").select("id,name").eq("type", "manufactured").order("name"),
      supabase.from("ingredients").select("id,name,unit,on_hand_qty").order("name"),
      supabase.from("item_recipes").select("item_id,batch_size"),
      supabase.from("recipe_ingredients").select("item_id,ingredient_id,qty_per_batch"),
      supabase.from("factory_bake_lines").select("item_id,planned_qty,baked_qty"),
      supabase.from("order_cycles").select("id,status,order_date").neq("status", "delivered").order("created_at", { ascending: false }),
      supabase.from("order_cycles").select("id,status,order_date").eq("status", "delivered").order("created_at", { ascending: false }).limit(2),
    ]);
    if (itemsRes.data) setItems(itemsRes.data as Item[]);
    if (ingRes.data)
      setIngredients(
        (ingRes.data as Ingredient[]).map((i) => ({ ...i, on_hand_qty: Number(i.on_hand_qty) })),
      );
    if (recRes.data) {
      const m: Record<string, number> = {};
      for (const r of recRes.data as Array<{ item_id: string; batch_size: number }>) m[r.item_id] = Number(r.batch_size);
      setBatchByItem(m);
    }
    if (lineRes.data) {
      const m: Record<string, RecipeLine[]> = {};
      for (const l of lineRes.data as RecipeLine[]) (m[l.item_id] ??= []).push({ ...l, qty_per_batch: Number(l.qty_per_batch) });
      setRecipeByItem(m);
    }
    if (bakeRes.data) {
      const m: Record<string, BakeLine> = {};
      for (const b of bakeRes.data as Array<{ item_id: string; planned_qty: number; baked_qty: number }>)
        m[b.item_id] = { planned_qty: Number(b.planned_qty), baked_qty: Number(b.baked_qty) };
      setBakeByItem(m);
    }
    const cyc = [...((activeRes.data as Cycle[]) ?? []), ...((deliveredRes.data as Cycle[]) ?? [])];
    setCycles(cyc);
  }, [canManage]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (cycles.length > 0 && !selectedCycleId) setSelectedCycleId(cycles[0].id);
  }, [cycles, selectedCycleId]);

  useRealtimeRefetch(
    canManage
      ? [
          { table: "factory_bake_lines" },
          { table: "ingredients" },
          { table: "item_recipes" },
          { table: "recipe_ingredients" },
          { table: "allocations" },
        ]
      : [],
    load,
    "factory-bake-schedule",
  );

  // Items that can be baked = manufactured items that have a recipe (batch size).
  const bakeable = useMemo(
    () => items.filter((it) => batchByItem[it.id] !== undefined),
    [items, batchByItem],
  );

  const remainingOf = (itemId: string) => {
    const b = bakeByItem[itemId];
    return Math.max(0, (b?.planned_qty ?? 0) - (b?.baked_qty ?? 0));
  };

  // Grocery list: ingredients needed for the REMAINING boxes (batch-rounded per
  // item), vs current on-hand → what to buy.
  const grocery = useMemo(() => {
    const need = new Map<string, number>();
    for (const it of bakeable) {
      const batch = batchByItem[it.id];
      const remaining = remainingOf(it.id);
      if (remaining <= 0) continue;
      const batches = Math.ceil(remaining / batch);
      for (const rl of recipeByItem[it.id] ?? []) {
        need.set(rl.ingredient_id, (need.get(rl.ingredient_id) ?? 0) + batches * rl.qty_per_batch);
      }
    }
    return ingredients
      .map((ing) => {
        const needed = need.get(ing.id) ?? 0;
        return { ...ing, needed, buy: Math.max(0, needed - ing.on_hand_qty) };
      })
      .filter((g) => g.needed > 0)
      .sort((a, b) => b.buy - a.buy || a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bakeable, batchByItem, recipeByItem, ingredients, bakeByItem]);

  const toBuyCount = grocery.filter((g) => g.buy > 0).length;

  const handleSuggest = async () => {
    if (!selectedCycleId) {
      setMessage("Pick a cycle to pull suggestions from.");
      return;
    }
    setSuggesting(true);
    setMessage(null);
    try {
      const { data, error } = await supabase
        .from("allocations")
        .select("item_id,shortfall,overdraft")
        .eq("cycle_id", selectedCycleId);
      if (error) {
        setMessage(error.message);
        return;
      }
      const byItem = new Map<string, number>();
      for (const a of (data as Array<{ item_id: string; shortfall: number | null; overdraft: number | null }>) ?? []) {
        byItem.set(a.item_id, (byItem.get(a.item_id) ?? 0) + (a.shortfall ?? 0) + (a.overdraft ?? 0));
      }
      const upserts = [...byItem.entries()]
        .filter(([itemId, need]) => need > 0 && batchByItem[itemId] !== undefined)
        .map(([item_id, need]) => ({ item_id, planned_qty: need }));
      if (upserts.length === 0) {
        setMessage("No shortfalls/overdrafts on bakeable items in that cycle.");
        return;
      }
      const { error: upErr } = await supabase
        .from("factory_bake_lines")
        .upsert(upserts, { onConflict: "item_id" });
      if (upErr) {
        setMessage(upErr.message);
        return;
      }
      setMessage(`Suggested ${upserts.length} item${upserts.length === 1 ? "" : "s"} from the cycle.`);
      load();
    } catch (err) {
      setMessage(err instanceof Error ? `Couldn't suggest: ${err.message}` : "Couldn't suggest (network timeout). Try again.");
    } finally {
      setSuggesting(false);
    }
  };

  const handleSavePlanned = async (itemId: string) => {
    const raw = plannedDrafts[itemId];
    if (raw === undefined) return;
    const v = parseInt(raw, 10);
    if (!Number.isInteger(v) || v < 0) {
      setMessage("Planned boxes must be a non-negative whole number.");
      return;
    }
    setSavingItemId(itemId);
    setMessage(null);
    try {
      const { error } = await supabase
        .from("factory_bake_lines")
        .upsert([{ item_id: itemId, planned_qty: v }], { onConflict: "item_id" });
      if (error) {
        setMessage(error.message);
        return;
      }
      setPlannedDrafts((p) => {
        const n = { ...p };
        delete n[itemId];
        return n;
      });
    } catch (err) {
      setMessage(err instanceof Error ? `Couldn't save: ${err.message}` : "Couldn't save (network timeout). Try again.");
    } finally {
      setSavingItemId(null);
    }
  };

  const handleConfirm = async (itemId: string) => {
    const raw = confirmDrafts[itemId];
    const qty = parseInt(raw ?? "", 10);
    if (!Number.isInteger(qty) || qty <= 0) {
      setMessage("Enter how many boxes you baked.");
      return;
    }
    setConfirmingItemId(itemId);
    setMessage(null);
    try {
      const { error } = await supabase.rpc("confirm_bake", { p_item_id: itemId, p_qty: qty });
      if (error) {
        setMessage(error.message);
        return;
      }
      setConfirmDrafts((p) => ({ ...p, [itemId]: "" }));
      setMessage(`Logged ${qty} box${qty === 1 ? "" : "es"} baked — ingredients deducted.`);
      load();
    } catch (err) {
      setMessage(err instanceof Error ? `Couldn't confirm: ${err.message}` : "Couldn't confirm (network timeout). Try again.");
    } finally {
      setConfirmingItemId(null);
    }
  };

  const handleClear = async () => {
    if (!confirm("Clear the whole bake plan (planned + baked) for every item?")) return;
    setMessage(null);
    try {
      const { error } = await supabase.from("factory_bake_lines").delete().not("item_id", "is", null);
      if (error) setMessage(error.message);
      else {
        setMessage("Bake plan cleared.");
        load();
      }
    } catch (err) {
      setMessage(err instanceof Error ? `Couldn't clear: ${err.message}` : "Couldn't clear (network timeout). Try again.");
    }
  };

  const inputClass =
    "rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400";

  const planned = (id: string) => bakeByItem[id]?.planned_qty ?? 0;
  const baked = (id: string) => bakeByItem[id]?.baked_qty ?? 0;
  const activePlan = bakeable.filter((it) => planned(it.id) > 0 || baked(it.id) > 0);

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <h1 className="text-3xl font-semibold text-white">Factory Bake Schedule</h1>
      <p className="mt-3 text-slate-400">
        Plan how many <strong>boxes</strong> to bake of each flavour. Suggestions come
        from a cycle&apos;s shortfalls; the grocery list shows ingredients to buy; confirming
        a bake deducts ingredients automatically. (1 box = {EMPANADAS_PER_BOX} empanadas.)
      </p>

      {authLoading ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">Loading…</div>
      ) : !isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">Please sign in.</div>
      ) : !canManage ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          This page is only available to Factory Workers and Store Managers.
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          {/* Suggest controls */}
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-slate-900/60 p-4">
            <label htmlFor="bake-cycle" className="text-sm font-medium text-slate-300">
              Suggest from cycle:
            </label>
            <select
              id="bake-cycle"
              value={selectedCycleId}
              onChange={(e) => setSelectedCycleId(e.target.value)}
              className={inputClass}
            >
              <option value="">(pick a cycle)</option>
              {cycles.map((c) => (
                <option key={c.id} value={c.id}>
                  {formatLocalDate(c.order_date)} ({c.status})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleSuggest}
              disabled={suggesting || !selectedCycleId}
              className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
            >
              {suggesting ? "Suggesting…" : "Suggest"}
            </button>
            <span className="text-xs text-slate-500">
              Pre-fills Planned from that cycle&apos;s shortfalls + overdrafts. You can edit after.
            </span>
            <button
              type="button"
              onClick={handleClear}
              className="ml-auto rounded-full border border-white/15 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-white/5"
            >
              Clear plan
            </button>
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          {bakeable.length === 0 ? (
            <p className="text-sm text-slate-400">
              No bakeable items yet — set a batch size on the <strong>Recipes</strong> page first.
            </p>
          ) : (
            <>
              {/* Plan table */}
              <div className="overflow-x-auto rounded-2xl border border-white/10 bg-slate-900/40 p-4">
                <h2 className="text-lg font-semibold text-white">Bake plan (boxes)</h2>
                <table className="mt-3 min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                      <th className="px-3 py-2">Flavour</th>
                      <th className="px-3 py-2">Planned</th>
                      <th className="px-3 py-2">Baked</th>
                      <th className="px-3 py-2">Remaining</th>
                      <th className="px-3 py-2">Confirm baked</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {bakeable.map((it) => {
                      const rem = remainingOf(it.id);
                      const pd = plannedDrafts[it.id];
                      return (
                        <tr key={it.id} className="text-slate-200">
                          <td className="px-3 py-2 font-medium">{it.name}</td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={pd ?? String(planned(it.id))}
                              onChange={(e) => setPlannedDrafts((p) => ({ ...p, [it.id]: e.target.value }))}
                              onBlur={() => handleSavePlanned(it.id)}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                              disabled={savingItemId === it.id}
                              className={`${inputClass} w-24`}
                            />
                          </td>
                          <td className="px-3 py-2 text-slate-400">{baked(it.id)}</td>
                          <td className={`px-3 py-2 font-semibold ${rem > 0 ? "text-amber-200" : "text-emerald-300"}`}>
                            {rem}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <input
                                type="number"
                                min="1"
                                step="1"
                                value={confirmDrafts[it.id] ?? ""}
                                onChange={(e) => setConfirmDrafts((p) => ({ ...p, [it.id]: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === "Enter") handleConfirm(it.id); }}
                                placeholder="boxes"
                                className={`${inputClass} w-24`}
                              />
                              <button
                                type="button"
                                onClick={() => handleConfirm(it.id)}
                                disabled={confirmingItemId === it.id || !(confirmDrafts[it.id] ?? "").trim()}
                                className="rounded-full bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                              >
                                {confirmingItemId === it.id ? "…" : "Baked"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Grocery list */}
              <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-4">
                <div className="flex items-baseline justify-between flex-wrap gap-2">
                  <h2 className="text-lg font-semibold text-white">Grocery list</h2>
                  <span className="text-sm text-slate-300">
                    {activePlan.length} item{activePlan.length === 1 ? "" : "s"} planned
                    {toBuyCount > 0 ? (
                      <span className="text-amber-300"> · {toBuyCount} ingredient{toBuyCount === 1 ? "" : "s"} to buy</span>
                    ) : (
                      <span className="text-emerald-300"> · enough stock</span>
                    )}
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  Ingredients needed for the remaining bake (rounded up to whole batches) vs what&apos;s on hand.
                </p>
                {grocery.length === 0 ? (
                  <p className="mt-3 text-sm text-slate-500">Nothing to bake yet — set Planned amounts above.</p>
                ) : (
                  <div className="mt-3 overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                          <th className="px-3 py-2">Ingredient</th>
                          <th className="px-3 py-2">Needed</th>
                          <th className="px-3 py-2">On hand</th>
                          <th className="px-3 py-2">To buy</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {grocery.map((g) => (
                          <tr key={g.id} className="text-slate-200">
                            <td className="px-3 py-2 font-medium">{g.name}</td>
                            <td className="px-3 py-2 text-slate-300">{+g.needed.toFixed(2)} {g.unit}</td>
                            <td className="px-3 py-2 text-slate-400">{+g.on_hand_qty.toFixed(2)} {g.unit}</td>
                            <td className={`px-3 py-2 font-semibold ${g.buy > 0 ? "text-amber-200" : "text-emerald-300"}`}>
                              {g.buy > 0 ? `${+g.buy.toFixed(2)} ${g.unit}` : "—"}
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
