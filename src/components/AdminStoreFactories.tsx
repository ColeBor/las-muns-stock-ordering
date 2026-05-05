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

type Factory = {
  id: string;
  name: string;
  location: string | null;
};

type StoreFactory = {
  store_id: string;
  factory_id: string;
  priority: number;
  stores?: { name: string };
  factories?: { name: string; location: string | null };
};

export default function AdminStoreFactories() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [storeFactories, setStoreFactories] = useState<StoreFactory[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [factories, setFactories] = useState<Factory[]>([]);
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
      setStoreFactories([]);
      setStores([]);
      setFactories([]);
      return;
    }

    const loadData = async () => {
      const [storeFactoriesResponse, storesResponse, factoriesResponse] = await Promise.all([
        supabase
          .from("store_factories")
          .select(`
            *,
            stores(name),
            factories(name, location)
          `)
          .order("store_id, priority"),
        supabase.from("stores").select("id, name, is_high_volume").order("name"),
        supabase.from("factories").select("id, name, location").order("name"),
      ]);

      if (storeFactoriesResponse.data) {
        setStoreFactories(storeFactoriesResponse.data as StoreFactory[]);
      }

      if (storesResponse.data) {
        setStores(storesResponse.data as Store[]);
      }

      if (factoriesResponse.data) {
        setFactories(factoriesResponse.data as Factory[]);
      }
    };

    loadData();
  }, [canManage]);

  const handleAddFactory = async (storeId: string, factoryId: string) => {
    // Find the next priority number for this store
    const existingPriorities = storeFactories
      .filter(sf => sf.store_id === storeId)
      .map(sf => sf.priority)
      .sort((a, b) => a - b);

    let nextPriority = 1;
    for (const priority of existingPriorities) {
      if (nextPriority === priority) {
        nextPriority++;
      } else {
        break;
      }
    }

    setLoading(true);
    setMessage(null);

    const { error } = await supabase
      .from("store_factories")
      .insert({
        store_id: storeId,
        factory_id: factoryId,
        priority: nextPriority,
      });

    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }

    // Reload data
    const { data } = await supabase
      .from("store_factories")
      .select(`
        *,
        stores(name),
        factories(name, location)
      `)
      .order("store_id, priority");

    if (data) {
      setStoreFactories(data as StoreFactory[]);
    }

    setLoading(false);
    setMessage("Factory added to store successfully.");
  };

  const handleRemoveFactory = async (storeId: string, factoryId: string) => {
    if (!confirm("Remove this factory from the store?")) return;

    setLoading(true);
    setMessage(null);

    const { error } = await supabase
      .from("store_factories")
      .delete()
      .eq("store_id", storeId)
      .eq("factory_id", factoryId);

    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }

    // Reload data
    const { data } = await supabase
      .from("store_factories")
      .select(`
        *,
        stores(name),
        factories(name, location)
      `)
      .order("store_id, priority");

    if (data) {
      setStoreFactories(data as StoreFactory[]);
    }

    setLoading(false);
    setMessage("Factory removed from store successfully.");
  };

  const handlePriorityChange = async (storeId: string, factoryId: string, newPriority: number) => {
    setLoading(true);
    setMessage(null);

    const { error } = await supabase
      .from("store_factories")
      .update({ priority: newPriority })
      .eq("store_id", storeId)
      .eq("factory_id", factoryId);

    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }

    // Reload data
    const { data } = await supabase
      .from("store_factories")
      .select(`
        *,
        stores(name),
        factories(name, location)
      `)
      .order("store_id, priority");

    if (data) {
      setStoreFactories(data as StoreFactory[]);
    }

    setLoading(false);
    setMessage("Priority updated successfully.");
  };

  const columnDefs: ColDef<StoreFactory>[] = [
    {
      headerName: "Store",
      valueGetter: (params) => params.data?.stores?.name || "",
      sortable: true,
      filter: true,
      width: 150,
    },
    {
      headerName: "Factory",
      valueGetter: (params) => params.data?.factories?.name || "",
      sortable: true,
      filter: true,
      width: 150,
    },
    {
      headerName: "Location",
      valueGetter: (params) => params.data?.factories?.location || "",
      sortable: true,
      filter: true,
      width: 150,
    },
    {
      headerName: "Priority",
      field: "priority",
      sortable: true,
      filter: true,
      width: 100,
      editable: true,
      cellEditor: "agNumberCellEditor",
      cellEditorParams: {
        min: 1,
      },
      onCellValueChanged: (params) => {
        if (params.newValue !== params.oldValue) {
          handlePriorityChange(params.data.store_id, params.data.factory_id, params.newValue);
        }
      },
    },
    {
      headerName: "Actions",
      cellRenderer: (params: ICellRendererParams<StoreFactory>) => (
        <button
          onClick={() => handleRemoveFactory(params.data!.store_id, params.data!.factory_id)}
          className="px-2 py-1 text-xs bg-red-500 text-white rounded"
          disabled={loading}
        >
          Remove
        </button>
      ),
      width: 100,
    },
  ];

  // Group store-factories by store for the add factory dropdowns
  const storesWithFactories = stores.map(store => ({
    ...store,
    assignedFactories: storeFactories.filter(sf => sf.store_id === store.id),
    availableFactories: factories.filter(factory =>
      !storeFactories.some(sf => sf.store_id === store.id && sf.factory_id === factory.id)
    ),
  }));

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <h1 className="text-3xl font-semibold text-white">Admin: Store-Factory Priorities</h1>
      <p className="mt-3 text-slate-400">
        Configure factory priority order for each store. Lower priority numbers = higher priority (1 = primary factory).
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
            <h2 className="text-xl font-semibold text-white">Factory Assignments</h2>
            <div className="text-sm text-slate-400">
              {storeFactories.length} assignments loaded
            </div>
          </div>

          {/* Add Factory Section */}
          <div className="rounded-2xl bg-slate-900/80 p-6">
            <h3 className="text-lg font-semibold text-white mb-4">Add Factories to Stores</h3>
            <div className="grid gap-4">
              {storesWithFactories.map((store) => (
                <div key={store.id} className="flex items-center gap-4 p-4 bg-slate-800/50 rounded-lg">
                  <div className="flex-1">
                    <span className="font-medium text-white">{store.name}</span>
                    {store.is_high_volume && (
                      <span className="ml-2 text-xs bg-orange-500 text-white px-2 py-1 rounded">High Volume</span>
                    )}
                    <div className="text-sm text-slate-400 mt-1">
                      Assigned: {store.assignedFactories.map(sf => sf.factories?.name).join(", ") || "None"}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      className="px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white text-sm"
                      disabled={store.availableFactories.length === 0 || loading}
                    >
                      <option value="">Select factory to add...</option>
                      {store.availableFactories.map((factory) => (
                        <option key={factory.id} value={factory.id}>
                          {factory.name} {factory.location ? `(${factory.location})` : ""}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => {
                        const select = document.querySelector(`select`) as HTMLSelectElement;
                        const factoryId = select.value;
                        if (factoryId) {
                          handleAddFactory(store.id, factoryId);
                          select.value = "";
                        }
                      }}
                      className="px-3 py-2 bg-cyan-500 text-slate-950 rounded font-semibold text-sm"
                      disabled={store.availableFactories.length === 0 || loading}
                    >
                      Add
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          <div className="ag-theme-alpine-dark" style={{ height: 500 }}>
            <AgGridReact
              rowData={storeFactories}
              columnDefs={columnDefs}
              defaultColDef={{
                resizable: true,
                sortable: true,
                filter: true,
              }}
              pagination={true}
              paginationPageSize={15}
            />
          </div>

          <div className="text-sm text-slate-400">
            <p><strong>Instructions:</strong></p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>Use the "Add Factories to Stores" section above to assign factories to stores</li>
              <li>Click on priority numbers to edit them (lower = higher priority)</li>
              <li>Priority 1 = primary factory, 2 = secondary, etc.</li>
              <li>The allocation engine uses this priority order for manufactured items</li>
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}