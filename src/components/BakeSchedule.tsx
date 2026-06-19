"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

type Store = { id: string; name: string };

type BakeItem = { item_id: string; name: string };

type ExpectedRow = { item_id: string; day_of_week: number; expected_qty: number };

type SheetLine = { item_id: string; on_hand_qty: number; bake_qty: number; baked_qty: number };

type Sheet = {
  id: string;
  store_id: string;
  bake_for_date: string;
  created_by: string | null;
  updated_at: string;
};

// Rounding rule: nearest multiple, with ties going DOWN (waste-averse).
// E.g. raw=6 multiple=12 → 0; raw=8 multiple=12 → 12; raw=4 multiple=12 → 0.
function roundToNearest(raw: number, multiple: number): number {
  if (raw <= 0) return 0;
  if (multiple <= 1) return raw;
  const lower = Math.floor(raw / multiple) * multiple;
  const upper = lower + multiple;
  const distLower = raw - lower;
  const distUpper = upper - raw;
  return distLower <= distUpper ? lower : upper;
}

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
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [bakeForDate, setBakeForDate] = useState<string>(tomorrowIso());
  // Per-item form state. Multiple is local-only (not persisted) — it's a
  // calculation helper. on_hand and bake_qty are persisted on save.
  const [onHand, setOnHand] = useState<Record<string, string>>({});
  const [bakeQty, setBakeQty] = useState<Record<string, string>>({});
  const [bakedQty, setBakedQty] = useState<Record<string, string>>({});
  const [bakedSavingItemId, setBakedSavingItemId] = useState<string | null>(null);
  const [confirmStartFresh, setConfirmStartFresh] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
      const { data } = await supabase
        .from("stores")
        .select("id,name")
        .eq("id", effectiveStoreId)
        .single();
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
    const mapped = ((data ?? []) as unknown as Array<{
      item_id: string;
      items: { name: string };
    }>)
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
      setMessage(`Couldn't load expected sales: ${error.message}`);
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

  // Load the (single) current sheet for this store, plus its lines.
  const loadSheet = useCallback(async () => {
    if (!effectiveStoreId) {
      setSheet(null);
      setOnHand({});
      setBakeQty({});
      return;
    }
    const { data: sheetData, error: sheetErr } = await supabase
      .from("bake_sheets")
      .select("id,store_id,bake_for_date,created_by,updated_at")
      .eq("store_id", effectiveStoreId)
      .maybeSingle();
    if (sheetErr) {
      setMessage(`Couldn't load sheet: ${sheetErr.message}`);
      return;
    }
    if (!sheetData) {
      setSheet(null);
      setOnHand({});
      setBakeQty({});
      setBakedQty({});
      return;
    }
    setSheet(sheetData as Sheet);
    setBakeForDate((sheetData as Sheet).bake_for_date);

    const { data: lineData, error: lineErr } = await supabase
      .from("bake_sheet_lines")
      .select("item_id,on_hand_qty,bake_qty,baked_qty")
      .eq("bake_sheet_id", (sheetData as Sheet).id);
    if (lineErr) {
      setMessage(`Couldn't load sheet lines: ${lineErr.message}`);
      return;
    }
    const lines = (lineData as SheetLine[]) ?? [];
    const onHandMap: Record<string, string> = {};
    const bakeQtyMap: Record<string, string> = {};
    const bakedQtyMap: Record<string, string> = {};
    for (const l of lines) {
      onHandMap[l.item_id] = String(l.on_hand_qty);
      bakeQtyMap[l.item_id] = String(l.bake_qty);
      bakedQtyMap[l.item_id] = String(l.baked_qty ?? 0);
    }
    setOnHand(onHandMap);
    setBakeQty(bakeQtyMap);
    setBakedQty(bakedQtyMap);
  }, [effectiveStoreId]);

  useEffect(() => {
    loadSheet();
  }, [loadSheet]);

  useRealtimeRefetch(
    effectiveStoreId
      ? [
          { table: "bake_sheets", filter: `store_id=eq.${effectiveStoreId}` },
          { table: "bake_expected_sales", filter: `store_id=eq.${effectiveStoreId}` },
          { table: "store_items", filter: `store_id=eq.${effectiveStoreId}` },
          { table: "items" },
        ]
      : [],
    useCallback(() => {
      loadSheet();
      loadExpected();
      loadItems();
    }, [loadSheet, loadExpected, loadItems]),
    `bake-schedule-${effectiveStoreId}`,
  );

  const dayOfWeek = useMemo(() => dayOfWeekFromIso(bakeForDate), [bakeForDate]);

  const expectedByItem = useMemo(() => {
    const map: Record<string, number> = {};
    for (const e of expected) {
      if (e.day_of_week === dayOfWeek) map[e.item_id] = e.expected_qty;
    }
    return map;
  }, [expected, dayOfWeek]);

  const rawNeedFor = (itemId: string): number => {
    const exp = expectedByItem[itemId] ?? 0;
    const onHandNum = Number(onHand[itemId] ?? "0");
    const onHandSafe = Number.isFinite(onHandNum) ? onHandNum : 0;
    return Math.max(exp - onHandSafe, 0);
  };

  const applySuggestion = (itemId: string, value: number) => {
    setBakeQty((prev) => ({ ...prev, [itemId]: String(value) }));
  };

  const handleSave = async () => {
    if (!effectiveStoreId) return;
    if (!bakeForDate) {
      setMessage("Pick a bake-for date.");
      return;
    }
    if (items.length === 0) {
      setMessage("Nothing to save — no Empanadas are active at this store.");
      return;
    }
    // Validate inputs.
    for (const item of items) {
      const onHandStr = onHand[item.item_id] ?? "0";
      const bakeStr = bakeQty[item.item_id] ?? "0";
      const oh = Number(onHandStr);
      const bk = Number(bakeStr);
      if (!Number.isFinite(oh) || oh < 0 || !Number.isInteger(oh)) {
        setMessage(`On hand for ${item.name} must be a non-negative integer.`);
        return;
      }
      if (!Number.isFinite(bk) || bk < 0 || !Number.isInteger(bk)) {
        setMessage(`Bake qty for ${item.name} must be a non-negative integer.`);
        return;
      }
    }

    setSaving(true);
    setMessage(null);

    try {
      // Upsert the sheet for this store (one per store). Replace its lines.
      const sheetPayload = {
        store_id: effectiveStoreId,
        bake_for_date: bakeForDate,
        created_by: session?.user?.email ?? session?.user?.id ?? null,
      };
      const { data: sheetData, error: sheetErr } = await supabase
        .from("bake_sheets")
        .upsert([sheetPayload], { onConflict: "store_id" })
        .select("id,store_id,bake_for_date,created_by,updated_at")
        .single();
      if (sheetErr || !sheetData) {
        setMessage(sheetErr?.message ?? "Couldn't save sheet header.");
        return;
      }
      const sheetId = (sheetData as Sheet).id;

      // Fetch existing lines so we can carry baked_qty across the update.
      // Baked progress is about what's actually been baked today and is
      // independent of plan tweaks — changing bake_qty just adjusts the
      // denominator (e.g. 12/24 becomes 12/36 when bake_qty is bumped). Only
      // Start Fresh resets baked progress. First-save case returns empty,
      // so new items start at baked_qty = 0 naturally.
      const { data: existingLines, error: fetchErr } = await supabase
        .from("bake_sheet_lines")
        .select("item_id,on_hand_qty,bake_qty,baked_qty")
        .eq("bake_sheet_id", sheetId);
      if (fetchErr) {
        setMessage(fetchErr.message);
        return;
      }
      const existingByItem = new Map<string, SheetLine>();
      for (const row of (existingLines as SheetLine[]) ?? []) {
        existingByItem.set(row.item_id, row);
      }

      // Replace lines: delete-then-insert handles both new items and removed
      // items cleanly. baked_qty always carries over from `existingByItem`
      // when it exists.
      const { error: delErr } = await supabase
        .from("bake_sheet_lines")
        .delete()
        .eq("bake_sheet_id", sheetId);
      if (delErr) {
        setMessage(delErr.message);
        return;
      }
      const linePayload = items.map((item) => {
        const newOnHand = Number(onHand[item.item_id] ?? "0");
        const newBakeQty = Number(bakeQty[item.item_id] ?? "0");
        const prev = existingByItem.get(item.item_id);
        return {
          bake_sheet_id: sheetId,
          item_id: item.item_id,
          on_hand_qty: newOnHand,
          bake_qty: newBakeQty,
          baked_qty: prev?.baked_qty ?? 0,
        };
      });
      const { error: insErr } = await supabase.from("bake_sheet_lines").insert(linePayload);
      if (insErr) {
        setMessage(insErr.message);
        return;
      }
      setMessage("Sheet saved.");
      loadSheet();
    } catch (err) {
      setMessage(`Couldn't save sheet: ${err instanceof Error ? err.message : "network timeout"}. Try again.`);
    } finally {
      setSaving(false);
    }
  };

  // Update baked_qty for a single line. Each baker action persists
  // immediately so the morning crew sees their teammates' progress without
  // hitting Save. Only valid against a saved sheet — the closing employee
  // must have saved first.
  //
  // We also commit any pending On Hand / Bake Qty edits for the SAME row in
  // the same write. Without this, an unsaved Bake Qty change gets clobbered
  // by the realtime refetch that fires after our own write (the trigger on
  // bake_sheet_lines bumps bake_sheets.updated_at → realtime → loadSheet
  // overwrites form state).
  const updateBakedQty = async (itemId: string, newValue: number) => {
    if (!sheet) {
      setMessage("No sheet saved yet. Save the sheet first.");
      return;
    }
    if (!Number.isInteger(newValue) || newValue < 0) {
      setMessage("Baked qty must be a non-negative whole number.");
      return;
    }
    const pendingOnHand = Number(onHand[itemId] ?? "0");
    const pendingBakeQty = Number(bakeQty[itemId] ?? "0");
    if (
      !Number.isFinite(pendingOnHand) ||
      pendingOnHand < 0 ||
      !Number.isInteger(pendingOnHand) ||
      !Number.isFinite(pendingBakeQty) ||
      pendingBakeQty < 0 ||
      !Number.isInteger(pendingBakeQty)
    ) {
      setMessage("Fix the On Hand / Bake Qty values for this item first.");
      return;
    }
    setBakedSavingItemId(itemId);
    setMessage(null);
    // Optimistic local update; rollback on error.
    const previous = bakedQty[itemId] ?? "0";
    setBakedQty((prev) => ({ ...prev, [itemId]: String(newValue) }));
    try {
      const { error } = await supabase
        .from("bake_sheet_lines")
        .update({
          baked_qty: newValue,
          on_hand_qty: pendingOnHand,
          bake_qty: pendingBakeQty,
        })
        .eq("bake_sheet_id", sheet.id)
        .eq("item_id", itemId);
      if (error) {
        setBakedQty((prev) => ({ ...prev, [itemId]: previous }));
        setMessage(error.message);
      }
    } catch (err) {
      setBakedQty((prev) => ({ ...prev, [itemId]: previous }));
      setMessage(`Couldn't save baked qty: ${err instanceof Error ? err.message : "network timeout"}. Try again.`);
    } finally {
      setBakedSavingItemId(null);
    }
  };

  const markFullyBaked = (itemId: string) => {
    const target = parseInt(bakeQty[itemId] ?? "0", 10) || 0;
    const currentBaked = parseInt(bakedQty[itemId] ?? "0", 10) || 0;
    // "Done" means at least the target is baked. If baked is already higher
    // (e.g. they overbaked, or someone lowered Bake Qty later), don't drop
    // it — keep the larger value so the display still reads, say, 10/6.
    updateBakedQty(itemId, Math.max(target, currentBaked));
  };

  const markHalfBaked = (itemId: string) => {
    const target = parseInt(bakeQty[itemId] ?? "0", 10) || 0;
    updateBakedQty(itemId, Math.floor(target / 2));
  };

  const commitBakedInput = (itemId: string) => {
    const raw = bakedQty[itemId];
    if (raw === undefined) return;
    const parsed = raw.trim() === "" ? 0 : Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
      setMessage("Baked qty must be a non-negative whole number.");
      return;
    }
    updateBakedQty(itemId, parsed);
  };

  const handleStartFresh = async () => {
    if (!effectiveStoreId) return;
    setConfirmStartFresh(false);
    setMessage(null);
    try {
      // Delete the existing sheet (cascade drops the lines). Resets the form.
      const { error } = await supabase
        .from("bake_sheets")
        .delete()
        .eq("store_id", effectiveStoreId);
      if (error) {
        setMessage(error.message);
        return;
      }
      setSheet(null);
      setOnHand({});
      setBakeQty({});
      setBakedQty({});
      setBakeForDate(tomorrowIso());
      setMessage("Started fresh.");
    } catch (err) {
      setMessage(`Couldn't start fresh: ${err instanceof Error ? err.message : "network timeout"}. Try again.`);
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
            End of day: enter on-hand counts and confirm how much to bake. The morning shift bakes from this sheet.
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
            <div className="flex items-center gap-3 flex-wrap">
              {isStoreManager && (
                <>
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
                </>
              )}
              <div>
                <label htmlFor="bake-for" className="block text-xs font-medium text-slate-400">
                  Bake For
                </label>
                <input
                  id="bake-for"
                  type="date"
                  value={bakeForDate}
                  onChange={(e) => setBakeForDate(e.target.value)}
                  onClick={(e) => e.currentTarget.showPicker?.()}
                  min={todayIso()}
                  className="mt-1 cursor-pointer rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                />
              </div>
            </div>
          </div>

          <p className="text-sm text-slate-400">
            For {formatDate(bakeForDate)}.
            {sheet && (
              <>
                {" "}· Last saved {new Date(sheet.updated_at).toLocaleString()}
                {sheet.created_by ? ` by ${sheet.created_by}` : ""}.
              </>
            )}
          </p>

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
                        <th className="px-3 py-2">Expected</th>
                        <th className="px-3 py-2">On Hand</th>
                        {!sheet && <th className="px-3 py-2">Suggestions</th>}
                        <th className="px-3 py-2">Bake Qty</th>
                        <th className="px-3 py-2">Baked</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {items.map((item) => {
                        const exp = expectedByItem[item.item_id] ?? 0;
                        const raw = rawNeedFor(item.item_id);
                        // ×12 and ×10: nearest multiple, ties round down.
                        // Buttons that would exceed Expected are hidden
                        // (no point suggesting we bake more than we'll
                        // sell). ×6 is the "unpopular flavor" option:
                        // floor-only and only shown when Expected ≤ 12.
                        // Buttons whose value is 0 are also hidden — they
                        // add visual noise and Bake Qty defaults to 0
                        // already, so a "0" button is redundant.
                        const allSuggestions: Array<{ multiple: number; value: number }> = [
                          { multiple: 12, value: roundToNearest(raw, 12) },
                          { multiple: 10, value: roundToNearest(raw, 10) },
                        ];
                        if (exp <= 12) {
                          allSuggestions.push({ multiple: 6, value: Math.floor(raw / 6) * 6 });
                        }
                        const suggestions = allSuggestions.filter(
                          (s) => s.value > 0 && s.value <= exp,
                        );
                        const bakeTarget = parseInt(bakeQty[item.item_id] ?? "0", 10) || 0;
                        const bakedNum = parseInt(bakedQty[item.item_id] ?? "0", 10) || 0;
                        // Auto-done when Bake Qty is 0 on a saved sheet —
                        // nothing to bake, so the baker can't "tick it
                        // off", but it should still read as resolved.
                        const fullyDone = !!sheet && bakedNum >= bakeTarget;
                        const inProgress = !!sheet && bakedNum > 0 && bakedNum < bakeTarget;
                        const rowClass = fullyDone
                          ? "bg-emerald-500/10"
                          : inProgress
                            ? "bg-amber-500/10"
                            : "";
                        const bakedSaving = bakedSavingItemId === item.item_id;
                        return (
                          <tr key={item.item_id} className={`text-slate-200 ${rowClass}`}>
                            <td className="px-3 py-2 font-medium">{item.name}</td>
                            <td className="px-3 py-2 text-slate-300">{exp}</td>
                            <td className="px-2 py-1">
                              <input
                                type="number"
                                min="0"
                                step="1"
                                inputMode="numeric"
                                value={onHand[item.item_id] ?? ""}
                                onChange={(e) =>
                                  setOnHand((prev) => ({ ...prev, [item.item_id]: e.target.value }))
                                }
                                placeholder="0"
                                className="w-20 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-white outline-none focus:border-cyan-400"
                              />
                            </td>
                            {!sheet && (
                              <td className="px-2 py-1">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  {suggestions.map((s) => {
                                    const active = bakeTarget === s.value && bakeQty[item.item_id] !== undefined && bakeQty[item.item_id] !== "";
                                    return (
                                      <button
                                        key={s.multiple}
                                        type="button"
                                        onClick={() => applySuggestion(item.item_id, s.value)}
                                        className={`flex flex-col items-center justify-center rounded-xl px-3 py-1.5 text-sm font-semibold transition ${
                                          active
                                            ? "bg-cyan-500 text-slate-950 hover:bg-cyan-400"
                                            : "bg-slate-800 text-slate-200 hover:bg-slate-700"
                                        }`}
                                        title={`Round to nearest multiple of ${s.multiple}`}
                                      >
                                        <span>{s.value}</span>
                                        <span className="text-[10px] opacity-70 leading-none">×{s.multiple}</span>
                                      </button>
                                    );
                                  })}
                                </div>
                              </td>
                            )}
                            <td className="px-2 py-1">
                              <input
                                type="number"
                                min="0"
                                step="1"
                                inputMode="numeric"
                                value={bakeQty[item.item_id] ?? ""}
                                onChange={(e) =>
                                  setBakeQty((prev) => ({ ...prev, [item.item_id]: e.target.value }))
                                }
                                placeholder="0"
                                className="w-20 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-white outline-none focus:border-cyan-400"
                              />
                            </td>
                            <td className="px-2 py-1">
                              {!sheet ? (
                                <span className="text-xs text-slate-500">Save sheet first</span>
                              ) : bakeTarget === 0 ? (
                                <span className="inline-flex items-center whitespace-nowrap rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-semibold text-emerald-300">
                                  ✓ Done
                                </span>
                              ) : (
                                <div className="flex items-center gap-2 flex-wrap">
                                  <input
                                    type="number"
                                    min="0"
                                    step="1"
                                    inputMode="numeric"
                                    value={bakedQty[item.item_id] ?? "0"}
                                    onChange={(e) =>
                                      setBakedQty((prev) => ({
                                        ...prev,
                                        [item.item_id]: e.target.value,
                                      }))
                                    }
                                    onBlur={() => commitBakedInput(item.item_id)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") {
                                        (e.target as HTMLInputElement).blur();
                                      }
                                    }}
                                    disabled={bakedSaving}
                                    className="w-14 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-white outline-none focus:border-cyan-400"
                                  />
                                  <span className="text-xs text-slate-500">/ {bakeTarget}</span>
                                  <button
                                    type="button"
                                    onClick={() => markFullyBaked(item.item_id)}
                                    disabled={bakedSaving || bakeTarget === 0}
                                    className={`rounded-full px-2 py-1 text-xs font-semibold transition disabled:opacity-50 ${
                                      fullyDone
                                        ? "bg-emerald-500 text-slate-950 hover:bg-emerald-400"
                                        : "bg-slate-800 text-slate-200 hover:bg-slate-700"
                                    }`}
                                  >
                                    {fullyDone ? "✓ Done" : "Done"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => markHalfBaked(item.item_id)}
                                    disabled={bakedSaving || bakeTarget === 0}
                                    className="rounded-full bg-slate-800 px-2 py-1 text-xs font-semibold text-slate-200 transition hover:bg-slate-700 disabled:opacity-50"
                                  >
                                    ½
                                  </button>
                                  {bakedNum > 0 && (
                                    <button
                                      type="button"
                                      onClick={() => updateBakedQty(item.item_id, 0)}
                                      disabled={bakedSaving}
                                      className="text-xs text-slate-400 hover:text-slate-200"
                                      title="Reset baked progress for this item"
                                    >
                                      reset
                                    </button>
                                  )}
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || items.length === 0}
                  className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
                >
                  {saving ? "Saving..." : sheet ? "Update Sheet" : "Save Sheet"}
                </button>
                {sheet && !confirmStartFresh && (
                  <button
                    type="button"
                    onClick={() => setConfirmStartFresh(true)}
                    className="rounded-full bg-slate-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-600"
                  >
                    Start Fresh
                  </button>
                )}
                {sheet && confirmStartFresh && (
                  <>
                    <span className="text-sm text-rose-300">This will erase the current sheet. Continue?</span>
                    <button
                      type="button"
                      onClick={handleStartFresh}
                      className="rounded-full bg-rose-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-rose-400"
                    >
                      Confirm Start Fresh
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmStartFresh(false)}
                      className="rounded-full bg-slate-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-600"
                    >
                      Cancel
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
