"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
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
  is_high_volume: boolean;
};

type Item = {
  id: string;
  sku: string;
  name: string;
  type: "manufactured" | "purchased";
  unit: string | null;
};

type StoreItem = {
  store_id: string;
  item_id: string;
  is_active: boolean;
  capacity: number;
  activated_at: string | null;
  deactivated_at: string | null;
  stores?: { name: string };
  items?: { sku: string; name: string; type: string; unit: string | null };
};

export default function AdminStoreItems() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [storeItems, setStoreItems] = useState<StoreItem[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isSignedIn = useMemo(() => !!session?.user, [session]);
  const isHQAdmin = useMemo(() => profile?.role === "hq_admin", [profile]);
  const canManage = isHQAdmin;

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
    if (!canManage) {
      setStoreItems([]);
      setStores([]);
      setItems([]);
      return;
    }

    const loadData = async () => {
      const [storeItemsResponse, storesResponse, itemsResponse] = await Promise.all([
        supabase
          .from("store_items")
          .select(`
            *,
            stores(name),
            items(sku, name, type, unit)
          `)
          .order("store_id, item_id"),
        supabase.from("stores").select("id, name, is_high_volume").order("name"),
        supabase.from("items").select("id, sku, name, type, unit").order("name"),
      ]);

      if (storeItemsResponse.data) {
        setStoreItems(storeItemsResponse.data as StoreItem[]);
      }

      if (storesResponse.data) {
        setStores(storesResponse.data as Store[]);
      }

      if (itemsResponse.data) {
        setItems(itemsResponse.data as Item[]);
      }
    };

    loadData();
  }, [canManage]);

  const handleToggleActive = async (storeId: string, itemId: string, currentActive: boolean) => {
    setLoading(true);
    setMessage(null);

    const now = new Date().toISOString();

    if (currentActive) {
      // Deactivate
      const { error } = await supabase
        .from("store_items")
        .update({
          is_active: false,
          deactivated_at: now,
        })
        .eq("store_id", storeId)
        .eq("item_id", itemId);

      if (error) {
        setMessage(error.message);
        setLoading(false);
        return;
      }
    } else {
      // Activate
      const { error } = await supabase
        .from("store_items")
        .upsert({
          store_id: storeId,
          item_id: itemId,
          is_active: true,
          capacity: 0,
          activated_at: now,
        });

      if (error) {
        setMessage(error.message);
        setLoading(false);
        return;
      }
    }

    // Reload data
    const { data } = await supabase
      .from("store_items")
      .select(`
        *,
        stores(name),
        items(sku, name, type, unit)
      `)
      .order("store_id, item_id");

    if (data) {
      setStoreItems(data as StoreItem[]);
    }

    setLoading(false);
    setMessage(`Item ${currentActive ? 'deactivated' : 'activated'} successfully.`);
  };

  const handleCapacityChange = async (storeId: string, itemId: string, capacity: number) => {
    setLoading(true);
    setMessage(null);

    const now = new Date().toISOString();

    const { error } = await supabase
      .from("store_items")
      .upsert({
        store_id: storeId,
        item_id: itemId,
        is_active: true,
        capacity: capacity,
        activated_at: now,
      });

    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }

    // Reload data
    const { data } = await supabase
      .from("store_items")
      .select(`
        *,
        stores(name),
        items(sku, name, type, unit)
      `)
      .order("store_id, item_id");

    if (data) {
      setStoreItems(data as StoreItem[]);
    }

    setLoading(false);
    setMessage("Capacity updated successfully.");
  };

  const handleBulkActivate = async (storeId: string) => {
    if (!confirm(`Activate all items for this store?`)) return;

    setLoading(true);
    setMessage(null);

    const now = new Date().toISOString();
    const bulkData = items.map(item => ({
      store_id: storeId,
      item_id: item.id,
      is_active: true,
      capacity: 0,
      activated_at: now,
    }));

    const { error } = await supabase
      .from("store_items")
      .upsert(bulkData);

    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }

    // Reload data
    const { data } = await supabase
      .from("store_items")
      .select(`
        *,
        stores(name),
        items(sku, name, type, unit)
      `)
      .order("store_id, item_id");

    if (data) {
      setStoreItems(data as StoreItem[]);
    }

    setLoading(false);
    setMessage("All items activated for store.");
  };

  const columnDefs: ColDef<StoreItem>[] = [
    {
      headerName: "Store",
      valueGetter: (params) => params.data?.stores?.name || "",
      sortable: true,
      filter: true,
      width: 150,
    },
    {
      headerName: "Item SKU",
      valueGetter: (params) => params.data?.items?.sku || "",
      sortable: true,
      filter: true,
      width: 120,
    },
    {
      headerName: "Item Name",
      valueGetter: (params) => params.data?.items?.name || "",
      sortable: true,
      filter: true,
      width: 200,
    },
    {
      headerName: "Type",
      valueGetter: (params) => params.data?.items?.type || "",
      sortable: true,
      filter: true,
      width: 120,
    },
    {
      headerName: "Unit",
      valueGetter: (params) => params.data?.items?.unit || "",
      sortable: true,
      filter: true,
      width: 100,
    },
    {
      headerName: "Active",
      field: "is_active",
      sortable: true,
      filter: true,
      width: 100,
      cellRenderer: (params: ICellRendererParams<StoreItem>) => (
        <input
          type="checkbox"
          checked={params.value}
          onChange={() => handleToggleActive(params.data!.store_id, params.data!.item_id, params.value)}
          disabled={loading}
        />
      ),
    },
    {
      headerName: "Capacity",
      field: "capacity",
      sortable: true,
      filter: true,
      width: 120,
      editable: true,
      cellEditor: "agNumberCellEditor",
      cellEditorParams: {
        min: 0,
      },
      onCellValueChanged: (params) => {
        if (params.newValue !== params.oldValue) {
          handleCapacityChange(params.data.store_id, params.data.item_id, params.newValue);
        }
      },
    },
    {
      headerName: "Actions",
      cellRenderer: (params: ICellRendererParams<StoreItem>) => (
        <button
          onClick={() => handleBulkActivate(params.data!.store_id)}
          className="px-2 py-1 text-xs bg-green-500 text-white rounded"
          disabled={loading}
        >
          Activate All for Store
        </button>
      ),
      width: 180,
    },
  ];

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <h1 className="text-3xl font-semibold text-white">Admin: Store-Item Setup</h1>
      <p className="mt-3 text-slate-400">
        Configure which items are active at each store and set capacity levels. Use "Activate All for Store" to bulk-enable items.
      </p>

      {!isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in with Supabase Auth first to access this page.</p>
        </div>
      ) : !isHQAdmin ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to HQ administrators.</p>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-semibold text-white">Store-Item Configuration</h2>
            <div className="text-sm text-slate-400">
              {storeItems.length} configurations loaded
            </div>
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          <div className="ag-theme-alpine-dark" style={{ height: 600 }}>
            <AgGridReact
              rowData={storeItems}
              columnDefs={columnDefs}
              defaultColDef={{
                resizable: true,
                sortable: true,
                filter: true,
              }}
              pagination={true}
              paginationPageSize={20}
            />
          </div>

          <div className="text-sm text-slate-400">
            <p><strong>Instructions:</strong></p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>Check/uncheck "Active" to enable/disable items per store</li>
              <li>Click on capacity values to edit them inline</li>
              <li>Use "Activate All for Store" to bulk-enable all items for a store</li>
              <li>Only active items will appear in stock entry screens</li>
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}