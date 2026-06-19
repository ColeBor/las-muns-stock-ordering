"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

// Global standard thresholds per unit type — see migration
// 20260619150000_standardize_fridge_thresholds.sql. One set for all fridges,
// one for all freezers, across every location. The fridge_alerts view reads
// these via each unit's `kind`.
type Kind = "fridge" | "freezer";
type Draft = { min: string; max: string; severe: string };
const EMPTY: Draft = { min: "", max: "", severe: "" };
const KINDS: { kind: Kind; label: string; hint: string }[] = [
  { kind: "fridge", label: "🧊 Fridges", hint: "e.g. 1 to 4 °C" },
  { kind: "freezer", label: "❄️ Freezers", hint: "e.g. −25 to −15 °C" },
];

export default function StandardThresholds() {
  const { session, isStoreManager } = useAuthGate();
  const [drafts, setDrafts] = useState<Record<Kind, Draft>>({ fridge: EMPTY, freezer: EMPTY });
  const [saved, setSaved] = useState<Record<Kind, Draft>>({ fridge: EMPTY, freezer: EMPTY });
  const [savingKind, setSavingKind] = useState<Kind | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isStoreManager) return;
    const { data } = await supabase
      .from("temperature_targets")
      .select("kind,target_min_c,target_max_c,severe_deviation_c");
    const next: Record<Kind, Draft> = { fridge: EMPTY, freezer: EMPTY };
    for (const r of (data as Array<{
      kind: Kind;
      target_min_c: number | null;
      target_max_c: number | null;
      severe_deviation_c: number | null;
    }>) ?? []) {
      next[r.kind] = {
        min: r.target_min_c === null ? "" : String(r.target_min_c),
        max: r.target_max_c === null ? "" : String(r.target_max_c),
        severe: r.severe_deviation_c === null ? "" : String(r.severe_deviation_c),
      };
    }
    setDrafts(next);
    setSaved(next);
  }, [isStoreManager]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtimeRefetch(
    isStoreManager ? [{ table: "temperature_targets" }] : [],
    load,
    "standard-thresholds",
  );

  const patch = (kind: Kind, p: Partial<Draft>) =>
    setDrafts((prev) => ({ ...prev, [kind]: { ...prev[kind], ...p } }));

  const dirty = (kind: Kind) =>
    drafts[kind].min !== saved[kind].min ||
    drafts[kind].max !== saved[kind].max ||
    drafts[kind].severe !== saved[kind].severe;

  const handleSave = async (kind: Kind) => {
    const parse = (raw: string): number | null | typeof NaN => {
      const t = raw.trim();
      if (t === "") return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : NaN;
    };
    const min = parse(drafts[kind].min);
    const max = parse(drafts[kind].max);
    const severe = parse(drafts[kind].severe);
    if (Number.isNaN(min) || Number.isNaN(max) || Number.isNaN(severe)) {
      setMessage("Temperatures must be numbers (or blank to clear).");
      return;
    }
    if (min !== null && max !== null && (min as number) > (max as number)) {
      setMessage("Min must be ≤ max.");
      return;
    }
    if (severe !== null && (severe as number) <= 0) {
      setMessage("Spike threshold must be greater than 0.");
      return;
    }
    setSavingKind(kind);
    setMessage(null);
    try {
      const { error } = await supabase.from("temperature_targets").update({
        target_min_c: min,
        target_max_c: max,
        severe_deviation_c: severe,
        updated_at: new Date().toISOString(),
        updated_by: session?.user?.email ?? session?.user?.id ?? null,
      }).eq("kind", kind);
      if (error) {
        setMessage(error.message);
        return;
      }
      setSaved((prev) => ({ ...prev, [kind]: drafts[kind] }));
      setMessage(`${kind === "fridge" ? "Fridge" : "Freezer"} thresholds saved.`);
    } catch (err) {
      setMessage(
        err instanceof Error ? `Couldn't save: ${err.message}` : "Couldn't save (network timeout). Try again.",
      );
    } finally {
      setSavingKind(null);
    }
  };

  if (!isStoreManager) return null;

  const inputClass =
    "w-24 rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400";

  return (
    <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-5">
      <h2 className="text-lg font-semibold text-white">Standard thresholds</h2>
      <p className="mt-1 text-sm text-slate-400">
        One set of limits per type, applied to every fridge / freezer at every
        location. Leave blank to turn off alerting for that type.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {KINDS.map(({ kind, label, hint }) => (
          <div key={kind} className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">{label}</h3>
              <span className="text-xs text-slate-500">{hint}</span>
            </div>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                Min °C
                <input type="number" step="0.5" value={drafts[kind].min}
                  onChange={(e) => patch(kind, { min: e.target.value })} className={inputClass} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                Max °C
                <input type="number" step="0.5" value={drafts[kind].max}
                  onChange={(e) => patch(kind, { max: e.target.value })} className={inputClass} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                Spike °C
                <input type="number" step="0.5" min="0" value={drafts[kind].severe}
                  onChange={(e) => patch(kind, { severe: e.target.value })} className={inputClass} />
              </label>
              <button
                type="button"
                onClick={() => handleSave(kind)}
                disabled={savingKind === kind || !dirty(kind)}
                className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
              >
                {savingKind === kind ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ))}
      </div>
      {message && <p className="mt-3 text-sm text-cyan-300">{message}</p>}
    </div>
  );
}
