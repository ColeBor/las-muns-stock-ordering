"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";

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
    sku: string;
    type: string;
    unit: string | null;
    meta_category: string | null;
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
  item_sku: string;
  item_type: string;
  unit: string | null;
  available_qty: number;
  has_existing_count: boolean;
  total_allocated: number;
  remaining_after_reserve: number;
  reserve_qty: number;
  meta_category: string | null;
  sub_category: string | null;
  packaging_type: string | null;
};

export default function FactoryStock() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [factory, setFactory] = useState<Factory | null>(null);
  const [cycles, setCycles] = useState<OrderCycle[]>([]);
  const [counts, setCounts] = useState<FactoryCount[]>([]);
  const [allocations, setAllocations] = useState<AllocationFactory[]>([]);
  const [selectedCycleId, setSelectedCycleId] = useState("");
  const [gridData, setGridData] = useState<FactoryCountRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isSignedIn = useMemo(() => !!session?.user, [session]);
  const isFactoryUser = useMemo(() => profile?.role === "factory_user", [profile]);
  const hasAssignedFactory = useMemo(() => !!profile?.factory_id, [profile]);
  const canManage = isFactoryUser && hasAssignedFactory;

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
    if (!canManage || !profile?.factory_id) {
      setFactory(null);
      setCycles([]);
      setCounts([]);
      setAllocations([]);
      setGridData([]);
      return;
    }

    const loadFactoryData = async () => {
      const [factoryResponse, cycleResponse, countsResponse, allocationsResponse] = await Promise.all([
        supabase.from("factories").select("id,name").eq("id", profile.factory_id).single(),
        supabase.from("order_cycles").select("id,name,status").order("started_at", { ascending: false }).limit(5),
        supabase
          .from("factory_counts")
          .select("cycle_id,factory_id,item_id,available_qty,counted_at,items(name,sku,type,unit,meta_category,sub_category)")
          .eq("factory_id", profile.factory_id)
          .order("counted_at", { ascending: false }),
        supabase
          .from("allocation_factories")
          .select("cycle_id,store_id,item_id,qty,factory_id")
          .eq("factory_id", profile.factory_id)
          .order("cycle_id"),
      ]);

      if (factoryResponse.data) {
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
  }, [canManage, profile?.factory_id]);

  useEffect(() => {
    if (cycles.length > 0 && !selectedCycleId) {
      setSelectedCycleId(cycles[0].id);
    }
  }, [cycles, selectedCycleId]);

  useEffect(() => {
    if (!selectedCycleId || !profile?.factory_id) {
      setGridData([]);
      return;
    }

    // Get all manufactured items (since factories only produce manufactured items)
    const loadManufacturedItems = async () => {
      const { data: itemsData, error } = await supabase
        .from("items")
        .select("id,name,sku,type,unit,meta_category,sub_category,packaging_type")
        .eq("type", "manufactured");

      if (error || !itemsData) {
        setGridData([]);
        return;
      }

      // Prepare grid data by combining items with existing counts and allocations
      let gridRows: FactoryCountRow[] = itemsData.map(item => {
        const existingCount = counts.find(
          count => count.cycle_id === selectedCycleId && count.item_id === item.id
        );

        const itemAllocations = allocations.filter(
          alloc => alloc.cycle_id === selectedCycleId && alloc.item_id === item.id
        );

        const totalAllocated = itemAllocations.reduce((sum, alloc) => sum + alloc.qty, 0);
        const availableQty = existingCount?.available_qty || 0;
        const reserveQty = 1; // Always reserve 1 unit per item
        const allocatableQty = Math.max(0, availableQty - reserveQty);

        return {
          item_id: item.id,
          item_name: item.name,
          item_sku: item.sku,
          item_type: item.type,
          unit: item.unit,
          available_qty: availableQty,
          has_existing_count: !!existingCount,
          total_allocated: totalAllocated,
          remaining_after_reserve: allocatableQty - totalAllocated,
          reserve_qty: reserveQty,
          meta_category: item.meta_category || null,
          sub_category: item.sub_category || null,
          packaging_type: item.packaging_type || null,
        };
      });

      // Sort by meta_category then sub_category for grouping
      gridRows.sort((a, b) => {
        const metaSort = (a.meta_category || "").localeCompare(b.meta_category || "");
        if (metaSort !== 0) return metaSort;
        return (a.sub_category || "").localeCompare(b.sub_category || "");
      });

      setGridData(gridRows);
    };

    loadManufacturedItems();
  }, [selectedCycleId, counts, allocations, profile?.factory_id]);

  const handleCellValueChanged = async (params: any) => {
    if (!canManage || !selectedCycleId || !profile?.factory_id) {
      setMessage("You do not have permission to update stock counts.");
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
      factory_id: profile.factory_id,
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
      .select("cycle_id,factory_id,item_id,available_qty,counted_at,items(name,sku,type,unit)")
      .eq("factory_id", profile.factory_id)
      .order("counted_at", { ascending: false });

    if (countsData) {
      setCounts(countsData as unknown as FactoryCount[]);
    }
  };

  const columnDefs: ColDef<FactoryCountRow>[] = [
    { headerName: "Meta Category", field: "meta_category", sortable: true, filter: true, width: 140, rowGroup: true, hide: true },
    { headerName: "Category", field: "sub_category", sortable: true, filter: true, width: 140, rowGroup: true, hide: true },
    { headerName: "SKU", field: "item_sku", sortable: true, filter: true, width: 120 },
    { headerName: "Item Name", field: "item_name", sortable: true, filter: true, width: 200 },
    { headerName: "Type", field: "item_type", sortable: true, filter: true, width: 100 },
    { headerName: "Unit", field: "unit", sortable: true, filter: true, width: 80 },
    { headerName: "Packaging", field: "packaging_type", sortable: true, filter: true, width: 120 },
    {
      headerName: "Available Qty",
      field: "available_qty",
      sortable: true,
      filter: true,
      width: 130,
      editable: true,
      cellEditor: "agNumberCellEditor",
      cellEditorParams: { min: 0 },
      cellStyle: (params) => ({
        backgroundColor: params.data?.has_existing_count ? '#1f2937' : '#374151',
      }),
    },
    {
      headerName: "Reserve (1 unit)",
      field: "reserve_qty",
      sortable: true,
      filter: true,
      width: 130,
      cellStyle: () => ({
        backgroundColor: '#1f2937',
        color: '#fbbf24',
        fontWeight: 'bold',
      }),
    },
    { headerName: "Allocatable", field: "available_qty", sortable: true, filter: true, width: 120,
      valueGetter: (params) => Math.max(0, (params.data?.available_qty || 0) - 1),
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
      ) : !isFactoryUser ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to factory users.</p>
        </div>
      ) : !hasAssignedFactory ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>You are not assigned to a factory. Please contact an administrator.</p>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">{factory?.name || "Loading..."}</h2>
              <p className="text-sm text-slate-400">Factory Manager Dashboard</p>
            </div>
            <div className="flex items-center gap-4">
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

          <div className="ag-theme-alpine-dark" style={{ height: "calc(100vh - 300px)", minHeight: 500 }}>
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
              <li>Click on "Available Qty" cells to edit stock quantities</li>
              <li>Changes are saved automatically when you finish editing a cell</li>
              <li>Cells with darker backgrounds already have saved counts</li>
              <li><strong className="text-yellow-400">Reserve:</strong> 1 unit is always reserved for emergencies and cannot be allocated</li>
              <li><strong className="text-green-400">Allocatable:</strong> Available quantity minus the 1-unit reserve</li>
              <li>"Allocated" shows total quantities allocated to stores</li>
              <li>"Remaining" shows available stock after allocations (red if negative)</li>
              <li>Only manufactured items are shown</li>
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
