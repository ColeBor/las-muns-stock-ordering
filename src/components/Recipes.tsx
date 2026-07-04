"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import { useFormDraft } from "@/lib/useFormDraft";

const EMPANADAS_PER_BOX = 30;

type Item = { id: string; name: string; sub_category: string | null };
type Ingredient = { id: string; name: string; unit: string };
// Recipes are per BOX. The DB column is still named qty_per_batch and each
// recipe's item_recipes.batch_size is fixed at 1, so "per batch" == "per box".
type RecipeLine = { item_id: string; ingredient_id: string; qty_per_batch: number };

export default function Recipes() {
  const { profile, loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
  const isFactoryWorker = profile?.role === "factory_worker";
  const canManage = isFactoryWorker || isStoreManager;

  const [items, setItems] = useState<Item[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [hasHeaderByItem, setHasHeaderByItem] = useState<Record<string, boolean>>({});
  const [linesByItem, setLinesByItem] = useState<Record<string, RecipeLine[]>>({});
  const [message, setMessage] = useState<string | null>(null);

  const [selectedItemId, setSelectedItemId] = useState("");

  const [newIngredientId, setNewIngredientId] = useState("");
  const [newQty, setNewQty] = useState("");
  const [addingLine, setAddingLine] = useState(false);
  const [lineQtyDrafts, setLineQtyDrafts] = useState<Record<string, string>>({});
  const [savingLineId, setSavingLineId] = useState<string | null>(null);

  useFormDraft({
    key: "recipes-new",
    values: { selectedItemId, newIngredientId, newQty },
    isDirty: (v) => !!v.newIngredientId || v.newQty.trim() !== "",
    onRestore: (v) => {
      if (v.selectedItemId) setSelectedItemId(v.selectedItemId);
      if (v.newIngredientId) setNewIngredientId(v.newIngredientId);
      if (v.newQty) setNewQty(v.newQty);
    },
    onRestored: () => setMessage("Restored your unsaved entry."),
  });

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
      supabase.from("item_recipes").select("item_id"),
      supabase.from("recipe_ingredients").select("item_id,ingredient_id,qty_per_batch"),
    ]);
    if (itemsRes.data) setItems(itemsRes.data as Item[]);
    if (ingRes.data) setIngredients(ingRes.data as Ingredient[]);
    if (recRes.data) {
      const m: Record<string, boolean> = {};
      for (const r of recRes.data as Array<{ item_id: string }>) m[r.item_id] = true;
      setHasHeaderByItem(m);
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

  const ingredientById = useMemo(() => {
    const m: Record<string, Ingredient> = {};
    for (const i of ingredients) m[i.id] = i;
    return m;
  }, [ingredients]);

  const lines = selectedItemId ? linesByItem[selectedItemId] ?? [] : [];
  const usedIngredientIds = new Set(lines.map((l) => l.ingredient_id));
  const availableIngredients = ingredients.filter((i) => !usedIngredientIds.has(i.id));

  const handleAddLine = async () => {
    if (!selectedItemId) return;
    if (!newIngredientId) {
      setMessage("Pick an ingredient.");
      return;
    }
    const qty = Number(newQty);
    if (!Number.isFinite(qty) || qty < 0) {
      setMessage("Amount per box must be a non-negative number.");
      return;
    }
    setAddingLine(true);
    setMessage(null);
    try {
      // Lazily create the recipe header (1 box per "batch") the first time an
      // ingredient is added — no separate batch-size step.
      if (!hasHeaderByItem[selectedItemId]) {
        const { error: hdrErr } = await supabase
          .from("item_recipes")
          .upsert([{ item_id: selectedItemId, batch_size: 1 }], { onConflict: "item_id" });
        if (hdrErr) {
          setMessage(hdrErr.message);
          return;
        }
      }
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
        For each item, list the ingredients <strong>one box</strong> uses. The bake
        schedule multiplies this by the boxes to bake to build the grocery list and
        deduct ingredients. (1 box = {EMPANADAS_PER_BOX} empanadas.)
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
                  {(linesByItem[it.id]?.length ?? 0) > 0 ? " ✓" : ""}
                </option>
              ))}
            </select>
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          {selectedItemId && (
            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-5">
              <h2 className="text-lg font-semibold text-white">Ingredients per box</h2>
              {lines.length === 0 ? (
                <p className="mt-2 text-sm text-slate-500">No ingredients yet.</p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                        <th className="px-3 py-2">Ingredient</th>
                        <th className="px-3 py-2">Per box</th>
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
                  Amount per box
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
            </div>
          )}
        </div>
      )}
    </section>
  );
}
