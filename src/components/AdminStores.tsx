"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
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
  location: string | null;
  created_at: string;
};

type TabKey = "details" | "items" | "factories";

export default function AdminStores() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingStore, setEditingStore] = useState<Store | null>(null);
  const [name, setName] = useState("");
  const [isHighVolume, setIsHighVolume] = useState(false);
  const [location, setLocation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("details");

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
      const { data } = await supabase
        .from("profiles")
        .select("id,role,store_id,factory_id")
        .eq("id", session.user.id)
        .single();
      setProfile((data as Profile) ?? null);
    };
    loadProfile();
  }, [session]);

  const reloadStores = async () => {
    const { data } = await supabase
      .from("stores")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) setStores(data as Store[]);
  };

  useEffect(() => {
    if (!canManage) {
      setStores([]);
      return;
    }
    reloadStores();
  }, [canManage]);

  const selectedStore = useMemo(
    () => stores.find((s) => s.id === selectedStoreId) ?? null,
    [stores, selectedStoreId],
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage) return;
    setLoading(true);
    setMessage(null);

    const payload = {
      name: name.trim(),
      is_high_volume: isHighVolume,
      location: location.trim() || null,
    };

    const { error } = editingStore
      ? await supabase.from("stores").update(payload).eq("id", editingStore.id)
      : await supabase.from("stores").insert([payload]);

    setLoading(false);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage(editingStore ? "Store updated." : "Store created.");
    setShowForm(false);
    setEditingStore(null);
    setName("");
    setIsHighVolume(false);
    setLocation("");
    await reloadStores();
  };

  const handleEdit = (store: Store) => {
    setEditingStore(store);
    setName(store.name);
    setIsHighVolume(store.is_high_volume);
    setLocation(store.location || "");
    setShowForm(true);
  };

  const handleDelete = async (store: Store) => {
    if (!confirm(`Delete store "${store.name}"? This cannot be undone.`)) return;
    const { error } = await supabase.from("stores").delete().eq("id", store.id);
    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage("Store deleted.");
    if (selectedStoreId === store.id) setSelectedStoreId(null);
    setStores(stores.filter((s) => s.id !== store.id));
  };

  const openManagePanel = (store: Store) => {
    setSelectedStoreId(store.id);
    setActiveTab("details");
    handleEdit(store);
  };

  const columnDefs: ColDef<Store>[] = [
    { headerName: "Name", field: "name", sortable: true, filter: true },
    { headerName: "High Volume", field: "is_high_volume", sortable: true, filter: true, width: 130 },
    { headerName: "Location", field: "location", sortable: true, filter: true },
    {
      headerName: "Actions",
      width: 280,
      cellRenderer: (params: ICellRendererParams<Store>) => (
        <div className="flex gap-2">
          <button
            onClick={() => openManagePanel(params.data!)}
            className="px-2 py-1 text-xs bg-cyan-500 text-slate-950 rounded font-semibold"
          >
            Manage
          </button>
          <button
            onClick={() => handleDelete(params.data!)}
            className="px-2 py-1 text-xs bg-red-500 text-white rounded"
          >
            Delete
          </button>
        </div>
      ),
    },
  ];

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <h1 className="text-3xl font-semibold text-white">Admin: Stores</h1>
      <p className="mt-3 text-slate-400">
        Manage stores, the items each store carries, and which factories ship to it.
      </p>

      {!isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in to access this page.</p>
        </div>
      ) : !isHQAdmin ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to HQ administrators.</p>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-semibold text-white">Stores</h2>
            <button
              onClick={() => {
                setEditingStore(null);
                setName("");
                setIsHighVolume(false);
                setLocation("");
                setShowForm(true);
                setSelectedStoreId(null);
              }}
              className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
            >
              Add Store
            </button>
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          <div className="ag-theme-alpine-dark" style={{ height: 360 }}>
            <AgGridReact
              rowData={stores}
              columnDefs={columnDefs}
              defaultColDef={{ resizable: true, sortable: true, filter: true }}
            />
          </div>

          {showForm && !selectedStoreId && (
            <StoreEditForm
              editing={editingStore}
              name={name}
              isHighVolume={isHighVolume}
              location={location}
              loading={loading}
              setName={setName}
              setIsHighVolume={setIsHighVolume}
              setLocation={setLocation}
              onSubmit={handleSubmit}
              onCancel={() => setShowForm(false)}
            />
          )}

          {selectedStore && (
            <div className="rounded-3xl border border-white/10 bg-slate-900/80 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-white">
                  Manage: {selectedStore.name}
                </h2>
                <button
                  onClick={() => {
                    setSelectedStoreId(null);
                    setShowForm(false);
                  }}
                  className="px-3 py-1 text-sm border border-white/10 rounded-full text-slate-300 hover:border-cyan-300 hover:text-cyan-300"
                >
                  Close
                </button>
              </div>

              <div className="flex gap-2 border-b border-white/10 mb-4">
                {(["details", "items", "factories"] as TabKey[]).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-4 py-2 text-sm font-medium transition border-b-2 ${
                      activeTab === tab
                        ? "border-cyan-400 text-cyan-300"
                        : "border-transparent text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {tab === "details" ? "Details" : tab === "items" ? "Items & capacity" : "Factory priorities"}
                  </button>
                ))}
              </div>

              {activeTab === "details" && (
                <StoreEditForm
                  editing={editingStore}
                  name={name}
                  isHighVolume={isHighVolume}
                  location={location}
                  loading={loading}
                  setName={setName}
                  setIsHighVolume={setIsHighVolume}
                  setLocation={setLocation}
                  onSubmit={handleSubmit}
                  onCancel={() => setSelectedStoreId(null)}
                />
              )}
              {activeTab === "items" && <StoreItemsTab storeId={selectedStore.id} />}
              {activeTab === "factories" && <StoreFactoriesTab storeId={selectedStore.id} />}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function StoreEditForm(props: {
  editing: Store | null;
  name: string;
  isHighVolume: boolean;
  location: string;
  loading: boolean;
  setName: (v: string) => void;
  setIsHighVolume: (v: boolean) => void;
  setLocation: (v: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  return (
    <form onSubmit={props.onSubmit} className="rounded-2xl bg-slate-950/60 p-6 space-y-4">
      <h3 className="text-lg font-semibold text-white">
        {props.editing ? "Edit Store" : "Add New Store"}
      </h3>

      <div>
        <label className="block text-sm font-medium text-slate-300">Name</label>
        <input
          type="text"
          value={props.name}
          onChange={(e) => props.setName(e.target.value)}
          className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
          required
        />
      </div>

      <div>
        <label className="flex items-center">
          <input
            type="checkbox"
            checked={props.isHighVolume}
            onChange={(e) => props.setIsHighVolume(e.target.checked)}
            className="mr-2"
          />
          <span className="text-sm font-medium text-slate-300">High Volume Store</span>
        </label>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-300">Location</label>
        <input
          type="text"
          value={props.location}
          onChange={(e) => props.setLocation(e.target.value)}
          className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
        />
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={props.loading}
          className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
        >
          {props.loading ? "Saving..." : props.editing ? "Update" : "Create"}
        </button>
        <button type="button" onClick={props.onCancel} className="px-4 py-2 bg-slate-600 text-white rounded-full">
          Cancel
        </button>
      </div>
    </form>
  );
}

type Item = {
  id: string;
  sku: string;
  name: string;
  type: string;
  unit: string | null;
};

type StoreItemRow = {
  item_id: string;
  sku: string;
  name: string;
  type: string;
  unit: string | null;
  is_active: boolean;
  capacity: number;
};

function StoreItemsTab({ storeId }: { storeId: string }) {
  const [allItems, setAllItems] = useState<Item[]>([]);
  const [storeItems, setStoreItems] = useState<{ item_id: string; is_active: boolean; capacity: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reload = async () => {
    const [itemsRes, storeItemsRes] = await Promise.all([
      supabase.from("items").select("id,sku,name,type,unit").order("name"),
      supabase
        .from("store_items")
        .select("item_id,is_active,capacity")
        .eq("store_id", storeId),
    ]);
    if (itemsRes.data) setAllItems(itemsRes.data as Item[]);
    if (storeItemsRes.data) setStoreItems(storeItemsRes.data);
  };

  useEffect(() => {
    reload();
  }, [storeId]);

  const rows: StoreItemRow[] = useMemo(() => {
    const byId = new Map(storeItems.map((si) => [si.item_id, si]));
    return allItems.map((item) => {
      const si = byId.get(item.id);
      return {
        item_id: item.id,
        sku: item.sku,
        name: item.name,
        type: item.type,
        unit: item.unit,
        is_active: si?.is_active ?? false,
        capacity: si?.capacity ?? 0,
      };
    });
  }, [allItems, storeItems]);

  const toggleActive = async (itemId: string, currentActive: boolean) => {
    setLoading(true);
    setMessage(null);
    const now = new Date().toISOString();

    if (currentActive) {
      await supabase
        .from("store_items")
        .update({ is_active: false, deactivated_at: now })
        .eq("store_id", storeId)
        .eq("item_id", itemId);
    } else {
      await supabase.from("store_items").upsert({
        store_id: storeId,
        item_id: itemId,
        is_active: true,
        capacity: 0,
        activated_at: now,
      });
    }

    await reload();
    setLoading(false);
    setMessage(currentActive ? "Item deactivated." : "Item activated.");
  };

  const setCapacity = async (itemId: string, capacity: number) => {
    setLoading(true);
    setMessage(null);
    const now = new Date().toISOString();
    const { error } = await supabase.from("store_items").upsert({
      store_id: storeId,
      item_id: itemId,
      is_active: true,
      capacity,
      activated_at: now,
    });
    await reload();
    setLoading(false);
    setMessage(error ? error.message : "Capacity updated.");
  };

  const activateAll = async () => {
    if (!confirm("Activate all items for this store?")) return;
    setLoading(true);
    const now = new Date().toISOString();
    const payload = allItems.map((item) => ({
      store_id: storeId,
      item_id: item.id,
      is_active: true,
      capacity: 0,
      activated_at: now,
    }));
    await supabase.from("store_items").upsert(payload);
    await reload();
    setLoading(false);
    setMessage("All items activated.");
  };

  const columnDefs: ColDef<StoreItemRow>[] = [
    { headerName: "SKU", field: "sku", sortable: true, filter: true, width: 120 },
    { headerName: "Name", field: "name", sortable: true, filter: true, width: 220 },
    { headerName: "Type", field: "type", sortable: true, filter: true, width: 130 },
    { headerName: "Unit", field: "unit", sortable: true, filter: true, width: 100 },
    {
      headerName: "Active",
      field: "is_active",
      width: 100,
      cellRenderer: (params: ICellRendererParams<StoreItemRow>) => (
        <input
          type="checkbox"
          checked={params.value}
          onChange={() => toggleActive(params.data!.item_id, params.value)}
          disabled={loading}
        />
      ),
    },
    {
      headerName: "Capacity",
      field: "capacity",
      width: 130,
      editable: true,
      cellEditor: "agNumberCellEditor",
      cellEditorParams: { min: 0 },
      onCellValueChanged: (params) => {
        if (params.newValue !== params.oldValue) {
          setCapacity(params.data.item_id, params.newValue);
        }
      },
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-slate-400">
          Toggle items active for this store and set per-item capacity.
        </p>
        <button
          onClick={activateAll}
          className="px-3 py-2 bg-green-500 text-slate-950 rounded font-semibold text-sm"
          disabled={loading}
        >
          Activate all
        </button>
      </div>
      {message && <p className="text-sm text-cyan-300">{message}</p>}
      <div className="ag-theme-alpine-dark" style={{ height: 480 }}>
        <AgGridReact
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: true, filter: true }}
          pagination
          paginationPageSize={20}
        />
      </div>
    </div>
  );
}

type Factory = {
  id: string;
  name: string;
  location: string | null;
};

type StoreFactoryRow = {
  factory_id: string;
  factory_name: string;
  location: string | null;
  priority: number;
};

function StoreFactoriesTab({ storeId }: { storeId: string }) {
  const [allFactories, setAllFactories] = useState<Factory[]>([]);
  const [storeFactories, setStoreFactories] = useState<{ factory_id: string; priority: number }[]>([]);
  const [addFactoryId, setAddFactoryId] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reload = async () => {
    const [factoriesRes, sfRes] = await Promise.all([
      supabase.from("factories").select("id,name,location").order("name"),
      supabase
        .from("store_factories")
        .select("factory_id,priority")
        .eq("store_id", storeId)
        .order("priority"),
    ]);
    if (factoriesRes.data) setAllFactories(factoriesRes.data as Factory[]);
    if (sfRes.data) setStoreFactories(sfRes.data);
  };

  useEffect(() => {
    reload();
  }, [storeId]);

  const factoriesById = useMemo(
    () => new Map(allFactories.map((f) => [f.id, f])),
    [allFactories],
  );

  const rows: StoreFactoryRow[] = useMemo(
    () =>
      storeFactories.map((sf) => {
        const f = factoriesById.get(sf.factory_id);
        return {
          factory_id: sf.factory_id,
          factory_name: f?.name ?? sf.factory_id,
          location: f?.location ?? null,
          priority: sf.priority,
        };
      }),
    [storeFactories, factoriesById],
  );

  const availableFactories = useMemo(
    () =>
      allFactories.filter((f) => !storeFactories.some((sf) => sf.factory_id === f.id)),
    [allFactories, storeFactories],
  );

  const nextPriority = useMemo(() => {
    const used = storeFactories.map((sf) => sf.priority).sort((a, b) => a - b);
    let p = 1;
    for (const prio of used) {
      if (prio === p) p++;
      else break;
    }
    return p;
  }, [storeFactories]);

  const addFactory = async () => {
    if (!addFactoryId) return;
    setLoading(true);
    setMessage(null);
    const { error } = await supabase
      .from("store_factories")
      .insert({ store_id: storeId, factory_id: addFactoryId, priority: nextPriority });
    setAddFactoryId("");
    await reload();
    setLoading(false);
    setMessage(error ? error.message : "Factory added.");
  };

  const removeFactory = async (factoryId: string) => {
    if (!confirm("Remove this factory from the store?")) return;
    setLoading(true);
    const { error } = await supabase
      .from("store_factories")
      .delete()
      .eq("store_id", storeId)
      .eq("factory_id", factoryId);
    await reload();
    setLoading(false);
    setMessage(error ? error.message : "Factory removed.");
  };

  const setPriority = async (factoryId: string, priority: number) => {
    setLoading(true);
    const { error } = await supabase
      .from("store_factories")
      .update({ priority })
      .eq("store_id", storeId)
      .eq("factory_id", factoryId);
    await reload();
    setLoading(false);
    setMessage(error ? error.message : "Priority updated.");
  };

  const columnDefs: ColDef<StoreFactoryRow>[] = [
    { headerName: "Factory", field: "factory_name", sortable: true, filter: true, width: 200 },
    { headerName: "Location", field: "location", sortable: true, filter: true, width: 200 },
    {
      headerName: "Priority",
      field: "priority",
      width: 120,
      editable: true,
      cellEditor: "agNumberCellEditor",
      cellEditorParams: { min: 1 },
      onCellValueChanged: (params) => {
        if (params.newValue !== params.oldValue) {
          setPriority(params.data.factory_id, params.newValue);
        }
      },
    },
    {
      headerName: "Actions",
      width: 120,
      cellRenderer: (params: ICellRendererParams<StoreFactoryRow>) => (
        <button
          onClick={() => removeFactory(params.data!.factory_id)}
          className="px-2 py-1 text-xs bg-red-500 text-white rounded"
          disabled={loading}
        >
          Remove
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400">
        Lower priority numbers ship first (1 = primary).
      </p>

      <div className="flex items-center gap-2 rounded-2xl bg-slate-950/60 p-4">
        <select
          value={addFactoryId}
          onChange={(e) => setAddFactoryId(e.target.value)}
          disabled={availableFactories.length === 0 || loading}
          className="flex-1 px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm"
        >
          <option value="">
            {availableFactories.length === 0 ? "All factories assigned" : "Select factory to add..."}
          </option>
          {availableFactories.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} {f.location ? `(${f.location})` : ""}
            </option>
          ))}
        </select>
        <button
          onClick={addFactory}
          disabled={!addFactoryId || loading}
          className="px-3 py-2 bg-cyan-500 text-slate-950 rounded font-semibold text-sm disabled:opacity-50"
        >
          Add (priority {nextPriority})
        </button>
      </div>

      {message && <p className="text-sm text-cyan-300">{message}</p>}

      <div className="ag-theme-alpine-dark" style={{ height: 360 }}>
        <AgGridReact
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: true, filter: true }}
        />
      </div>
    </div>
  );
}
