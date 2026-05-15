"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

type Store = { id: string; name: string };

type Item = {
  id: string;
  name: string;
  cost_per_unit: number | null;
  retail_price_per_unit: number | null;
};

type WasteEntry = {
  id: string;
  store_id: string;
  item_id: string;
  quantity: number;
  reason: string;
  reason_other: string | null;
  wasted_on: string; // YYYY-MM-DD
  recorded_by: string | null;
};

type PeriodPreset = "last7" | "last30" | "last90" | "thisMonth" | "thisYear" | "custom";

type CompareMode = "none" | "previous" | "lastYear";

// All dates handled here are calendar dates (YYYY-MM-DD), no time component —
// that's what `wasted_on` stores. We avoid Date arithmetic for ranges and use
// ISO string slicing to dodge timezone surprises.
function ymd(d: Date): string {
  const tzOffsetMs = d.getTimezoneOffset() * 60 * 1000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 10);
}

function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d);
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

function diffDays(start: Date, end: Date): number {
  const ms = parseYmd(ymd(end)).getTime() - parseYmd(ymd(start)).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function presetRange(preset: PeriodPreset, custom: { start: string; end: string }): {
  start: string;
  end: string;
} {
  const today = new Date();
  switch (preset) {
    case "last7":
      return { start: ymd(addDays(today, -6)), end: ymd(today) };
    case "last30":
      return { start: ymd(addDays(today, -29)), end: ymd(today) };
    case "last90":
      return { start: ymd(addDays(today, -89)), end: ymd(today) };
    case "thisMonth":
      return {
        start: ymd(new Date(today.getFullYear(), today.getMonth(), 1)),
        end: ymd(today),
      };
    case "thisYear":
      return {
        start: ymd(new Date(today.getFullYear(), 0, 1)),
        end: ymd(today),
      };
    case "custom":
      return { start: custom.start, end: custom.end };
  }
}

function comparisonRange(
  current: { start: string; end: string },
  mode: CompareMode,
): { start: string; end: string } | null {
  if (mode === "none" || !current.start || !current.end) return null;
  const startD = parseYmd(current.start);
  const endD = parseYmd(current.end);
  if (mode === "previous") {
    const len = diffDays(startD, endD) + 1; // inclusive
    const prevEnd = addDays(startD, -1);
    const prevStart = addDays(prevEnd, -(len - 1));
    return { start: ymd(prevStart), end: ymd(prevEnd) };
  }
  // lastYear: shift by exactly 1 calendar year. Handles leap years naively
  // (Feb 29 → Feb 28 prev year via Date constructor).
  const prevStart = new Date(startD.getFullYear() - 1, startD.getMonth(), startD.getDate());
  const prevEnd = new Date(endD.getFullYear() - 1, endD.getMonth(), endD.getDate());
  return { start: ymd(prevStart), end: ymd(prevEnd) };
}

type AggRow = {
  key: string;
  label: string;
  qty: number;
  costLost: number;
  profitLost: number;
};

function aggregate(
  entries: WasteEntry[],
  keyOf: (e: WasteEntry) => string,
  labelOf: (e: WasteEntry) => string,
  itemMap: Map<string, Item>,
): AggRow[] {
  const groups = new Map<string, AggRow>();
  for (const entry of entries) {
    const k = keyOf(entry);
    const item = itemMap.get(entry.item_id);
    const cost = item?.cost_per_unit ?? 0;
    const retail = item?.retail_price_per_unit ?? 0;
    const profitPerUnit = Math.max(retail - cost, 0);
    const existing = groups.get(k) ?? {
      key: k,
      label: labelOf(entry),
      qty: 0,
      costLost: 0,
      profitLost: 0,
    };
    existing.qty += entry.quantity;
    existing.costLost += entry.quantity * cost;
    existing.profitLost += entry.quantity * profitPerUnit;
    groups.set(k, existing);
  }
  return Array.from(groups.values()).sort((a, b) => b.qty - a.qty);
}

const fmtCurrency = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDelta = (current: number, prev: number): { text: string; cls: string } => {
  if (prev === 0 && current === 0) return { text: "—", cls: "text-slate-500" };
  if (prev === 0) return { text: "new", cls: "text-rose-300" };
  const delta = ((current - prev) / prev) * 100;
  const sign = delta > 0 ? "▲" : delta < 0 ? "▼" : "·";
  // For waste, increase is bad (rose) and decrease is good (emerald).
  const cls =
    delta > 0 ? "text-rose-300" : delta < 0 ? "text-emerald-300" : "text-slate-400";
  return { text: `${sign} ${Math.abs(delta).toFixed(1)}%`, cls };
};

const formatRangeLabel = (r: { start: string; end: string } | null) => {
  if (!r || !r.start || !r.end) return "—";
  if (r.start === r.end) return parseYmd(r.start).toLocaleDateString();
  return `${parseYmd(r.start).toLocaleDateString()} – ${parseYmd(r.end).toLocaleDateString()}`;
};

export default function AdminWasteAnalytics() {
  const { loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
  const [stores, setStores] = useState<Store[]>([]);
  const [storeFilter, setStoreFilter] = useState<string>(""); // "" = all
  const [period, setPeriod] = useState<PeriodPreset>("last30");
  const [customStart, setCustomStart] = useState<string>(ymd(new Date()));
  const [customEnd, setCustomEnd] = useState<string>(ymd(new Date()));
  const [compareMode, setCompareMode] = useState<CompareMode>("none");
  const [items, setItems] = useState<Item[]>([]);
  const [entries, setEntries] = useState<WasteEntry[]>([]);
  const [breakdown, setBreakdown] = useState<"item" | "reason" | "item_reason">("item");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isStoreManager) return;
    const loadStores = async () => {
      const { data } = await supabase.from("stores").select("id,name").order("name");
      if (data) setStores(data as Store[]);
    };
    loadStores();
  }, [isStoreManager]);

  const currentRange = useMemo(
    () => presetRange(period, { start: customStart, end: customEnd }),
    [period, customStart, customEnd],
  );
  const compareRange = useMemo(
    () => comparisonRange(currentRange, compareMode),
    [currentRange, compareMode],
  );

  // The fetch range is the union of current + comparison so we make a single
  // round trip. Aggregation later partitions entries into current vs prior.
  const fetchRange = useMemo(() => {
    if (!compareRange) return currentRange;
    return {
      start: compareRange.start < currentRange.start ? compareRange.start : currentRange.start,
      end: compareRange.end > currentRange.end ? compareRange.end : currentRange.end,
    };
  }, [currentRange, compareRange]);

  const loadData = useCallback(async () => {
    if (!isStoreManager) {
      setEntries([]);
      setItems([]);
      return;
    }
    if (!fetchRange.start || !fetchRange.end) {
      setEntries([]);
      return;
    }
    setLoading(true);
    setMessage(null);
    let entriesQuery = supabase
      .from("waste_log_entries")
      .select("id,store_id,item_id,quantity,reason,reason_other,wasted_on,recorded_by")
      .gte("wasted_on", fetchRange.start)
      .lte("wasted_on", fetchRange.end);
    if (storeFilter) entriesQuery = entriesQuery.eq("store_id", storeFilter);
    const [entriesRes, itemsRes] = await Promise.all([
      entriesQuery,
      supabase.from("items").select("id,name,cost_per_unit,retail_price_per_unit"),
    ]);
    setLoading(false);
    if (entriesRes.error) {
      setMessage(`Couldn't load waste entries: ${entriesRes.error.message}`);
      setEntries([]);
      return;
    }
    if (itemsRes.error) {
      setMessage(`Couldn't load items: ${itemsRes.error.message}`);
      setItems([]);
      return;
    }
    setEntries(
      ((entriesRes.data as WasteEntry[]) ?? []).map((e) => ({
        ...e,
        quantity: Number(e.quantity),
      })),
    );
    setItems(
      ((itemsRes.data as Item[]) ?? []).map((i) => ({
        ...i,
        cost_per_unit: i.cost_per_unit === null ? null : Number(i.cost_per_unit),
        retail_price_per_unit:
          i.retail_price_per_unit === null ? null : Number(i.retail_price_per_unit),
      })),
    );
  }, [isStoreManager, fetchRange.start, fetchRange.end, storeFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Refresh when waste entries or item pricing changes anywhere — keeps the
  // dashboard in sync without a manual reload.
  useRealtimeRefetch(
    isStoreManager
      ? [
          { table: "waste_log_entries" },
          { table: "items" },
        ]
      : [],
    loadData,
    "admin-waste-analytics",
  );

  const itemMap = useMemo(() => {
    const map = new Map<string, Item>();
    for (const i of items) map.set(i.id, i);
    return map;
  }, [items]);

  const inRange = (e: WasteEntry, r: { start: string; end: string }) =>
    e.wasted_on >= r.start && e.wasted_on <= r.end;

  const currentEntries = useMemo(
    () => entries.filter((e) => inRange(e, currentRange)),
    [entries, currentRange],
  );
  const prevEntries = useMemo(
    () => (compareRange ? entries.filter((e) => inRange(e, compareRange)) : []),
    [entries, compareRange],
  );

  const totals = (es: WasteEntry[]) => {
    let qty = 0;
    let costLost = 0;
    let profitLost = 0;
    for (const e of es) {
      const item = itemMap.get(e.item_id);
      const cost = item?.cost_per_unit ?? 0;
      const retail = item?.retail_price_per_unit ?? 0;
      const profitPerUnit = Math.max(retail - cost, 0);
      qty += e.quantity;
      costLost += e.quantity * cost;
      profitLost += e.quantity * profitPerUnit;
    }
    return { qty, costLost, profitLost };
  };

  const currentTotals = useMemo(() => totals(currentEntries), [currentEntries, itemMap]);
  const prevTotals = useMemo(() => totals(prevEntries), [prevEntries, itemMap]);

  const byItemCurrent = useMemo(
    () =>
      aggregate(
        currentEntries,
        (e) => e.item_id,
        (e) => itemMap.get(e.item_id)?.name ?? e.item_id,
        itemMap,
      ),
    [currentEntries, itemMap],
  );
  const byItemPrev = useMemo(
    () =>
      aggregate(
        prevEntries,
        (e) => e.item_id,
        (e) => itemMap.get(e.item_id)?.name ?? e.item_id,
        itemMap,
      ),
    [prevEntries, itemMap],
  );

  const reasonKey = (e: WasteEntry) =>
    e.reason === "Other" && e.reason_other ? `Other: ${e.reason_other}` : e.reason;

  const byReasonCurrent = useMemo(
    () => aggregate(currentEntries, reasonKey, reasonKey, itemMap),
    [currentEntries, itemMap],
  );
  const byReasonPrev = useMemo(
    () => aggregate(prevEntries, reasonKey, reasonKey, itemMap),
    [prevEntries, itemMap],
  );

  // Joined views: rows that appear in either period so we can show deltas.
  const joinRows = (current: AggRow[], prev: AggRow[]): Array<{
    key: string;
    label: string;
    current: AggRow | null;
    prev: AggRow | null;
  }> => {
    const prevMap = new Map(prev.map((r) => [r.key, r] as const));
    const rows: Array<{ key: string; label: string; current: AggRow | null; prev: AggRow | null }> = [];
    for (const r of current) {
      rows.push({ key: r.key, label: r.label, current: r, prev: prevMap.get(r.key) ?? null });
      prevMap.delete(r.key);
    }
    // Anything that existed in prev but not in current → still surface (qty=0).
    for (const r of prevMap.values()) {
      rows.push({ key: r.key, label: r.label, current: null, prev: r });
    }
    return rows.sort((a, b) => (b.current?.qty ?? 0) - (a.current?.qty ?? 0));
  };

  const itemRows = useMemo(() => joinRows(byItemCurrent, byItemPrev), [byItemCurrent, byItemPrev]);
  const reasonRows = useMemo(
    () => joinRows(byReasonCurrent, byReasonPrev),
    [byReasonCurrent, byReasonPrev],
  );

  // Cross-reference: every (item, reason) pair as its own row. Lets the
  // admin answer "which flavour was wasted because of X" instead of just
  // one axis at a time.
  const itemReasonKey = (e: WasteEntry) => `${e.item_id}|${reasonKey(e)}`;
  const itemReasonLabel = (e: WasteEntry) => {
    const name = itemMap.get(e.item_id)?.name ?? e.item_id;
    return `${name} · ${reasonKey(e)}`;
  };
  const byItemReasonCurrent = useMemo(
    () => aggregate(currentEntries, itemReasonKey, itemReasonLabel, itemMap),
    [currentEntries, itemMap],
  );
  const byItemReasonPrev = useMemo(
    () => aggregate(prevEntries, itemReasonKey, itemReasonLabel, itemMap),
    [prevEntries, itemMap],
  );
  const itemReasonRows = useMemo(
    () => joinRows(byItemReasonCurrent, byItemReasonPrev),
    [byItemReasonCurrent, byItemReasonPrev],
  );

  // Daily series for the line chart. Covers every day in the current
  // range (including zeros) so the line doesn't skip over empty days.
  const dailySeries = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of currentEntries) {
      map.set(e.wasted_on, (map.get(e.wasted_on) ?? 0) + e.quantity);
    }
    const out: Array<{ date: string; qty: number }> = [];
    if (!currentRange.start || !currentRange.end) return out;
    let cursor = parseYmd(currentRange.start);
    const end = parseYmd(currentRange.end);
    while (cursor <= end) {
      const k = ymd(cursor);
      out.push({ date: k, qty: map.get(k) ?? 0 });
      cursor = addDays(cursor, 1);
    }
    return out;
  }, [currentEntries, currentRange]);

  // Items × reasons matrix for the stacked bar. Reasons are sorted by
  // their global qty so the legend / segment order is stable across items.
  const stackedItemsByReason = useMemo(() => {
    const allReasons = new Set<string>();
    const perItem = new Map<string, Map<string, number>>();
    const totalPerItem = new Map<string, number>();
    for (const e of currentEntries) {
      const r = reasonKey(e);
      allReasons.add(r);
      const itemBucket = perItem.get(e.item_id) ?? new Map<string, number>();
      itemBucket.set(r, (itemBucket.get(r) ?? 0) + e.quantity);
      perItem.set(e.item_id, itemBucket);
      totalPerItem.set(e.item_id, (totalPerItem.get(e.item_id) ?? 0) + e.quantity);
    }
    const reasonTotals = new Map<string, number>();
    for (const bucket of perItem.values()) {
      for (const [r, q] of bucket) {
        reasonTotals.set(r, (reasonTotals.get(r) ?? 0) + q);
      }
    }
    const reasons = Array.from(allReasons).sort(
      (a, b) => (reasonTotals.get(b) ?? 0) - (reasonTotals.get(a) ?? 0),
    );
    const itemIds = Array.from(perItem.keys()).sort(
      (a, b) => (totalPerItem.get(b) ?? 0) - (totalPerItem.get(a) ?? 0),
    );
    return {
      reasons,
      rows: itemIds.map((id) => ({
        item_id: id,
        item_name: itemMap.get(id)?.name ?? id,
        total: totalPerItem.get(id) ?? 0,
        byReason: perItem.get(id) ?? new Map<string, number>(),
      })),
    };
  }, [currentEntries, itemMap]);

  const missingPriceCount = useMemo(() => {
    const seen = new Set<string>();
    for (const e of currentEntries) {
      const item = itemMap.get(e.item_id);
      if (!item) continue;
      if (item.cost_per_unit === null || item.retail_price_per_unit === null) {
        seen.add(item.id);
      }
    }
    return seen.size;
  }, [currentEntries, itemMap]);

  const comparing = compareMode !== "none" && !!compareRange;

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-white">Waste Analytics</h1>
          <p className="mt-3 text-slate-400">
            See waste trends by item and reason, plus the money lost. Compare time periods to see what&apos;s getting better or worse.
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
          <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-5 space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-400">Period</label>
                <select
                  value={period}
                  onChange={(e) => setPeriod(e.target.value as PeriodPreset)}
                  className="mt-1 rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                >
                  <option value="last7">Last 7 days</option>
                  <option value="last30">Last 30 days</option>
                  <option value="last90">Last 90 days</option>
                  <option value="thisMonth">This month so far</option>
                  <option value="thisYear">This year so far</option>
                  <option value="custom">Custom range</option>
                </select>
              </div>

              {period === "custom" && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-400">Start</label>
                    <input
                      type="date"
                      value={customStart}
                      onChange={(e) => setCustomStart(e.target.value)}
                      onClick={(e) => e.currentTarget.showPicker?.()}
                      className="mt-1 cursor-pointer rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400">End</label>
                    <input
                      type="date"
                      value={customEnd}
                      onChange={(e) => setCustomEnd(e.target.value)}
                      onClick={(e) => e.currentTarget.showPicker?.()}
                      className="mt-1 cursor-pointer rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                    />
                  </div>
                </>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-400">Compare To</label>
                <select
                  value={compareMode}
                  onChange={(e) => setCompareMode(e.target.value as CompareMode)}
                  className="mt-1 rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                >
                  <option value="none">No comparison</option>
                  <option value="previous">Previous equivalent period</option>
                  <option value="lastYear">Same period last year</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400">Store</label>
                <select
                  value={storeFilter}
                  onChange={(e) => setStoreFilter(e.target.value)}
                  className="mt-1 rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                >
                  <option value="">All stores</option>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="text-xs text-slate-500">
              Current: <span className="text-slate-300">{formatRangeLabel(currentRange)}</span>
              {comparing && (
                <>
                  {" "}· Compared To:{" "}
                  <span className="text-slate-300">{formatRangeLabel(compareRange)}</span>
                </>
              )}
            </div>
          </div>

          {message && <p className="text-sm text-rose-300">{message}</p>}

          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryCard
              label="Items Wasted"
              current={currentTotals.qty.toLocaleString()}
              comparing={comparing}
              prev={prevTotals.qty.toLocaleString()}
              delta={fmtDelta(currentTotals.qty, prevTotals.qty)}
            />
            <SummaryCard
              label="Production Cost Lost"
              current={fmtCurrency(currentTotals.costLost)}
              comparing={comparing}
              prev={fmtCurrency(prevTotals.costLost)}
              delta={fmtDelta(currentTotals.costLost, prevTotals.costLost)}
            />
            <SummaryCard
              label="Profit Lost"
              current={fmtCurrency(currentTotals.profitLost)}
              comparing={comparing}
              prev={fmtCurrency(prevTotals.profitLost)}
              delta={fmtDelta(currentTotals.profitLost, prevTotals.profitLost)}
            />
          </div>

          {missingPriceCount > 0 && (
            <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
              {missingPriceCount} item{missingPriceCount === 1 ? "" : "s"} are missing cost or retail prices, so their losses aren&apos;t included here. Set prices on the Items admin page.
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="Daily Waste">
              <LineChart data={dailySeries} />
            </ChartCard>
            <ChartCard title="Reasons">
              <BarList rows={byReasonCurrent} max={10} colorIndex />
            </ChartCard>
            <ChartCard title="Top Items">
              <BarList rows={byItemCurrent} max={10} />
            </ChartCard>
            <ChartCard title="Items by Reason">
              <StackedItemBars
                rows={stackedItemsByReason.rows}
                reasons={stackedItemsByReason.reasons}
                max={10}
              />
            </ChartCard>
          </div>

          <div className="flex items-center justify-between flex-wrap gap-3">
            <h3 className="text-lg font-semibold text-white">Breakdown</h3>
            <div className="flex items-center gap-2">
              <label htmlFor="breakdown" className="text-sm text-slate-400">View by:</label>
              <select
                id="breakdown"
                value={breakdown}
                onChange={(e) =>
                  setBreakdown(e.target.value as "item" | "reason" | "item_reason")
                }
                className="rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
              >
                <option value="item">By Item</option>
                <option value="reason">By Reason</option>
                <option value="item_reason">By Item &amp; Reason</option>
              </select>
            </div>
          </div>

          <BreakdownTable
            title={
              breakdown === "item"
                ? "By Item"
                : breakdown === "reason"
                  ? "By Reason"
                  : "By Item & Reason"
            }
            rows={
              breakdown === "item"
                ? itemRows
                : breakdown === "reason"
                  ? reasonRows
                  : itemReasonRows
            }
            comparing={comparing}
            loading={loading}
          />
        </div>
      )}
    </section>
  );
}

function SummaryCard({
  label,
  current,
  comparing,
  prev,
  delta,
}: {
  label: string;
  current: string;
  comparing: boolean;
  prev: string;
  delta: { text: string; cls: string };
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-5">
      <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</div>
      <div className="mt-2 text-3xl font-semibold text-white">{current}</div>
      {comparing && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="text-slate-500">Prev: {prev}</span>
          <span className={`whitespace-nowrap ${delta.cls}`}>{delta.text}</span>
        </div>
      )}
    </div>
  );
}

function BreakdownTable({
  title,
  rows,
  comparing,
  loading,
}: {
  title: string;
  rows: Array<{ key: string; label: string; current: AggRow | null; prev: AggRow | null }>;
  comparing: boolean;
  loading: boolean;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-5">
      <h3 className="text-lg font-semibold text-white">{title}</h3>
      {loading ? (
        <p className="mt-3 text-sm text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No waste in this period.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Qty</th>
                <th className="px-3 py-2">Cost Lost</th>
                <th className="px-3 py-2">Profit Lost</th>
                {comparing && <th className="px-3 py-2">Δ Qty</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((row) => {
                const qty = row.current?.qty ?? 0;
                const cost = row.current?.costLost ?? 0;
                const profit = row.current?.profitLost ?? 0;
                const prevQty = row.prev?.qty ?? 0;
                const delta = fmtDelta(qty, prevQty);
                return (
                  <tr key={row.key} className="text-slate-200">
                    <td className="px-3 py-2 font-medium">{row.label}</td>
                    <td className="px-3 py-2">{qty.toLocaleString()}</td>
                    <td className="px-3 py-2">{fmtCurrency(cost)}</td>
                    <td className="px-3 py-2">{fmtCurrency(profit)}</td>
                    {comparing && (
                      <td className={`px-3 py-2 whitespace-nowrap ${delta.cls}`}>
                        {delta.text}
                        <span className="ml-1 text-slate-500">({prevQty.toLocaleString()})</span>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Charts ──────────────────────────────────────────────────────────────
// Pure SVG / CSS — no chart library dependency. Designed to look passable
// at a glance, not to win design awards. Each chart degrades gracefully
// when there's no data (renders an empty-state message instead).

// Reason segments rotate through this palette in order. Items don't get
// individual colors (would be unstable as items come and go); they all
// use the same cyan accent.
const REASON_COLORS = [
  "#22d3ee", // cyan-400
  "#fb7185", // rose-400
  "#fbbf24", // amber-400
  "#34d399", // emerald-400
  "#a78bfa", // violet-400
  "#60a5fa", // blue-400
  "#f472b6", // pink-400
  "#facc15", // yellow-400
];
const colorForIndex = (i: number) => REASON_COLORS[i % REASON_COLORS.length];

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-5">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
        {title}
      </h3>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function LineChart({ data }: { data: Array<{ date: string; qty: number }> }) {
  if (data.length === 0) {
    return <p className="text-sm text-slate-500">No waste in this period.</p>;
  }
  const W = 600;
  const H = 180;
  const padL = 32;
  const padR = 12;
  const padT = 10;
  const padB = 24;
  const max = Math.max(1, ...data.map((d) => d.qty));
  const xStep = data.length > 1 ? (W - padL - padR) / (data.length - 1) : 0;
  const yFor = (q: number) => padT + (H - padT - padB) * (1 - q / max);
  const points = data
    .map((d, i) => `${padL + i * xStep},${yFor(d.qty)}`)
    .join(" ");
  // Up to 6 evenly spaced x-axis labels so they don't overlap.
  const labelStep = Math.max(1, Math.ceil(data.length / 6));
  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ minWidth: 320, height: 200 }}
      >
        {/* y-axis grid */}
        {[0, 0.5, 1].map((frac) => {
          const y = padT + (H - padT - padB) * (1 - frac);
          return (
            <g key={frac}>
              <line
                x1={padL}
                x2={W - padR}
                y1={y}
                y2={y}
                stroke="rgb(51 65 85)"
                strokeDasharray="2 3"
              />
              <text x={padL - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#94a3b8">
                {Math.round(max * frac)}
              </text>
            </g>
          );
        })}
        <polyline
          fill="none"
          stroke="#22d3ee"
          strokeWidth="2"
          points={points}
        />
        {data.map((d, i) => (
          <circle
            key={d.date}
            cx={padL + i * xStep}
            cy={yFor(d.qty)}
            r={d.qty > 0 ? 2.5 : 0}
            fill="#22d3ee"
          >
            <title>{`${d.date}: ${d.qty}`}</title>
          </circle>
        ))}
        {data.map((d, i) =>
          i % labelStep === 0 || i === data.length - 1 ? (
            <text
              key={`l${d.date}`}
              x={padL + i * xStep}
              y={H - 6}
              textAnchor="middle"
              fontSize="10"
              fill="#64748b"
            >
              {d.date.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}

function BarList({
  rows,
  max,
  colorIndex = false,
}: {
  rows: AggRow[];
  max: number;
  // When true, each bar gets its own palette color (good for reasons);
  // otherwise everything uses cyan (good for items).
  colorIndex?: boolean;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-slate-500">No waste in this period.</p>;
  }
  const shown = rows.slice(0, max);
  const maxQty = Math.max(1, ...shown.map((r) => r.qty));
  return (
    <div className="space-y-2">
      {shown.map((r, i) => {
        const pct = (r.qty / maxQty) * 100;
        const color = colorIndex ? colorForIndex(i) : "#22d3ee";
        return (
          <div key={r.key}>
            <div className="flex items-baseline justify-between gap-2 text-xs text-slate-300">
              <span className="truncate" title={r.label}>{r.label}</span>
              <span className="font-semibold text-slate-200">{r.qty.toLocaleString()}</span>
            </div>
            <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-950">
              <div
                className="h-full rounded-full"
                style={{ width: `${pct}%`, backgroundColor: color }}
              />
            </div>
          </div>
        );
      })}
      {rows.length > max && (
        <p className="text-xs text-slate-500">
          + {rows.length - max} more (see full table below)
        </p>
      )}
    </div>
  );
}

function StackedItemBars({
  rows,
  reasons,
  max,
}: {
  rows: Array<{ item_id: string; item_name: string; total: number; byReason: Map<string, number> }>;
  reasons: string[];
  max: number;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-slate-500">No waste in this period.</p>;
  }
  const shown = rows.slice(0, max);
  const maxTotal = Math.max(1, ...shown.map((r) => r.total));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {reasons.map((r, i) => (
          <span key={r} className="inline-flex items-center gap-1 text-slate-300">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: colorForIndex(i) }}
            />
            {r}
          </span>
        ))}
      </div>
      <div className="space-y-2">
        {shown.map((row) => {
          const totalPct = (row.total / maxTotal) * 100;
          return (
            <div key={row.item_id}>
              <div className="flex items-baseline justify-between gap-2 text-xs text-slate-300">
                <span className="truncate" title={row.item_name}>{row.item_name}</span>
                <span className="font-semibold text-slate-200">
                  {row.total.toLocaleString()}
                </span>
              </div>
              <div
                className="mt-1 flex h-2.5 overflow-hidden rounded-full bg-slate-950"
                style={{ width: `${totalPct}%` }}
              >
                {reasons.map((r, i) => {
                  const q = row.byReason.get(r) ?? 0;
                  if (q === 0) return null;
                  const segPct = (q / row.total) * 100;
                  return (
                    <div
                      key={r}
                      style={{ width: `${segPct}%`, backgroundColor: colorForIndex(i) }}
                      title={`${r}: ${q}`}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {rows.length > max && (
        <p className="text-xs text-slate-500">+ {rows.length - max} more</p>
      )}
    </div>
  );
}
