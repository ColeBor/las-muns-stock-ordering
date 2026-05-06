"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
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
  name: string;
  status: string;
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
  const [selectedCycleId, setSelectedCycleId] = useState("");
  const [gridData, setGridData] = useState<FactoryCountRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isSignedIn = useMemo(() => !!session?.user, [session]);
  const isHQAdmin = useMemo(() => profile?.role === "hq_admin", [profile]);
  const isFactoryUser = useMemo(() => profile?.role === "factory_user", [profile]);
  const hasAssignedFactory = useMemo(() => !!profile?.factory_id, [profile]);
  const effectiveFactoryId = useMemo(
    () => (isHQAdmin ? selectedFactoryId || null : profile?.factory_id ?? null),
    [isHQAdmin, selectedFactoryId, profile?.factory_id],
  );
  const isMasterView = effectiveFactoryId === MASTER_FACTORY;
  const canManage = (isFactoryUser && hasAssignedFactory) || (isHQAdmin && !!effectiveFactoryId);
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
    if (!isHQAdmin) return;
    const loadFactories = async () => {
      const { data } = await supabase.from("factories").select("id,name").order("name");
      if (data) setAllFactories(data as Factory[]);
    };
    loadFactories();
  }, [isHQAdmin]);

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
      // In master view, drop the factory_id filter so we get rows across
      // every factory for aggregation.
      const countsQuery = supabase
        .from("factory_counts")
        .select(
          "cycle_id,factory_id,item_id,available_qty,counted_at,items(name,type,sub_category)",
        )
        .order("counted_at", { ascending: false });
      const allocationsQuery = supabase
        .from("allocation_factories")
        .select("cycle_id,store_id,item_id,qty,factory_id")
        .order("cycle_id");
      if (!isMasterView) {
        countsQuery.eq("factory_id", effectiveFactoryId);
        allocationsQuery.eq("factory_id", effectiveFactoryId);
      }

      const [cycleResponse, countsResponse, allocationsResponse, factoryResponse] =
        await Promise.all([
          supabase
            .from("order_cycles")
            .select("id,name,status")
            .order("started_at", { ascending: false })
            .limit(5),
          countsQuery,
          allocationsQuery,
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

      if (cycleResponse.data) {
        setCycles(cycleResponse.data as OrderCycle[]);
      }

      if (countsResponse.data) {
        setCounts(countsResponse.data as unknown as FactoryCount[]);
      }

      if (allocationsResponse.data) {
        setAllocations(allocationsResponse.data as AllocationFactory[]);
      }
    };

    loadFactoryData();
  }, [canManage, effectiveFactoryId, isMasterView]);

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
    { headerName: "Category", field: "sub_category", sortable: true, filter: true, width: 140 },
    { headerName: "Item Name", field: "item_name", sortable: true, filter: true, width: 200 },
    { headerName: "Packaging", field: "packaging_type", sortable: true, filter: true, width: 120 },
    {
      headerName: "Available Qty",
      field: "available_qty",
      sortable: true,
      filter: true,
      width: 130,
      editable: !isMasterView,
      cellEditor: "agNumberCellEditor",
      cellEditorParams: { min: 0 },
      cellStyle: (params) => ({
        backgroundColor: params.data?.has_existing_count ? '#1f2937' : '#374151',
      }),
    },
    { headerName: "Allocatable", field: "allocatable_qty", sortable: true, filter: true, width: 120,
      cellStyle: () => ({
        backgroundColor: '#1e3a2f',
        color: '#10b981',
      }),
    },
    { headerName: "Allocated", field: "total_allocated", sortable: true, filter: true, width: 100 },
    {
      headerName: "Remaining",
      field: "remaining_after_reserve",
      sortable: true,
      filter: true,
      width: 100,
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
        Enter available stock quantities for manufactured items. See allocations and remaining stock levels.
      </p>

      {!isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in with Supabase Auth first to access this page.</p>
        </div>
      ) : !isFactoryUser && !isHQAdmin ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to factory users and management.</p>
        </div>
      ) : isFactoryUser && !hasAssignedFactory ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>You are not assigned to a factory. Please contact an administrator.</p>
        </div>
      ) : isHQAdmin && !selectedFactoryId ? (
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
                  ? "Aggregated stock across every factory — read-only"
                  : "Factory Manager Dashboard"}
              </p>
            </div>
            <div className="flex items-center gap-4">
              {isHQAdmin && (
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
                    {cycle.name} ({cycle.status})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          <div style={{ height: "calc(100vh - 300px)", minHeight: 500 }}>
            <AgGridReact
              rowData={gridData}
              columnDefs={columnDefs}
              defaultColDef={{
                resizable: true,
                sortable: true,
                filter: true,
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
