import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest, NextResponse } from "next/server";

const RESERVE_PER_FACTORY_ITEM = 1;

type StockEntry = {
  cycle_id: string;
  store_id: string;
  item_id: string;
  current_count: number;
};

type StoreItem = {
  store_id: string;
  item_id: string;
  capacity: number;
};

type Item = {
  id: string;
  type: "manufactured" | "purchased";
  supplier_id: string | null;
};

// Live per-(factory, item) on-hand count. Replaces the old factory_counts
// read which was scoped per-cycle. The allocator now reads inventory
// independent of any cycle and snapshots it back to factory_counts
// post-run for audit.
type FactoryInventoryRow = {
  factory_id: string;
  item_id: string;
  on_hand_qty: number;
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
  mode: "soft" | "hard";
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
  // Amount forced past available factory stock by a hard override.
  // Soft overrides + normal allocations are always 0.
  overdraft: number;
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

  // Block re-running on a delivered cycle. The factory_counts have already
  // been decremented by the delivery step; recomputing allocations would
  // invalidate that decrement and break the audit trail.
  const { data: cycleStatusRow, error: statusErr } = await supabaseAdmin
    .from("order_cycles")
    .select("status")
    .eq("id", cycle_id)
    .single();
  if (statusErr || !cycleStatusRow) {
    return NextResponse.json(
      { error: statusErr?.message ?? "Cycle not found" },
      { status: 404 },
    );
  }
  if (cycleStatusRow.status === "delivered") {
    return NextResponse.json(
      { error: "Cycle is delivered — cannot re-run allocations" },
      { status: 400 },
    );
  }

  // Every participating store must have marked its stock entry finished
  // before allocations can run. This protects against the admin running
  // allocations on a half-submitted cycle.
  const { data: cycleStoresRows, error: csErr } = await supabaseAdmin
    .from("cycle_stores")
    .select("store_id,finished_at,stores(name)")
    .eq("cycle_id", cycle_id);
  if (csErr) {
    return NextResponse.json({ error: csErr.message }, { status: 500 });
  }
  const unfinished = (cycleStoresRows ?? []).filter((cs) => !cs.finished_at) as unknown as Array<{
    store_id: string;
    finished_at: string | null;
    stores: { name: string } | null;
  }>;
  if (unfinished.length > 0) {
    const names = unfinished
      .map((cs) => cs.stores?.name ?? cs.store_id)
      .sort();
    return NextResponse.json(
      {
        error: `Waiting on ${names.length} store${names.length === 1 ? "" : "s"} to mark their stock entry finished: ${names.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const [
    stockRes,
    factoryRes,
    storeFactoryRes,
    overrideRes,
    itemsRes,
    cycleStoresRes,
    storesRes,
    storeItemsRes,
    factoriesRes,
  ] = await Promise.all([
    // current_count is on-hand inventory. We pull all entries (including
    // current_count = 0) because a store with 0 on-hand needs the full
    // capacity — demand is computed below as capacity - current_count.
    supabaseAdmin
      .from("stock_entries")
      .select("cycle_id,store_id,item_id,current_count")
      .eq("cycle_id", cycle_id),
    // Read live factory inventory (no cycle scoping). Post-run we
    // snapshot whatever rows actually fed this allocation into
    // factory_counts(cycle_id, …) for audit.
    supabaseAdmin
      .from("factory_inventory")
      .select("factory_id,item_id,on_hand_qty"),
    supabaseAdmin
      .from("store_factories")
      .select("store_id,factory_id,priority"),
    supabaseAdmin
      .from("allocation_overrides")
      .select("cycle_id,store_id,item_id,qty,mode")
      .eq("cycle_id", cycle_id),
    supabaseAdmin
      .from("items")
      .select("id,type,supplier_id"),
    supabaseAdmin
      .from("cycle_stores")
      .select("store_id")
      .eq("cycle_id", cycle_id),
    supabaseAdmin.from("stores").select("id,tier"),
    supabaseAdmin
      .from("store_items")
      .select("store_id,item_id,capacity")
      .eq("is_active", true),
    supabaseAdmin.from("factories").select("id,name"),
  ]);

  for (const res of [
    stockRes,
    factoryRes,
    storeFactoryRes,
    overrideRes,
    itemsRes,
    cycleStoresRes,
    storesRes,
    storeItemsRes,
    factoriesRes,
  ]) {
    if (res.error) {
      return NextResponse.json({ error: res.error.message }, { status: 500 });
    }
  }

  const stockEntries = (stockRes.data ?? []) as StockEntry[];
  const factoryInventory = (factoryRes.data ?? []) as FactoryInventoryRow[];
  const storeFactories = (storeFactoryRes.data ?? []) as StoreFactory[];
  const overrides = (overrideRes.data ?? []) as Override[];
  const items = (itemsRes.data ?? []) as Item[];
  const cycleStores = (cycleStoresRes.data ?? []) as CycleStore[];
  const stores = (storesRes.data ?? []) as Array<{ id: string; tier: number }>;
  const storeItems = (storeItemsRes.data ?? []) as StoreItem[];
  const capacityByKey = new Map<string, number>();
  for (const si of storeItems) {
    capacityByKey.set(tupleKey(si.store_id, si.item_id), si.capacity);
  }
  const tierByStore = new Map(stores.map((s) => [s.id, s.tier]));
  const tierOf = (storeId: string) => tierByStore.get(storeId) ?? 999;

  // cycle_stores is the membership set: only stores listed there participate.
  // Empty cycle_stores means nobody is in the cycle — no allocations get
  // produced even if stock_entries or overrides exist for other stores.
  const allowedStoreIds = new Set(cycleStores.map((c) => c.store_id));

  // Every factory that any participating store routes to must have entered
  // at least one factory_count row for this cycle. Without counts we'd
  // assume 0 stock and report bogus shortfalls for every manufactured
  // item, so block the run with a clear message naming the laggards.
  const participatingFactoryIds = new Set<string>();
  for (const sf of storeFactories) {
    if (allowedStoreIds.has(sf.store_id)) {
      participatingFactoryIds.add(sf.factory_id);
    }
  }
  const factoriesWithCounts = new Set(
    factoryInventory.map((fc) => fc.factory_id),
  );
  const missingFactoryIds = [...participatingFactoryIds].filter(
    (id) => !factoriesWithCounts.has(id),
  );
  if (missingFactoryIds.length > 0) {
    const factoryNameById = new Map(
      (factoriesRes.data ?? []).map((f: { id: string; name: string }) => [
        f.id,
        f.name,
      ]),
    );
    const names = missingFactoryIds
      .map((id) => factoryNameById.get(id) ?? id)
      .sort();
    return NextResponse.json(
      {
        error: `Waiting on ${names.length} ${names.length === 1 ? "factory" : "factories"} to enter counts: ${names.join(", ")}`,
      },
      { status: 400 },
    );
  }

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
  for (const fc of factoryInventory) {
    const allocatable = Math.max(0, fc.on_hand_qty - RESERVE_PER_FACTORY_ITEM);
    availableMap.set(availableKey(fc.factory_id, fc.item_id), allocatable);
  }

  // Build the union of (store, item) tuples to allocate for. Overrides without a stock entry
  // still produce an allocation — HQ can force a qty even when the store didn't enter.
  const stockEntryByKey = new Map<string, StockEntry>();
  for (const e of stockEntries) {
    if (!allowedStoreIds.has(e.store_id)) continue;
    stockEntryByKey.set(tupleKey(e.store_id, e.item_id), e);
  }
  const overrideByKey = new Map<string, Override>();
  for (const o of overrides) {
    if (!allowedStoreIds.has(o.store_id)) continue;
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

  // Manufactured items go through a priority-fair pass below. Purchased
  // items create allocations and PO lines directly here since they don't
  // touch factory stock.
  type ManufacturedState = {
    store_id: string;
    item_id: string;
    needed: number;
    fulfilled: number;
    primaryFactoryId: string | null;
    source: AllocationRow["source"];
    // 'hard' overrides ignore factory availability and are force-fulfilled
    // in phase 3 (factory stock may go negative).
    overrideMode: Override["mode"] | null;
    // How much phase 3 had to force past available stock.
    overdraft: number;
  };
  const manufacturedStates = new Map<string, ManufacturedState>();

  for (const key of tupleKeys) {
    const [store_id, item_id] = key.split("|");
    const stock = stockEntryByKey.get(key);
    const override = overrideByKey.get(key);

    // Demand = capacity - on-hand. The store enters current_count (what
    // they have); we pull up to their per-item capacity (par level). A
    // hard/soft override replaces this calculation entirely — overrides
    // are an absolute qty, not a delta.
    let needed: number;
    if (override) {
      needed = override.qty;
    } else {
      const capacity = capacityByKey.get(key) ?? 0;
      needed = Math.max(0, capacity - stock!.current_count);
    }
    if (needed <= 0) continue;

    const item = itemsById.get(item_id);
    if (!item) continue;

    const baseSource: AllocationRow["source"] = override
      ? "manual_override"
      : item.type === "manufactured"
        ? "factory"
        : "purchase";

    if (item.type === "manufactured") {
      manufacturedStates.set(key, {
        store_id,
        item_id,
        needed,
        fulfilled: 0,
        primaryFactoryId: null,
        source: baseSource,
        overrideMode: override?.mode ?? null,
        overdraft: 0,
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
        overdraft: 0,
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

  // Manufactured allocation runs in two phases:
  //
  //   Phase 1 (floor of 1): every demanding store gets 1 unit of each
  //   manufactured item it wants, walking stores in tier order so the
  //   highest-priority stores get the floor first if stock is tight.
  //
  //   Phase 2 (tier-fair priority-fair distribution): the remaining stock
  //   is distributed by tier (asc) outermost, then by store_factories
  //   priority within each tier. Lower tier number = higher priority for
  //   stock; same-tier stores are equal-priority. Within a tier we still
  //   honor the existing priority-fair rule (a store at a factory's
  //   priority-1 gets it before a different store using the same factory
  //   as priority-2 fallback).
  const maxPriority = storeFactories.reduce(
    (m, sf) => (sf.priority > m ? sf.priority : m),
    0,
  );

  const allocateOne = (state: ManufacturedState, sf: StoreFactory, want: number) => {
    if (want <= 0) return 0;
    const k = availableKey(sf.factory_id, state.item_id);
    const avail = availableMap.get(k) ?? 0;
    if (avail <= 0) return 0;
    const take = Math.min(want, avail);
    availableMap.set(k, avail - take);
    if (state.primaryFactoryId === null) state.primaryFactoryId = sf.factory_id;
    state.fulfilled += take;
    factorySplits.push({
      cycle_id: cycle_id!,
      store_id: state.store_id,
      item_id: state.item_id,
      factory_id: sf.factory_id,
      qty: take,
    });
    return take;
  };

  // Phase 1: floor of 1 per store, walking demanding stores in tier order.
  // Each iteration tries the store's full factory-priority chain until we
  // either get one unit or exhaust the chain.
  const stateList = [...manufacturedStates.values()];
  const sortedByTier = [...stateList].sort(
    (a, b) => tierOf(a.store_id) - tierOf(b.store_id),
  );
  for (const state of sortedByTier) {
    if (state.needed < 1 || state.fulfilled >= 1) continue;
    let got = 0;
    for (let p = 1; p <= maxPriority && got < 1; p++) {
      for (const sf of storeFactories) {
        if (got >= 1) break;
        if (sf.store_id !== state.store_id || sf.priority !== p) continue;
        got += allocateOne(state, sf, 1 - got);
      }
    }
  }

  // Phase 2: tier-fair priority-fair distribution for the remaining demand.
  const tiers = Array.from(
    new Set(stateList.map((s) => tierOf(s.store_id))),
  ).sort((a, b) => a - b);
  for (const tier of tiers) {
    for (let p = 1; p <= maxPriority; p++) {
      for (const sf of storeFactories) {
        if (sf.priority !== p) continue;
        if (tierOf(sf.store_id) !== tier) continue;
        for (const state of manufacturedStates.values()) {
          if (state.store_id !== sf.store_id) continue;
          const remaining = state.needed - state.fulfilled;
          if (remaining <= 0) continue;
          allocateOne(state, sf, remaining);
        }
      }
    }
  }

  // Phase 3 (hard overrides only): force-fulfill any remaining demand. We
  // pick a target factory (primary if any pull happened, otherwise the
  // store's highest-priority factory) and push a synthetic split for the
  // deficit. availableMap may go negative — that's the point: the factory
  // owns the deficit, not the store.
  for (const state of manufacturedStates.values()) {
    if (state.overrideMode !== "hard") continue;
    const remaining = state.needed - state.fulfilled;
    if (remaining <= 0) continue;
    const chain = sfByStore.get(state.store_id) ?? [];
    const targetFactoryId = state.primaryFactoryId ?? chain[0]?.factory_id ?? null;
    if (targetFactoryId) {
      const k = availableKey(targetFactoryId, state.item_id);
      availableMap.set(k, (availableMap.get(k) ?? 0) - remaining);
      factorySplits.push({
        cycle_id: cycle_id!,
        store_id: state.store_id,
        item_id: state.item_id,
        factory_id: targetFactoryId,
        qty: remaining,
      });
      if (state.primaryFactoryId === null) state.primaryFactoryId = targetFactoryId;
    }
    state.overdraft = remaining;
    state.fulfilled = state.needed;
  }

  for (const state of manufacturedStates.values()) {
    allocationRows.push({
      cycle_id: cycle_id!,
      store_id: state.store_id,
      item_id: state.item_id,
      qty: state.fulfilled,
      source: state.source,
      factory_id: state.primaryFactoryId,
      shortfall: state.needed - state.fulfilled,
      overdraft: state.overdraft,
    });
  }

  if (allocationRows.length > 0) {
    const { error: insertError } = await supabaseAdmin
      .from("allocations")
      .insert(allocationRows);
    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }
  }

  // Per-factory split rows depend on allocations existing (FK), so insert
  // second. The two-phase allocator (floor + distribution) can push more
  // than one push for the same (store, factory, item) — aggregate before
  // insert so we don't trip the (cycle_id, store_id, item_id, factory_id)
  // primary key.
  const splitsByKey = new Map<string, FactorySplit>();
  for (const s of factorySplits) {
    const k = `${s.store_id}|${s.item_id}|${s.factory_id}`;
    const existing = splitsByKey.get(k);
    if (existing) {
      existing.qty += s.qty;
    } else {
      splitsByKey.set(k, { ...s });
    }
  }
  const aggregatedSplits = [...splitsByKey.values()];
  if (aggregatedSplits.length > 0) {
    const { error: splitError } = await supabaseAdmin
      .from("allocation_factories")
      .insert(aggregatedSplits);
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

  // Snapshot the factory_inventory rows that fed this allocation into
  // factory_counts(cycle_id, …) for audit. Wipe any prior snapshot for
  // the cycle so re-runs replace cleanly. Best-effort: a failure here
  // doesn't roll back the allocations themselves.
  await supabaseAdmin
    .from("factory_counts")
    .delete()
    .eq("cycle_id", cycle_id);
  if (factoryInventory.length > 0) {
    await supabaseAdmin.from("factory_counts").insert(
      factoryInventory.map((fi) => ({
        cycle_id,
        factory_id: fi.factory_id,
        item_id: fi.item_id,
        available_qty: fi.on_hand_qty,
      })),
    );
  }

  // Promote draft → allocated. Re-runs leave 'allocated' as-is.
  const { error: promoteErr } = await supabaseAdmin
    .from("order_cycles")
    .update({ status: "allocated" })
    .eq("id", cycle_id)
    .neq("status", "delivered");
  if (promoteErr) {
    return NextResponse.json({ error: promoteErr.message }, { status: 500 });
  }

  return NextResponse.json({
    message: "Allocations completed",
    allocations_created: allocationRows.length,
    factory_splits_created: aggregatedSplits.length,
    purchase_orders_created: purchaseOrdersCreated,
    shortfalls,
    cycle_id,
  });
}
