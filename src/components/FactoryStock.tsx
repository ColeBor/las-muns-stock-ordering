"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { formatLocalDate } from "@/lib/dateOnly";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import { AgGridReact } from "@/lib/agGrid";
import type { ColDef } from "ag-grid-community";

// Sentinel for the "all factories" aggregate view in the factory dropdown.
// Selecting it shows item totals summed across every factory and disables
// editing (you can't enter a count without specifying which factory).
const MASTER_FACTORY = "__MASTER__";

type Profile = {
  id: string;
  role: string | null;
  store_id: string | null;
  factory_id: string | null;
};

type Factory = {
  id: string;
  name: string;
};

type OrderCycle = {
  id: string;
  status: string;
  order_date: string;
};

type FactoryCount = {
  cycle_id: string;
  factory_id: string;
  item_id: string;
  available_qty: number;
  counted_at: string;
  items?: {
    name: string;
    type: string;
    sub_category: string | null;
  };
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
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [factory, setFactory] = useState<Factory | null>(null);
  const [allFactories, setAllFactories] = useState<Factory[]>([]);
  const [selectedFactoryId, setSelectedFactoryId] = useState("");
  const [cycles, setCycles] = useState<OrderCycle[]>([]);
  const [counts, setCounts] = useState<FactoryCount[]>([]);
  const [allocations, setAllocations] = useState<AllocationFactory[]>([]);
  const [productionAlerts, setProductionAlerts] = useState<ProductionAlert[]>([]);
  const [selectedCycleId, setSelectedCycleId] = useState("");
  const [gridData, setGridData] = useState<FactoryCountRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isSignedIn = useMemo(() => !!session?.user, [session]);
  const isStoreManager = useMemo(() => profile?.role === "store_manager", [profile]);
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
    const loadSession = async () => {
      const { data } = await supabase.auth.getSession();
      setSession(data.session);
    };

    loadSession();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, sessionData) => {
      setSession(sessionData ?? null);
    });

    return () => {
      listener?.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const loadProfile = async () => {
      if (!session?.user) {
        setProfile(null);
        return;
      }

      const { data, error } = await supabase
        .from("profiles")
        .select("id,role,store_id,factory_id")
        .eq("id", session.user.id)
        .single();

      if (error || !data) {
        setProfile(null);
        return;
      }

      setProfile(data as Profile);
    };

    loadProfile();
  }, [session]);

  useEffect(() => {
    if (!isStoreManager) return;
    const loadFactories = async () => {
      const { data } = await supabase.from("factories").select("id,name").order("name");
      if (data) setAllFactories(data as Factory[]);
    };
    loadFactories();
  }, [isStoreManager]);

  useEffect(() => {
    if (!canManage || !effectiveFactoryId) {
      setFactory(null);
      setCycles([]);
      setCounts([]);
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

  // Lazy-fetch factory_counts and allocation_factories scoped to the
  // selected cycle (and factory, unless in master view).
  const loadCycleScoped = useCallback(async () => {
    if (!canManage || !effectiveFactoryId || !selectedCycleId) {
      setCounts([]);
      setAllocations([]);
      setProductionAlerts([]);
      return;
    }
    const countsQuery = supabase
      .from("factory_counts")
      .select(
        "cycle_id,factory_id,item_id,available_qty,counted_at,items(name,type,sub_category)",
      )
      .eq("cycle_id", selectedCycleId);
    const allocationsQuery = supabase
      .from("allocation_factories")
      .select("cycle_id,store_id,item_id,qty,factory_id")
      .eq("cycle_id", selectedCycleId);
    // Production alerts come from the top-level allocations table since
    // overdraft and shortfall live there (allocation_factories only has
    // the per-factory split qty). Skip in master view — there's no
    // single factory to alert.
    const alertsQuery = !isMasterView
      ? supabase
          .from("allocations")
          .select("item_id,overdraft,shortfall,items(name)")
          .eq("cycle_id", selectedCycleId)
          .eq("factory_id", effectiveFactoryId)
      : null;
    if (!isMasterView) {
      countsQuery.eq("factory_id", effectiveFactoryId);
      allocationsQuery.eq("factory_id", effectiveFactoryId);
    }
    const [countsResponse, allocationsResponse, alertsResponse] =
      await Promise.all([
        countsQuery,
        allocationsQuery,
        alertsQuery ?? Promise.resolve({ data: null }),
      ]);
    if (countsResponse.data) {
      setCounts(countsResponse.data as unknown as FactoryCount[]);
    }
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
          { table: "factory_counts", filter: `cycle_id=eq.${selectedCycleId}` },
          { table: "allocation_factories", filter: `cycle_id=eq.${selectedCycleId}` },
          { table: "allocations", filter: `cycle_id=eq.${selectedCycleId}` },
        ]
      : [],
    loadCycleScoped,
    `factory-${effectiveFactoryId}-cycle-${selectedCycleId}-stock`,
  );

  useEffect(() => {
    if (cycles.length > 0 && !selectedCycleId) {
      setSelectedCycleId(cycles[0].id);
    }
  }, [cycles, selectedCycleId]);

  useEffect(() => {
    if (!selectedCycleId || !effectiveFactoryId) {
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

      // Prepare grid data by combining items with existing counts and allocations.
      // In master view we sum across every factory's count and allocation for
      // the cycle; in single-factory view there's only one row per item, so
      // these reductions still produce the right number.
      let gridRows: FactoryCountRow[] = itemsData.map(item => {
        const matchingCounts = counts.filter(
          count => count.cycle_id === selectedCycleId && count.item_id === item.id,
        );

        const itemAllocations = allocations.filter(
          alloc => alloc.cycle_id === selectedCycleId && alloc.item_id === item.id
        );

        const totalAllocated = itemAllocations.reduce((sum, alloc) => sum + alloc.qty, 0);
        const availableQty = matchingCounts.reduce((sum, c) => sum + c.available_qty, 0);
        const reserveQty = matchingCounts.length; // 1 reserved per factory holding this item
        const allocatableQty = matchingCounts.reduce(
          (sum, c) => sum + Math.max(0, c.available_qty - 1),
          0,
        );

        return {
          item_id: item.id,
          item_name: item.name,
          item_type: item.type,
          available_qty: availableQty,
          allocatable_qty: allocatableQty,
          has_existing_count: matchingCounts.length > 0,
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
  }, [selectedCycleId, counts, allocations, effectiveFactoryId]);

  const handleCellValueChanged = async (params: any) => {
    if (!canEdit || !selectedCycleId || !effectiveFactoryId) {
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
      cycle_id: selectedCycleId,
      factory_id: effectiveFactoryId,
      item_id: data.item_id,
      available_qty: qtyValue,
      counted_by: session?.user?.email ?? session?.user?.id,
    };

    const { error } = await supabase
      .from("factory_counts")
      .upsert([payload], { onConflict: "cycle_id,factory_id,item_id" });

    setLoading(false);

    if (error) {
      setMessage(error.message);
      // Revert the change in the grid
      params.node.setDataValue(colDef.field, params.oldValue);
      return;
    }

    setMessage("Stock count saved successfully.");

    // Update the local counts state
    const { data: countsData } = await supabase
      .from("factory_counts")
      .select("cycle_id,factory_id,item_id,available_qty,counted_at,items(name,type)")
      .eq("factory_id", effectiveFactoryId)
      .order("counted_at", { ascending: false });

    if (countsData) {
      setCounts(countsData as unknown as FactoryCount[]);
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

      {!isSignedIn ? (
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
              {isStoreManager && (
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
                Order Cycle:
              </label>
              <select
                id="cycle"
                value={selectedCycleId}
                onChange={(event) => setSelectedCycleId(event.target.value)}
                className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm"
              >
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
              <li>Select an order cycle from the dropdown above</li>
              <li>Click on &quot;Available Qty&quot; cells to edit stock quantities (1 unit per factory is reserved automatically and excluded from Allocatable)</li>
              <li>Changes are saved automatically when you finish editing a cell</li>
              <li>Cells with darker backgrounds already have saved counts</li>
              <li><strong className="text-green-400">Allocatable:</strong> Available stock minus the per-factory reserve</li>
              <li>&quot;Allocated&quot; shows total quantities allocated to stores; &quot;Remaining&quot; turns red if it goes negative</li>
              <li>Switch the Factory dropdown to <strong>Master factory</strong> for a read-only view aggregated across every factory</li>
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
