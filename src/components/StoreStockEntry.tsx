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

type Store = {
  id: string;
  name: string;
};

type OrderCycle = {
  id: string;
  name: string;
  status: string;
};

type StoreItem = {
  item_id: string;
  is_active: boolean;
  capacity: number;
  items?: {
    name: string;
    sku: string;
    type: string;
    unit: string | null;
    meta_category: string | null;
    sub_category: string | null;
    packaging_type: string | null;
  };
};

type StockEntry = {
  cycle_id: string;
  store_id: string;
  item_id: string;
  current_count: number;
  order_date: string | null;
  entered_at: string;
  items?: {
    name: string;
    sku: string;
  };
};

type StockEntryRow = {
  item_id: string;
  item_name: string;
  item_sku: string;
  item_type: string;
  unit: string | null;
  capacity: number;
  current_count: number;
  order_date: string | null;
  is_active: boolean;
  has_existing_entry: boolean;
  sub_category: string | null;
  packaging_type: string | null;
};

export default function StoreStockEntry() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [store, setStore] = useState<Store | null>(null);
  const [cycles, setCycles] = useState<OrderCycle[]>([]);
  const [storeItems, setStoreItems] = useState<StoreItem[]>([]);
  const [entries, setEntries] = useState<StockEntry[]>([]);
  const [selectedCycleId, setSelectedCycleId] = useState("");
  const [gridData, setGridData] = useState<StockEntryRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isSignedIn = useMemo(() => !!session?.user, [session]);
  const isStoreManager = useMemo(() => profile?.role === "store_manager", [profile]);
  const hasAssignedStore = useMemo(() => !!profile?.store_id, [profile]);
  const canManage = isStoreManager && hasAssignedStore;

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
    if (!canManage || !profile?.store_id) {
      setStore(null);
      setCycles([]);
      setStoreItems([]);
      setEntries([]);
      setGridData([]);
      return;
    }

    const loadStoreData = async () => {
      const [storeResponse, cycleResponse, itemsResponse, entriesResponse] = await Promise.all([
        supabase.from("stores").select("id,name").eq("id", profile.store_id).single(),
        supabase.from("order_cycles").select("id,name,status").order("started_at", { ascending: false }).limit(5),
        supabase
          .from("store_items")
          .select("item_id,is_active,capacity,items(name,sku,type,unit,meta_category,sub_category,packaging_type)")
          .eq("store_id", profile.store_id)
          .order("item_id"),
        supabase
          .from("stock_entries")
          .select("cycle_id,store_id,item_id,current_count,order_date,entered_at,items(name,sku)")
          .eq("store_id", profile.store_id)
          .order("entered_at", { ascending: false }),
      ]);

      if (storeResponse.data) {
        setStore(storeResponse.data as Store);
      }

      if (cycleResponse.data) {
        setCycles(cycleResponse.data as OrderCycle[]);
      }

      if (itemsResponse.data) {
        setStoreItems(itemsResponse.data as unknown as StoreItem[]);
      }

      if (entriesResponse.data) {
        setEntries(entriesResponse.data as unknown as StockEntry[]);
      }
    };

    loadStoreData();
  }, [canManage, profile?.store_id]);

  useEffect(() => {
    if (cycles.length > 0 && !selectedCycleId) {
      setSelectedCycleId(cycles[0].id);
    }
  }, [cycles, selectedCycleId]);

  useEffect(() => {
    if (!selectedCycleId || !profile?.store_id) {
      setGridData([]);
      return;
    }

    // Prepare grid data by combining store items with existing entries
    let gridRows: StockEntryRow[] = storeItems
      .filter(item => item.is_active)
      .map(storeItem => {
        const existingEntry = entries.find(
          entry => entry.cycle_id === selectedCycleId && entry.item_id === storeItem.item_id
        );

        return {
          item_id: storeItem.item_id,
          item_name: storeItem.items?.name || storeItem.item_id,
          item_sku: storeItem.items?.sku || "",
          item_type: storeItem.items?.type || "",
          unit: storeItem.items?.unit || null,
          capacity: storeItem.capacity,
          current_count: existingEntry?.current_count || 0,
          order_date: existingEntry?.order_date || null,
          is_active: storeItem.is_active,
          has_existing_entry: !!existingEntry,
          sub_category: storeItem.items?.sub_category || null,
          packaging_type: storeItem.items?.packaging_type || null,
        };
      });

    // Sort by sub_category for grouping
    gridRows.sort((a, b) => (a.sub_category || "").localeCompare(b.sub_category || ""));

    setGridData(gridRows);
  }, [selectedCycleId, storeItems, entries, profile?.store_id]);

  const handleCellValueChanged = async (params: any) => {
    if (!selectedCycleId || !profile?.store_id) return;

    const { data, colDef, newValue, oldValue } = params;

    if (newValue === oldValue) return;

    setLoading(true);
    setMessage(null);

    try {
      if (colDef.field === "current_count") {
        const countValue = parseInt(newValue, 10);
        if (Number.isNaN(countValue) || countValue < 0) {
          setMessage("Please enter a valid stock count.");
          // Revert the change
          params.node.setDataValue(colDef.field, oldValue);
          setLoading(false);
          return;
        }

        const payload = {
          cycle_id: selectedCycleId,
          store_id: profile.store_id,
          item_id: data.item_id,
          current_count: countValue,
          order_date: data.order_date || null,
          entered_by: session?.user?.email ?? session?.user?.id,
        };

        const { error } = await supabase
          .from("stock_entries")
          .upsert([payload], { onConflict: "cycle_id,store_id,item_id" });

        if (error) throw error;

        setMessage("Stock count updated successfully.");

        // Update local entries state
        const newEntry: StockEntry = {
          ...payload,
          entered_at: new Date().toISOString(),
          items: { name: data.item_name, sku: data.item_sku },
        };

        setEntries(prev => {
          const filtered = prev.filter(e => !(e.cycle_id === selectedCycleId && e.item_id === data.item_id));
          return [newEntry, ...filtered];
        });

      } else if (colDef.field === "order_date") {
        const payload = {
          cycle_id: selectedCycleId,
          store_id: profile.store_id,
          item_id: data.item_id,
          current_count: data.current_count,
          order_date: newValue || null,
          entered_by: session?.user?.email ?? session?.user?.id,
        };

        const { error } = await supabase
          .from("stock_entries")
          .upsert([payload], { onConflict: "cycle_id,store_id,item_id" });

        if (error) throw error;

        setMessage("Order date updated successfully.");

        // Update local entries state
        const newEntry: StockEntry = {
          ...payload,
          entered_at: new Date().toISOString(),
          items: { name: data.item_name, sku: data.item_sku },
        };

        setEntries(prev => {
          const filtered = prev.filter(e => !(e.cycle_id === selectedCycleId && e.item_id === data.item_id));
          return [newEntry, ...filtered];
        });
      }
    } catch (error: any) {
      setMessage(error.message);
      // Revert the change
      params.node.setDataValue(colDef.field, oldValue);
    } finally {
      setLoading(false);
    }
  };

  const columnDefs: ColDef<StockEntryRow>[] = [
    { headerName: "Category", field: "sub_category", sortable: true, filter: true, width: 140, rowGroup: true, hide: true },
    { headerName: "SKU", field: "item_sku", sortable: true, filter: true, width: 120 },
    { headerName: "Item Name", field: "item_name", sortable: true, filter: true, width: 200 },
    { headerName: "Type", field: "item_type", sortable: true, filter: true, width: 100 },
    { headerName: "Unit", field: "unit", sortable: true, filter: true, width: 80 },
    { headerName: "Packaging", field: "packaging_type", sortable: true, filter: true, width: 120 },
    { headerName: "Capacity", field: "capacity", sortable: true, filter: true, width: 100 },
    {
      headerName: "Current Count",
      field: "current_count",
      sortable: true,
      filter: true,
      width: 130,
      editable: true,
      cellEditor: "agNumberCellEditor",
      cellEditorParams: { min: 0 },
      cellStyle: (params) => ({
        backgroundColor: params.data?.has_existing_entry ? '#1f2937' : '#374151',
      }),
    },
    {
      headerName: "Order Date",
      field: "order_date",
      sortable: true,
      filter: true,
      width: 120,
      editable: true,
      cellEditor: "agDateCellEditor",
      valueFormatter: (params) => params.value ? new Date(params.value).toLocaleDateString() : "",
      cellStyle: (params) => ({
        backgroundColor: params.data?.has_existing_entry ? '#1f2937' : '#374151',
      }),
    },
  ];

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <h1 className="text-3xl font-semibold text-white">Store Stock Entry</h1>
      <p className="mt-3 text-slate-400">
        Enter current stock counts and order dates for your store's active items. Use the spreadsheet interface below.
      </p>

      {!isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in with Supabase Auth first to access this page.</p>
        </div>
      ) : !isStoreManager ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to store managers.</p>
        </div>
      ) : !hasAssignedStore ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>You are not assigned to a store. Please contact an administrator.</p>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">{store?.name || "Loading..."}</h2>
              <p className="text-sm text-slate-400">Store Manager Dashboard</p>
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
              <li>Click on "Current Count" or "Order Date" cells to edit values</li>
              <li>Changes are saved automatically when you finish editing a cell</li>
              <li>Cells with darker backgrounds already have saved entries</li>
              <li>Only active items for your store are shown</li>
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
