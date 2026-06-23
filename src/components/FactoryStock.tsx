"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { formatLocalDate } from "@/lib/dateOnly";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import { AgGridReact } from "@/lib/agGrid";
import type { ColDef } from "ag-grid-community";

// Sentinel for the "all factories" aggregate view in the factory dropdown.
// Selecting it shows item totals summed across every factory and disables
// editing (you can't enter a count without specifying which factory).
const MASTER_FACTORY = "__MASTER__";

type Factory = {
  id: string;
  name: string;
};

type OrderCycle = {
  id: string;
  status: string;
  order_date: string;
};

// Rolling per-(factory, item) on-hand count. Editable any time, not tied
// to any cycle. The allocator reads from this table at run time and
// snapshots it to factory_counts(cycle_id, …) for audit.
type FactoryInventoryRow = {
  factory_id: string;
  item_id: string;
  on_hand_qty: number;
  last_counted_at: string;
};

type AllocationFactory = {
  cycle_id: string;
  store_id: string;
  item_id: string;
  qty: number;
  factory_id: string;
};

// Items the factory needs to produce more of for the selected cycle.
// Urgent = a hard override forced an allocation past available stock; the
// store will receive the full qty regardless, so the factory has to make
// it up. Short = a regular shortfall (factory ran out, store got less
// than asked) — secondary signal that demand exceeded supply.
type ProductionAlert = {
  item_id: string;
  item_name: string;
  urgent_qty: number;
  short_qty: number;
};

type FactoryCountRow = {
  item_id: string;
  item_name: string;
  item_type: string;
  available_qty: number;
  allocatable_qty: number;
  has_existing_count: boolean;
  total_allocated: number;
  remaining_after_reserve: number;
  reserve_qty: number;
  sub_category: string | null;
  packaging_type: string | null;
};

export default function FactoryStock() {
  const { session, profile, loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
  const [factory, setFactory] = useState<Factory | null>(null);
  const [allFactories, setAllFactories] = useState<Factory[]>([]);
  const [selectedFactoryId, setSelectedFactoryId] = useState("");
  const [cycles, setCycles] = useState<OrderCycle[]>([]);
  const [inventory, setInventory] = useState<FactoryInventoryRow[]>([]);
  const [allocations, setAllocations] = useState<AllocationFactory[]>([]);
  const [productionAlerts, setProductionAlerts] = useState<ProductionAlert[]>([]);
  const [selectedCycleId, setSelectedCycleId] = useState("");
  const [gridData, setGridData] = useState<FactoryCountRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // "Log production" quick-entry — adds to an item's on-hand without the
  // factory having to recompute the new total.
  const [showProduction, setShowProduction] = useState(false);
  const [prodItemId, setProdItemId] = useState("");
  const [prodQty, setProdQty] = useState("");
  const [prodSaving, setProdSaving] = useState(false);

  const isFactoryWorker = useMemo(() => profile?.role === "factory_worker", [profile]);
  const hasAssignedFactory = useMemo(() => !!profile?.factory_id, [profile]);
  const effectiveFactoryId = useMemo(
    () => (isStoreManager ? selectedFactoryId || null : profile?.factory_id ?? null),
    [isStoreManager, selectedFactoryId, profile?.factory_id],
  );
  const isMasterView = effectiveFactoryId === MASTER_FACTORY;
  const canManage = (isFactoryWorker && hasAssignedFactory) || (isStoreManager && !!effectiveFactoryId);
  const canEdit = canManage && !isMasterView;

  useEffect(() => {
    if (!isStoreManager) return;
    const loadFactories = async () => {
      const { data } = await supabase.from("factories").select("id,name").order("name");
      if (data) {
        const list = data as Factory[];
        setAllFactories(list);
        // Single-factory operation: auto-pick the lone factory so the
        // boss never has to choose. The dropdown (still rendered for
        // legacy multi-factory data) defaults to it.
        if (list.length === 1 && !selectedFactoryId) {
          setSelectedFactoryId(list[0].id);
        }
      }
    };
    loadFactories();
  }, [isStoreManager, selectedFactoryId]);

  useEffect(() => {
    if (!canManage || !effectiveFactoryId) {
      setFactory(null);
      setCycles([]);
      setInventory([]);
      setAllocations([]);
      setGridData([]);
      return;
    }

    const loadFactoryData = async () => {
      // Cycle dropdown: every active cycle plus at most the 2 most recent
      // delivered ones, same as /store-stock-entry — factory workers don't
      // need a long history surfaced in the picker. Counts and allocations
      // load lazily once the cycle is selected (separate effect below).
      const [
        activeCyclesResponse,
        deliveredCyclesResponse,
        factoryResponse,
      ] = await Promise.all([
        supabase
          .from("order_cycles")
          .select("id,status,order_date")
          .neq("status", "delivered")
          .order("created_at", { ascending: false }),
        supabase
          .from("order_cycles")
          .select("id,status,order_date")
          .eq("status", "delivered")
          .order("created_at", { ascending: false })
          .limit(2),
        isMasterView
          ? Promise.resolve({ data: null })
          : supabase
              .from("factories")
              .select("id,name")
              .eq("id", effectiveFactoryId)
              .single(),
      ]);

      if (isMasterView) {
        setFactory({ id: MASTER_FACTORY, name: "Master view (all factories)" });
      } else if (factoryResponse.data) {
        setFactory(factoryResponse.data as Factory);
      }

      const cycleList = [
        ...((activeCyclesResponse.data as OrderCycle[]) ?? []),
        ...((deliveredCyclesResponse.data as OrderCycle[]) ?? []),
      ];
      setCycles(cycleList);
    };

    loadFactoryData();
  }, [canManage, effectiveFactoryId, isMasterView]);

  // Live rolling inventory — keyed only by factory. No cycle dependency,
  // so factory workers can keep counts up to date even when no cycle is
  // active. In master view we pull every factory's rows so the grid can
  // sum across them.
  // Drop stale responses — realtime fires multiple events per write
  // and the responses can arrive out of order, which otherwise lets an
  // older (empty) result clobber the latest state.
  const inventoryTokenRef = useRef(0);
  const loadInventory = useCallback(async () => {
    if (!canManage || !effectiveFactoryId) {
      setInventory([]);
      return;
    }
    const myToken = ++inventoryTokenRef.current;
    const q = supabase
      .from("factory_inventory")
      .select("factory_id,item_id,on_hand_qty,last_counted_at");
    if (!isMasterView) q.eq("factory_id", effectiveFactoryId);
    const { data, error } = await q;
    if (myToken !== inventoryTokenRef.current) return;
    if (error) {
      // eslint-disable-next-line no-console
      console.error("FactoryStock loadInventory failed:", error);
    }
    if (data) setInventory(data as FactoryInventoryRow[]);
  }, [canManage, effectiveFactoryId, isMasterView]);

  useEffect(() => {
    loadInventory();
  }, [loadInventory]);

  useRealtimeRefetch(
    canManage && effectiveFactoryId
      ? [{ table: "factory_inventory" }]
      : [],
    loadInventory,
    `factory-${effectiveFactoryId}-inventory`,
  );

  // Per-cycle context (allocations + production alerts) — optional. Empty
  // when no cycle is selected; the grid just hides those numbers.
  const cycleScopedTokenRef = useRef(0);
  const loadCycleScoped = useCallback(async () => {
    if (!canManage || !effectiveFactoryId || !selectedCycleId) {
      setAllocations([]);
      setProductionAlerts([]);
      return;
    }
    const myToken = ++cycleScopedTokenRef.current;
    const allocationsQuery = supabase
      .from("allocation_factories")
      .select("cycle_id,store_id,item_id,qty,factory_id")
      .eq("cycle_id", selectedCycleId);
    const alertsQuery = !isMasterView
      ? supabase
          .from("allocations")
          .select("item_id,overdraft,shortfall,items(name)")
          .eq("cycle_id", selectedCycleId)
          .eq("factory_id", effectiveFactoryId)
      : null;
    if (!isMasterView) {
      allocationsQuery.eq("factory_id", effectiveFactoryId);
    }
    const [allocationsResponse, alertsResponse] = await Promise.all([
      allocationsQuery,
      alertsQuery ?? Promise.resolve({ data: null }),
    ]);
    if (myToken !== cycleScopedTokenRef.current) return;
    if (allocationsResponse.data) {
      setAllocations(allocationsResponse.data as AllocationFactory[]);
    }
    if (alertsResponse.data) {
      const byItem = new Map<string, ProductionAlert>();
      for (const a of alertsResponse.data as unknown as Array<{
        item_id: string;
        overdraft: number | null;
        shortfall: number | null;
        items: { name: string } | null;
      }>) {
        const existing =
          byItem.get(a.item_id) ?? {
            item_id: a.item_id,
            item_name: a.items?.name ?? a.item_id,
            urgent_qty: 0,
            short_qty: 0,
          };
        existing.urgent_qty += a.overdraft ?? 0;
        existing.short_qty += a.shortfall ?? 0;
        byItem.set(a.item_id, existing);
      }
      const alerts = Array.from(byItem.values()).filter(
        (a) => a.urgent_qty > 0 || a.short_qty > 0,
      );
      alerts.sort((a, b) => {
        if (a.urgent_qty !== b.urgent_qty) return b.urgent_qty - a.urgent_qty;
        return b.short_qty - a.short_qty;
      });
      setProductionAlerts(alerts);
    } else {
      setProductionAlerts([]);
    }
  }, [canManage, effectiveFactoryId, isMasterView, selectedCycleId]);

  useEffect(() => {
    loadCycleScoped();
  }, [loadCycleScoped]);

  useRealtimeRefetch(
    canManage && effectiveFactoryId && selectedCycleId
      ? [
          { table: "allocation_factories", filter: `cycle_id=eq.${selectedCycleId}` },
          { table: "allocations", filter: `cycle_id=eq.${selectedCycleId}` },
        ]
      : [],
    loadCycleScoped,
    `factory-${effectiveFactoryId}-cycle-${selectedCycleId}-allocations`,
  );

  useEffect(() => {
    if (cycles.length > 0 && !selectedCycleId) {
      setSelectedCycleId(cycles[0].id);
    }
  }, [cycles, selectedCycleId]);

  useEffect(() => {
    if (!effectiveFactoryId) {
      setGridData([]);
      return;
    }

    // Get all manufactured items (since factories only produce manufactured items)
    const loadManufacturedItems = async () => {
      const { data: itemsData, error } = await supabase
        .from("items")
        .select("id,name,type,sub_category,packaging_type")
        .eq("type", "manufactured");

      if (error || !itemsData) {
        setGridData([]);
        return;
      }

      // Prepare grid data by combining items with the rolling factory_inventory
      // and (optionally) the selected cycle's allocations. In master view we
      // sum across every factory's row; in single-factory view there's only
      // one row per item, so the reductions still produce the right number.
      // No cycle selected → allocations / remaining columns stay at 0.
      let gridRows: FactoryCountRow[] = itemsData.map(item => {
        const matchingInventory = inventory.filter((r) => r.item_id === item.id);

        const itemAllocations = selectedCycleId
          ? allocations.filter(
              (alloc) =>
                alloc.cycle_id === selectedCycleId && alloc.item_id === item.id,
            )
          : [];

        const totalAllocated = itemAllocations.reduce((sum, alloc) => sum + alloc.qty, 0);
        const availableQty = matchingInventory.reduce((sum, r) => sum + r.on_hand_qty, 0);
        // No auto-reserve anymore — the factory keeps its own safety stock back
        // manually, so the full on-hand is allocatable.
        const reserveQty = 0;
        const allocatableQty = availableQty;

        return {
          item_id: item.id,
          item_name: item.name,
          item_type: item.type,
          available_qty: availableQty,
          allocatable_qty: allocatableQty,
          has_existing_count: matchingInventory.length > 0,
          total_allocated: totalAllocated,
          remaining_after_reserve: allocatableQty - totalAllocated,
          reserve_qty: reserveQty,
          sub_category: item.sub_category || null,
          packaging_type: item.packaging_type || null,
        };
      });

      gridRows.sort((a, b) =>
        (a.sub_category || "").localeCompare(b.sub_category || ""),
      );

      setGridData(gridRows);
    };

    loadManufacturedItems();
  }, [selectedCycleId, inventory, allocations, effectiveFactoryId]);

  const handleCellValueChanged = async (params: any) => {
    if (!canEdit || !effectiveFactoryId) {
      setMessage(
        isMasterView
          ? "Switch to a specific factory to edit counts."
          : "You do not have permission to update stock counts.",
      );
      return;
    }

    const { data, colDef, newValue } = params;
    if (colDef.field !== "available_qty") return;

    const qtyValue = parseInt(newValue, 10);
    if (Number.isNaN(qtyValue) || qtyValue < 0) {
      setMessage("Please enter a valid stock quantity.");
      return;
    }

    setLoading(true);
    setMessage(null);

    const payload = {
      factory_id: effectiveFactoryId,
      item_id: data.item_id,
      on_hand_qty: qtyValue,
      last_counted_at: new Date().toISOString(),
      counted_by: session?.user?.email ?? session?.user?.id ?? null,
    };

    try {
      const { error } = await supabase
        .from("factory_inventory")
        .upsert([payload], { onConflict: "factory_id,item_id" });
      if (error) {
        setMessage(error.message);
        params.node.setDataValue(colDef.field, params.oldValue);
        return;
      }
      setMessage("Stock count saved.");
      await loadInventory();
    } catch (err) {
      setMessage(
        err instanceof Error
          ? `Couldn't save: ${err.message}`
          : "Couldn't save (network timeout). Try again.",
      );
      params.node.setDataValue(colDef.field, params.oldValue);
    } finally {
      setLoading(false);
    }
  };

  // Add freshly-baked stock to an item's on-hand. A relative increment so the
  // factory doesn't have to know the running total — the auto-decrement on
  // delivery and this addition keep Available current between recounts.
  const handleLogProduction = async () => {
    if (!canEdit || !effectiveFactoryId) return;
    const qty = parseInt(prodQty, 10);
    if (!prodItemId) {
      setMessage("Pick an item.");
      return;
    }
    if (Number.isNaN(qty) || qty <= 0) {
      setMessage("Enter how many were made.");
      return;
    }
    const row = gridData.find((r) => r.item_id === prodItemId);
    const newOnHand = (row?.available_qty ?? 0) + qty;
    setProdSaving(true);
    setMessage(null);
    try {
      const { error } = await supabase.from("factory_inventory").upsert(
        [
          {
            factory_id: effectiveFactoryId,
            item_id: prodItemId,
            on_hand_qty: newOnHand,
            last_counted_at: new Date().toISOString(),
            counted_by: session?.user?.email ?? session?.user?.id ?? null,
          },
        ],
        { onConflict: "factory_id,item_id" },
      );
      if (error) {
        setMessage(error.message);
        return;
      }
      setMessage(`Added ${qty} ${row?.item_name ?? ""} — now ${newOnHand}.`);
      setProdItemId("");
      setProdQty("");
      setShowProduction(false);
      await loadInventory();
    } catch (err) {
      setMessage(
        err instanceof Error
          ? `Couldn't add production: ${err.message}`
          : "Couldn't add production (network timeout). Try again.",
      );
    } finally {
      setProdSaving(false);
    }
  };

  const columnDefs: ColDef<FactoryCountRow>[] = [
    { headerName: "Category", field: "sub_category", sortable: true, filter: true, width: 120 },
    { headerName: "Item", field: "item_name", sortable: true, filter: true, flex: 2, minWidth: 150 },
    { headerName: "Packaging", field: "packaging_type", sortable: true, filter: true, width: 130 },
    {
      headerName: "Available",
      field: "available_qty",
      sortable: true,
      filter: true,
      width: 110,
      editable: !isMasterView,
      cellEditor: "agNumberCellEditor",
      cellEditorParams: { min: 0 },
      cellStyle: (params) => ({
        backgroundColor: params.data?.has_existing_count ? '#1f2937' : '#374151',
      }),
    },
    { headerName: "Allocatable", field: "allocatable_qty", sortable: true, filter: true, width: 130,
      cellStyle: () => ({
        backgroundColor: '#1e3a2f',
        color: '#10b981',
      }),
    },
    { headerName: "Allocated", field: "total_allocated", sortable: true, filter: true, width: 115 },
    {
      headerName: "Remaining",
      field: "remaining_after_reserve",
      sortable: true,
      filter: true,
      width: 115,
      cellStyle: (params) => ({
        color: params.value < 0 ? '#ef4444' : '#10b981',
        fontWeight: 'bold',
      }),
    },
  ];

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <h1 className="text-3xl font-semibold text-white">Factory Stock Management</h1>
      <p className="mt-3 text-slate-400">
        Enter how much of each item you have. See what&apos;s been allocated and what&apos;s left.
      </p>

      {authLoading ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Loading…</p>
        </div>
      ) : !isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in with Supabase Auth first to access this page.</p>
        </div>
      ) : !isFactoryWorker && !isStoreManager ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to Factory Workers and Store Managers.</p>
        </div>
      ) : isFactoryWorker && !hasAssignedFactory ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>You are not assigned to a factory. Please contact an administrator.</p>
        </div>
      ) : isStoreManager && !selectedFactoryId ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300 space-y-3">
          <p>Pick a factory to manage:</p>
          <select
            value={selectedFactoryId}
            onChange={(event) => setSelectedFactoryId(event.target.value)}
            className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm"
          >
            <option value="">(Select a factory)</option>
            <option value={MASTER_FACTORY}>Master factory (all factories)</option>
            {allFactories.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">{factory?.name || "Loading..."}</h2>
              <p className="text-sm text-slate-400">
                {isMasterView
                  ? "Total stock across all factories. View only."
                  : "Factory Manager Dashboard"}
              </p>
            </div>
            <div className="flex items-center gap-4">
              {isStoreManager && allFactories.length > 1 && (
                <>
                  <label htmlFor="factory" className="text-sm font-medium text-slate-300">
                    Factory:
                  </label>
                  <select
                    id="factory"
                    value={selectedFactoryId}
                    onChange={(event) => setSelectedFactoryId(event.target.value)}
                    className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm"
                  >
                    <option value={MASTER_FACTORY}>Master factory (all factories)</option>
                    {allFactories.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <label htmlFor="cycle" className="text-sm font-medium text-slate-300">
                Order Cycle (optional):
              </label>
              <select
                id="cycle"
                value={selectedCycleId}
                onChange={(event) => setSelectedCycleId(event.target.value)}
                className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm"
              >
                <option value="">(none — just on-hand)</option>
                {cycles.map((cycle) => (
                  <option key={cycle.id} value={cycle.id}>
                    {formatLocalDate(cycle.order_date)} ({cycle.status.charAt(0).toUpperCase() + cycle.status.slice(1)})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          {!isMasterView && productionAlerts.length > 0 && (() => {
            const urgent = productionAlerts.filter((a) => a.urgent_qty > 0);
            const short = productionAlerts.filter(
              (a) => a.urgent_qty === 0 && a.short_qty > 0,
            );
            return (
              <div className="space-y-3">
                {urgent.length > 0 && (
                  <div className="rounded-2xl bg-rose-950/60 border border-rose-500/40 px-4 py-3 text-sm">
                    <div className="font-semibold text-rose-200 mb-2">
                      Bake more — these were forced past your stock
                    </div>
                    <ul className="space-y-1 text-rose-100">
                      {urgent.map((a) => (
                        <li key={a.item_id} className="flex items-baseline gap-2">
                          <span className="font-medium">{a.item_name}</span>
                          <span className="text-rose-200">
                            need <strong>{a.urgent_qty}</strong> more
                            {a.short_qty > 0 ? (
                              <span className="text-rose-200/70">
                                {" "}
                                (+{a.short_qty} short)
                              </span>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {short.length > 0 && (
                  <div className="rounded-2xl bg-amber-950/60 border border-amber-500/30 px-4 py-3 text-sm">
                    <div className="font-semibold text-amber-200 mb-2">
                      Stores were short on these (lower priority)
                    </div>
                    <ul className="space-y-1 text-amber-100">
                      {short.map((a) => (
                        <li key={a.item_id} className="flex items-baseline gap-2">
                          <span className="font-medium">{a.item_name}</span>
                          <span className="text-amber-200">
                            short by <strong>{a.short_qty}</strong>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            );
          })()}

          {canEdit && (
            <div>
              {!showProduction ? (
                <button
                  type="button"
                  onClick={() => {
                    setShowProduction(true);
                    setMessage(null);
                  }}
                  className="rounded-full bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-400"
                >
                  ＋ Log production
                </button>
              ) : (
                <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-white/10 bg-slate-900/60 p-4">
                  <div>
                    <label htmlFor="prod-item" className="block text-xs font-medium text-slate-300">
                      Item
                    </label>
                    <select
                      id="prod-item"
                      value={prodItemId}
                      onChange={(e) => setProdItemId(e.target.value)}
                      className="mt-1 rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                    >
                      <option value="">(select item)</option>
                      {gridData.map((r) => (
                        <option key={r.item_id} value={r.item_id}>
                          {r.item_name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="prod-qty" className="block text-xs font-medium text-slate-300">
                      Made
                    </label>
                    <input
                      id="prod-qty"
                      type="number"
                      min={1}
                      value={prodQty}
                      onChange={(e) => setProdQty(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleLogProduction();
                      }}
                      placeholder="qty"
                      className="mt-1 w-24 rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleLogProduction}
                    disabled={prodSaving || !prodItemId || !prodQty}
                    className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                  >
                    {prodSaving ? "Adding…" : "Add"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowProduction(false);
                      setProdItemId("");
                      setProdQty("");
                    }}
                    className="text-sm text-slate-400 hover:text-slate-200"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}

          <div style={{ height: "calc(100vh - 300px)", minHeight: 500 }}>
            <AgGridReact
              rowData={gridData}
              columnDefs={columnDefs}
              defaultColDef={{
                resizable: true,
                sortable: true,
                filter: true,
                minWidth: 80,
              }}
              onCellValueChanged={handleCellValueChanged}
              stopEditingWhenCellsLoseFocus={true}
            />
          </div>

          <div className="text-sm text-slate-400">
            <p><strong>Instructions:</strong></p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>Edit &quot;Available&quot; any time — counts roll forward independently of cycles. The allocator reads from this on every run and snapshots it for audit.</li>
              <li><strong className="text-sky-300">Log production</strong> (button above the grid): add what you just baked and it&apos;s <em>added</em> to Available. Edit &quot;Available&quot; directly to set an exact recount.</li>
              <li>Available drops <strong>automatically</strong> when a cycle is marked delivered — the quantities shipped out of this factory leave the count, so you don&apos;t have to re-subtract by hand.</li>
              <li>Changes are saved automatically when you finish editing a cell</li>
              <li>Cells with darker backgrounds already have saved counts</li>
              <li><strong className="text-green-400">Allocatable:</strong> all of your Available stock (the factory holds its own safety reserve back manually now)</li>
              <li>Pick a cycle to see what got allocated and what&apos;s left for it (Remaining turns red if negative). Leave empty to focus on on-hand only.</li>
              <li>Switch the Factory dropdown to <strong>Master factory</strong> for a read-only view aggregated across every factory</li>
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
