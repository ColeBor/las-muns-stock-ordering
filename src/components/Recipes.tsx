"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

const EMPANADAS_PER_BOX = 30;

type Item = { id: string; name: string; sub_category: string | null };
type Ingredient = { id: string; name: string; unit: string };
type RecipeLine = { item_id: string; ingredient_id: string; qty_per_batch: number };

export default function Recipes() {
  const { profile, loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
  const isFactoryWorker = profile?.role === "factory_worker";
  const canManage = isFactoryWorker || isStoreManager;

  const [items, setItems] = useState<Item[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [batchByItem, setBatchByItem] = useState<Record<string, number>>({});
  const [linesByItem, setLinesByItem] = useState<Record<string, RecipeLine[]>>({});
  const [message, setMessage] = useState<string | null>(null);

  const [selectedItemId, setSelectedItemId] = useState("");
  const [batchDraft, setBatchDraft] = useState("");
  const [savingBatch, setSavingBatch] = useState(false);

  const [newIngredientId, setNewIngredientId] = useState("");
  const [newQty, setNewQty] = useState("");
  const [addingLine, setAddingLine] = useState(false);
  const [lineQtyDrafts, setLineQtyDrafts] = useState<Record<string, string>>({});
  const [savingLineId, setSavingLineId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canManage) return;
    const [itemsRes, ingRes, recRes, lineRes] = await Promise.all([
      // Recipes only apply to baked goods — limit the picker to Empanada +
      // Dessert categories rather than every manufactured item.
      supabase
        .from("items")
        .select("id,name,sub_category")
        .eq("type", "manufactured")
        .in("sub_category", ["Empanada", "Dessert"])
        .order("name"),
      supabase.from("ingredients").select("id,name,unit").order("name"),
      supabase.from("item_recipes").select("item_id,batch_size"),
      supabase.from("recipe_ingredients").select("item_id,ingredient_id,qty_per_batch"),
    ]);
    if (itemsRes.data) setItems(itemsRes.data as Item[]);
    if (ingRes.data) setIngredients(ingRes.data as Ingredient[]);
    if (recRes.data) {
      const m: Record<string, number> = {};
      for (const r of recRes.data as Array<{ item_id: string; batch_size: number }>) {
        m[r.item_id] = Number(r.batch_size);
      }
      setBatchByItem(m);
    }
    if (lineRes.data) {
      const m: Record<string, RecipeLine[]> = {};
      for (const l of lineRes.data as RecipeLine[]) {
        (m[l.item_id] ??= []).push({ ...l, qty_per_batch: Number(l.qty_per_batch) });
      }
      setLinesByItem(m);
    }
  }, [canManage]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtimeRefetch(
    canManage
      ? [
          { table: "item_recipes" },
          { table: "recipe_ingredients" },
          { table: "ingredients" },
          { table: "items" },
        ]
      : [],
    load,
    "recipes",
  );

  // Keep the batch draft in sync with the selected item.
  useEffect(() => {
    if (!selectedItemId) {
      setBatchDraft("");
      return;
    }
    const b = batchByItem[selectedItemId];
    setBatchDraft(b === undefined ? "" : String(b));
  }, [selectedItemId, batchByItem]);

  const ingredientById = useMemo(() => {
    const m: Record<string, Ingredient> = {};
    for (const i of ingredients) m[i.id] = i;
    return m;
  }, [ingredients]);

  const hasRecipe = selectedItemId !== "" && batchByItem[selectedItemId] !== undefined;
  const lines = selectedItemId ? linesByItem[selectedItemId] ?? [] : [];
  const usedIngredientIds = new Set(lines.map((l) => l.ingredient_id));
  const availableIngredients = ingredients.filter((i) => !usedIngredientIds.has(i.id));
  const batchSize = selectedItemId ? batchByItem[selectedItemId] : undefined;

  const handleSaveBatch = async () => {
    if (!selectedItemId) return;
    const size = parseInt(batchDraft, 10);
    if (!Number.isInteger(size) || size <= 0) {
      setMessage("Batch size must be a whole number of boxes greater than 0.");
      return;
    }
    setSavingBatch(true);
    setMessage(null);
    try {
      const { error } = await supabase
        .from("item_recipes")
        .upsert([{ item_id: selectedItemId, batch_size: size }], { onConflict: "item_id" });
      if (error) {
        setMessage(error.message);
        return;
      }
      setMessage("Batch size saved.");
      load();
    } catch (err) {
      setMessage(err instanceof Error ? `Couldn't save: ${err.message}` : "Couldn't save (network timeout). Try again.");
    } finally {
      setSavingBatch(false);
    }
  };

  const handleAddLine = async () => {
    if (!selectedItemId || !hasRecipe) {
      setMessage("Set a batch size first.");
      return;
    }
    if (!newIngredientId) {
      setMessage("Pick an ingredient.");
      return;
    }
    const qty = Number(newQty);
    if (!Number.isFinite(qty) || qty < 0) {
      setMessage("Amount per batch must be a non-negative number.");
      return;
    }
    setAddingLine(true);
    setMessage(null);
    try {
      const { error } = await supabase
        .from("recipe_ingredients")
        .insert([{ item_id: selectedItemId, ingredient_id: newIngredientId, qty_per_batch: qty }]);
      if (error) {
        setMessage(error.message);
        return;
      }
      setNewIngredientId("");
      setNewQty("");
      load();
    } catch (err) {
      setMessage(err instanceof Error ? `Couldn't add: ${err.message}` : "Couldn't add (network timeout). Try again.");
    } finally {
      setAddingLine(false);
    }
  };

  const handleSaveLineQty = async (line: RecipeLine) => {
    const raw = lineQtyDrafts[line.ingredient_id];
    if (raw === undefined) return;
    const qty = Number(raw);
    if (!Number.isFinite(qty) || qty < 0) {
      setMessage("Amount must be a non-negative number.");
      return;
    }
    if (qty === line.qty_per_batch) {
      setLineQtyDrafts((p) => {
        const n = { ...p };
        delete n[line.ingredient_id];
        return n;
      });
      return;
    }
    setSavingLineId(line.ingredient_id);
    setMessage(null);
    try {
      const { error } = await supabase
        .from("recipe_ingredients")
        .update({ qty_per_batch: qty })
        .eq("item_id", line.item_id)
        .eq("ingredient_id", line.ingredient_id);
      if (error) {
        setMessage(error.message);
        return;
      }
      setLineQtyDrafts((p) => {
        const n = { ...p };
        delete n[line.ingredient_id];
        return n;
      });
    } catch (err) {
      setMessage(err instanceof Error ? `Couldn't save: ${err.message}` : "Couldn't save (network timeout). Try again.");
    } finally {
      setSavingLineId(null);
    }
  };

  const handleRemoveLine = async (line: RecipeLine) => {
    setMessage(null);
    try {
      const { error } = await supabase
        .from("recipe_ingredients")
        .delete()
        .eq("item_id", line.item_id)
        .eq("ingredient_id", line.ingredient_id);
      if (error) setMessage(error.message);
      else load();
    } catch (err) {
      setMessage(err instanceof Error ? `Couldn't remove: ${err.message}` : "Couldn't remove (network timeout). Try again.");
    }
  };

  const inputClass =
    "rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400";

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <h1 className="text-3xl font-semibold text-white">Recipes</h1>
      <p className="mt-3 text-slate-400">
        For each item, set how many <strong>boxes</strong> one batch makes and the
        ingredients a batch uses. The bake schedule uses this to build the grocery
        list and deduct ingredients. (1 box = {EMPANADAS_PER_BOX} empanadas.)
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
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="recipe-item" className="text-sm font-medium text-slate-300">
              Item:
            </label>
            <select
              id="recipe-item"
              value={selectedItemId}
              onChange={(e) => setSelectedItemId(e.target.value)}
              className={`${inputClass} min-w-[220px]`}
            >
              <option value="">(pick an item)</option>
              {items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name}
                  {batchByItem[it.id] !== undefined ? " ✓" : ""}
                </option>
              ))}
            </select>
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          {selectedItemId && (
            <div className="space-y-5">
              {/* Batch size */}
              <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-5">
                <h2 className="text-lg font-semibold text-white">Batch size</h2>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1 text-xs text-slate-400">
                    Boxes per batch
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={batchDraft}
                      onChange={(e) => setBatchDraft(e.target.value)}
                      placeholder="e.g. 10"
                      className={`${inputClass} w-32`}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={handleSaveBatch}
                    disabled={savingBatch || !batchDraft.trim()}
                    className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
                  >
                    {savingBatch ? "Saving…" : "Save"}
                  </button>
                  {batchSize !== undefined && (
                    <span className="text-xs text-slate-500">
                      1 batch = {batchSize} box{batchSize === 1 ? "" : "es"} ={" "}
                      {batchSize * EMPANADAS_PER_BOX} empanadas
                    </span>
                  )}
                </div>
              </div>

              {/* Ingredients */}
              <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-5">
                <h2 className="text-lg font-semibold text-white">Ingredients per batch</h2>
                {!hasRecipe ? (
                  <p className="mt-2 text-sm text-amber-300">Set a batch size above first.</p>
                ) : (
                  <>
                    {lines.length === 0 ? (
                      <p className="mt-2 text-sm text-slate-500">No ingredients yet.</p>
                    ) : (
                      <div className="mt-3 overflow-x-auto">
                        <table className="min-w-full text-sm">
                          <thead>
                            <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                              <th className="px-3 py-2">Ingredient</th>
                              <th className="px-3 py-2">Per batch</th>
                              <th className="px-3 py-2">Unit</th>
                              <th className="px-3 py-2"></th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-white/5">
                            {lines
                              .slice()
                              .sort((a, b) =>
                                (ingredientById[a.ingredient_id]?.name ?? "").localeCompare(
                                  ingredientById[b.ingredient_id]?.name ?? "",
                                ),
                              )
                              .map((line) => {
                                const ing = ingredientById[line.ingredient_id];
                                const draft = lineQtyDrafts[line.ingredient_id];
                                return (
                                  <tr key={line.ingredient_id} className="text-slate-200">
                                    <td className="px-3 py-2 font-medium">{ing?.name ?? line.ingredient_id}</td>
                                    <td className="px-3 py-2">
                                      <input
                                        type="number"
                                        step="any"
                                        min="0"
                                        value={draft ?? String(line.qty_per_batch)}
                                        onChange={(e) =>
                                          setLineQtyDrafts((p) => ({ ...p, [line.ingredient_id]: e.target.value }))
                                        }
                                        onBlur={() => handleSaveLineQty(line)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                        }}
                                        disabled={savingLineId === line.ingredient_id}
                                        className={`${inputClass} w-28`}
                                      />
                                    </td>
                                    <td className="px-3 py-2 text-slate-400">{ing?.unit ?? ""}</td>
                                    <td className="px-3 py-2 text-right">
                                      <button
                                        type="button"
                                        onClick={() => handleRemoveLine(line)}
                                        className="text-xs text-rose-300 hover:text-rose-200"
                                      >
                                        Remove
                                      </button>
                                    </td>
                                  </tr>
                                );
                              })}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Add line */}
                    <div className="mt-4 flex flex-wrap items-end gap-3">
                      <label className="flex flex-col gap-1 text-xs text-slate-400">
                        Ingredient
                        <select
                          value={newIngredientId}
                          onChange={(e) => setNewIngredientId(e.target.value)}
                          className={`${inputClass} min-w-[180px]`}
                        >
                          <option value="">(pick ingredient)</option>
                          {availableIngredients.map((i) => (
                            <option key={i.id} value={i.id}>
                              {i.name} ({i.unit})
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex flex-col gap-1 text-xs text-slate-400">
                        Amount per batch
                        <input
                          type="number"
                          step="any"
                          min="0"
                          value={newQty}
                          onChange={(e) => setNewQty(e.target.value)}
                          placeholder="0"
                          className={`${inputClass} w-28`}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={handleAddLine}
                        disabled={addingLine || !newIngredientId || newQty.trim() === ""}
                        className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                      >
                        {addingLine ? "Adding…" : "Add ingredient"}
                      </button>
                      {availableIngredients.length === 0 && ingredients.length === 0 && (
                        <span className="text-xs text-slate-500">
                          No ingredients yet — add some on the Ingredients page.
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
