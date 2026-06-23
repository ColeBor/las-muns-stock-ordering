"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

type Ingredient = {
  id: string;
  name: string;
  unit: string;
  on_hand_qty: number;
  low_stock_threshold: number | null;
};

export default function Ingredients() {
  const { profile, loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
  const isFactoryWorker = profile?.role === "factory_worker";
  const canManage = isFactoryWorker || isStoreManager;

  const [rows, setRows] = useState<Ingredient[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  // Add form
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("g");
  const [onHand, setOnHand] = useState("");
  const [threshold, setThreshold] = useState("");
  const [adding, setAdding] = useState(false);

  // Inline on-hand editing — keyed by id.
  const [qtyDrafts, setQtyDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canManage) {
      setRows([]);
      return;
    }
    const { data, error } = await supabase
      .from("ingredients")
      .select("id,name,unit,on_hand_qty,low_stock_threshold")
      .order("name");
    if (error) {
      setMessage(`Couldn't load ingredients: ${error.message}`);
      return;
    }
    setRows(
      ((data as Ingredient[]) ?? []).map((r) => ({
        ...r,
        on_hand_qty: Number(r.on_hand_qty),
        low_stock_threshold: r.low_stock_threshold === null ? null : Number(r.low_stock_threshold),
      })),
    );
  }, [canManage]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtimeRefetch(canManage ? [{ table: "ingredients" }] : [], load, "ingredients");

  const handleAdd = async () => {
    const n = name.trim();
    if (!n) {
      setMessage("Add a name.");
      return;
    }
    const oh = onHand.trim() === "" ? 0 : Number(onHand);
    const th = threshold.trim() === "" ? null : Number(threshold);
    if (!Number.isFinite(oh) || oh < 0) {
      setMessage("On-hand must be a non-negative number.");
      return;
    }
    if (th !== null && (!Number.isFinite(th) || th < 0)) {
      setMessage("Low-stock threshold must be a non-negative number (or blank).");
      return;
    }
    setAdding(true);
    setMessage(null);
    try {
      const { error } = await supabase.from("ingredients").insert([
        { name: n, unit: unit.trim() || "unit", on_hand_qty: oh, low_stock_threshold: th },
      ]);
      if (error) {
        setMessage(error.code === "23505" ? `"${n}" already exists.` : error.message);
        return;
      }
      setName("");
      setOnHand("");
      setThreshold("");
      setMessage("Ingredient added.");
      load();
    } catch (err) {
      setMessage(err instanceof Error ? `Couldn't add: ${err.message}` : "Couldn't add (network timeout). Try again.");
    } finally {
      setAdding(false);
    }
  };

  const handleSaveQty = async (ing: Ingredient) => {
    const raw = qtyDrafts[ing.id];
    if (raw === undefined) return;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) {
      setMessage("On-hand must be a non-negative number.");
      return;
    }
    if (v === ing.on_hand_qty) {
      setQtyDrafts((p) => {
        const next = { ...p };
        delete next[ing.id];
        return next;
      });
      return;
    }
    setSavingId(ing.id);
    setMessage(null);
    try {
      const { error } = await supabase.from("ingredients").update({ on_hand_qty: v }).eq("id", ing.id);
      if (error) {
        setMessage(error.message);
        return;
      }
      setQtyDrafts((p) => {
        const next = { ...p };
        delete next[ing.id];
        return next;
      });
    } catch (err) {
      setMessage(err instanceof Error ? `Couldn't save: ${err.message}` : "Couldn't save (network timeout). Try again.");
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (ing: Ingredient) => {
    if (!confirm(`Delete "${ing.name}"? Any recipe using it will lose this ingredient.`)) return;
    setMessage(null);
    try {
      const { error } = await supabase.from("ingredients").delete().eq("id", ing.id);
      if (error) setMessage(error.message);
      else load();
    } catch (err) {
      setMessage(err instanceof Error ? `Couldn't delete: ${err.message}` : "Couldn't delete (network timeout). Try again.");
    }
  };

  const lowCount = useMemo(
    () => rows.filter((r) => r.low_stock_threshold !== null && r.on_hand_qty <= r.low_stock_threshold).length,
    [rows],
  );

  const inputClass =
    "rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400";

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <h1 className="text-3xl font-semibold text-white">Ingredient Stock</h1>
      <p className="mt-3 text-slate-400">
        What the factory has on hand. Recipes and the bake schedule draw from this; a
        bake confirmed in the schedule deducts ingredients automatically.
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
          {/* Add form */}
          <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-5">
            <h2 className="text-lg font-semibold text-white">Add ingredient</h2>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                Name
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Beef filling"
                  className={`${inputClass} w-48`}
                  onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                Unit
                <input
                  type="text"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  placeholder="g, kg, mL, each…"
                  className={`${inputClass} w-24`}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                On hand
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={onHand}
                  onChange={(e) => setOnHand(e.target.value)}
                  placeholder="0"
                  className={`${inputClass} w-24`}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                Low at (optional)
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  placeholder="—"
                  className={`${inputClass} w-24`}
                />
              </label>
              <button
                type="button"
                onClick={handleAdd}
                disabled={adding || !name.trim()}
                className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
              >
                {adding ? "Adding…" : "Add"}
              </button>
            </div>
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          <div className="text-sm text-slate-300">
            {rows.length} ingredient{rows.length === 1 ? "" : "s"}
            {lowCount > 0 && <span className="text-amber-300"> · {lowCount} low</span>}
          </div>

          {/* List */}
          {rows.length === 0 ? (
            <p className="text-sm text-slate-500">No ingredients yet. Add one above.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                    <th className="px-3 py-2">Ingredient</th>
                    <th className="px-3 py-2">Unit</th>
                    <th className="px-3 py-2">On hand</th>
                    <th className="px-3 py-2">Low at</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {rows.map((ing) => {
                    const low =
                      ing.low_stock_threshold !== null && ing.on_hand_qty <= ing.low_stock_threshold;
                    const draft = qtyDrafts[ing.id];
                    return (
                      <tr key={ing.id} className="text-slate-200">
                        <td className="px-3 py-2 font-medium">
                          {ing.name}
                          {low && (
                            <span className="ml-2 rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-200">
                              low
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-400">{ing.unit}</td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            step="any"
                            min="0"
                            value={draft ?? String(ing.on_hand_qty)}
                            onChange={(e) =>
                              setQtyDrafts((p) => ({ ...p, [ing.id]: e.target.value }))
                            }
                            onBlur={() => handleSaveQty(ing)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            }}
                            disabled={savingId === ing.id}
                            className={`${inputClass} w-24 ${low ? "border-amber-400/50" : ""}`}
                          />
                        </td>
                        <td className="px-3 py-2 text-slate-400">
                          {ing.low_stock_threshold === null ? "—" : ing.low_stock_threshold}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => handleDelete(ing)}
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
      )}
    </section>
  );
}
