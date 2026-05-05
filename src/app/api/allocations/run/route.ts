import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest, NextResponse } from "next/server";

const RESERVE_PER_FACTORY_ITEM = 1;

type StockEntry = {
  cycle_id: string;
  store_id: string;
  item_id: string;
  current_count: number;
};

type Item = {
  id: string;
  type: "manufactured" | "purchased";
  supplier_id: string | null;
};

type FactoryCount = {
  cycle_id: string;
  factory_id: string;
  item_id: string;
  available_qty: number;
};

type StoreFactory = {
  store_id: string;
  factory_id: string;
  priority: number;
};

type Override = {
  cycle_id: string;
  store_id: string;
  item_id: string;
  qty: number;
};

type CycleStore = {
  store_id: string;
};

type AllocationRow = {
  cycle_id: string;
  store_id: string;
  item_id: string;
  qty: number;
  source: "factory" | "purchase" | "manual_override";
  factory_id: string | null;
  shortfall: number;
};

type FactorySplit = {
  cycle_id: string;
  store_id: string;
  item_id: string;
  factory_id: string;
  qty: number;
};

const tupleKey = (storeId: string, itemId: string) => `${storeId}|${itemId}`;
const availableKey = (factoryId: string, itemId: string) => `${factoryId}|${itemId}`;

export async function POST(request: NextRequest) {
  let cycle_id: string | undefined;
  try {
    ({ cycle_id } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!cycle_id) {
    return NextResponse.json({ error: "cycle_id is required" }, { status: 400 });
  }

  const [
    stockRes,
    factoryRes,
    storeFactoryRes,
    overrideRes,
    itemsRes,
    cycleStoresRes,
  ] = await Promise.all([
    supabaseAdmin
      .from("stock_entries")
      .select("cycle_id,store_id,item_id,current_count")
      .eq("cycle_id", cycle_id)
      .gt("current_count", 0),
    supabaseAdmin
      .from("factory_counts")
      .select("cycle_id,factory_id,item_id,available_qty")
      .eq("cycle_id", cycle_id),
    supabaseAdmin
      .from("store_factories")
      .select("store_id,factory_id,priority"),
    supabaseAdmin
      .from("allocation_overrides")
      .select("cycle_id,store_id,item_id,qty")
      .eq("cycle_id", cycle_id),
    supabaseAdmin
      .from("items")
      .select("id,type,supplier_id"),
    supabaseAdmin
      .from("cycle_stores")
      .select("store_id")
      .eq("cycle_id", cycle_id),
  ]);

  for (const res of [stockRes, factoryRes, storeFactoryRes, overrideRes, itemsRes, cycleStoresRes]) {
    if (res.error) {
      return NextResponse.json({ error: res.error.message }, { status: 500 });
    }
  }

  const stockEntries = (stockRes.data ?? []) as StockEntry[];
  const factoryCounts = (factoryRes.data ?? []) as FactoryCount[];
  const storeFactories = (storeFactoryRes.data ?? []) as StoreFactory[];
  const overrides = (overrideRes.data ?? []) as Override[];
  const items = (itemsRes.data ?? []) as Item[];
  const cycleStores = (cycleStoresRes.data ?? []) as CycleStore[];

  // If cycle_stores has rows for this cycle, only those stores participate.
  // Empty set means "no restriction" (every store with input is allowed).
  const enforceCycleStores = cycleStores.length > 0;
  const allowedStoreIds = new Set(cycleStores.map((c) => c.store_id));

  // Wipe existing allocations for the cycle. allocation_factories has FK with cascade,
  // so deleting allocations removes its per-factory rows too.
  const { error: delAllocErr } = await supabaseAdmin
    .from("allocations")
    .delete()
    .eq("cycle_id", cycle_id);
  if (delAllocErr) {
    return NextResponse.json({ error: delAllocErr.message }, { status: 500 });
  }
  const { error: delPoErr } = await supabaseAdmin
    .from("purchase_orders")
    .delete()
    .eq("cycle_id", cycle_id);
  if (delPoErr) {
    return NextResponse.json({ error: delPoErr.message }, { status: 500 });
  }

  const itemsById = new Map(items.map((i) => [i.id, i]));

  // Index store_factories by store, sorted by priority.
  const sfByStore = new Map<string, StoreFactory[]>();
  for (const sf of storeFactories) {
    const list = sfByStore.get(sf.store_id) ?? [];
    list.push(sf);
    sfByStore.set(sf.store_id, list);
  }
  for (const list of sfByStore.values()) {
    list.sort((a, b) => a.priority - b.priority);
  }

  // Running available stock per (factory, item) after the per-item reserve.
  const availableMap = new Map<string, number>();
  for (const fc of factoryCounts) {
    const allocatable = Math.max(0, fc.available_qty - RESERVE_PER_FACTORY_ITEM);
    availableMap.set(availableKey(fc.factory_id, fc.item_id), allocatable);
  }

  // Build the union of (store, item) tuples to allocate for. Overrides without a stock entry
  // still produce an allocation — HQ can force a qty even when the store didn't enter.
  const stockEntryByKey = new Map<string, StockEntry>();
  for (const e of stockEntries) {
    if (enforceCycleStores && !allowedStoreIds.has(e.store_id)) continue;
    stockEntryByKey.set(tupleKey(e.store_id, e.item_id), e);
  }
  const overrideByKey = new Map<string, Override>();
  for (const o of overrides) {
    if (enforceCycleStores && !allowedStoreIds.has(o.store_id)) continue;
    overrideByKey.set(tupleKey(o.store_id, o.item_id), o);
  }

  const tupleKeys = new Set<string>([
    ...stockEntryByKey.keys(),
    ...overrideByKey.keys(),
  ]);

  const allocationRows: AllocationRow[] = [];
  const factorySplits: FactorySplit[] = [];
  type PurchaseLine = { supplier_id: string; item_id: string; qty: number };
  const purchaseLines: PurchaseLine[] = [];

  for (const key of tupleKeys) {
    const [store_id, item_id] = key.split("|");
    const stock = stockEntryByKey.get(key);
    const override = overrideByKey.get(key);

    // Override qty replaces the stock-entry qty as the "needed" amount.
    // Allocation still runs through factories / POs; source records who set the qty.
    const needed = override ? override.qty : stock!.current_count;
    if (needed <= 0) continue;

    const item = itemsById.get(item_id);
    if (!item) continue;

    const baseSource: AllocationRow["source"] = override
      ? "manual_override"
      : item.type === "manufactured"
        ? "factory"
        : "purchase";

    if (item.type === "manufactured") {
      let remaining = needed;
      let fulfilled = 0;
      let primaryFactoryId: string | null = null;

      const factories = sfByStore.get(store_id) ?? [];
      for (const sf of factories) {
        if (remaining === 0) break;
        const k = availableKey(sf.factory_id, item_id);
        const avail = availableMap.get(k) ?? 0;
        if (avail <= 0) continue;
        const take = Math.min(remaining, avail);
        availableMap.set(k, avail - take);
        if (primaryFactoryId === null) primaryFactoryId = sf.factory_id;
        fulfilled += take;
        remaining -= take;

        factorySplits.push({
          cycle_id: cycle_id!,
          store_id,
          item_id,
          factory_id: sf.factory_id,
          qty: take,
        });
      }

      allocationRows.push({
        cycle_id: cycle_id!,
        store_id,
        item_id,
        qty: fulfilled,
        source: baseSource,
        factory_id: primaryFactoryId,
        shortfall: needed - fulfilled,
      });
    } else if (item.type === "purchased") {
      allocationRows.push({
        cycle_id: cycle_id!,
        store_id,
        item_id,
        qty: needed,
        source: baseSource,
        factory_id: null,
        shortfall: 0,
      });

      if (item.supplier_id) {
        purchaseLines.push({
          supplier_id: item.supplier_id,
          item_id,
          qty: needed,
        });
      }
    }
  }

  if (allocationRows.length > 0) {
    const { error: insertError } = await supabaseAdmin
      .from("allocations")
      .insert(allocationRows);
    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }
  }

  // Per-factory split rows depend on allocations existing (FK), so insert second.
  if (factorySplits.length > 0) {
    const { error: splitError } = await supabaseAdmin
      .from("allocation_factories")
      .insert(factorySplits);
    if (splitError) {
      return NextResponse.json({ error: splitError.message }, { status: 500 });
    }
  }

  let purchaseOrdersCreated = 0;
  if (purchaseLines.length > 0) {
    const linesBySupplier = new Map<string, Map<string, number>>();
    for (const line of purchaseLines) {
      const itemMap = linesBySupplier.get(line.supplier_id) ?? new Map<string, number>();
      itemMap.set(line.item_id, (itemMap.get(line.item_id) ?? 0) + line.qty);
      linesBySupplier.set(line.supplier_id, itemMap);
    }

    for (const [supplier_id, itemMap] of linesBySupplier) {
      const { data: poData, error: poError } = await supabaseAdmin
        .from("purchase_orders")
        .insert([{ cycle_id, supplier_id, status: "pending" }])
        .select("id")
        .single();
      if (poError || !poData) {
        return NextResponse.json(
          { error: poError?.message ?? "Failed to create purchase order" },
          { status: 500 },
        );
      }

      const lineRows = Array.from(itemMap.entries()).map(([item_id, qty]) => ({
        po_id: poData.id,
        item_id,
        qty,
      }));
      const { error: linesError } = await supabaseAdmin
        .from("po_lines")
        .insert(lineRows);
      if (linesError) {
        return NextResponse.json({ error: linesError.message }, { status: 500 });
      }
      purchaseOrdersCreated++;
    }
  }

  const shortfalls = allocationRows.reduce(
    (sum, a) => sum + (a.shortfall > 0 ? 1 : 0),
    0,
  );

  return NextResponse.json({
    message: "Allocations completed",
    allocations_created: allocationRows.length,
    factory_splits_created: factorySplits.length,
    purchase_orders_created: purchaseOrdersCreated,
    shortfalls,
    cycle_id,
  });
}
