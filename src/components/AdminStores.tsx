"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import { AgGridReact } from "@/lib/agGrid";
import type { ColDef, ICellRendererParams } from "ag-grid-community";

type Store = {
  id: string;
  name: string;
  tier: number;
  location: string | null;
  daily_waste_cap: number | null;
  created_at: string;
};

type TabKey = "details" | "items";

export default function AdminStores({
  viewSelector,
}: {
  viewSelector?: React.ReactNode;
} = {}) {
  const { loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
  const [stores, setStores] = useState<Store[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingStore, setEditingStore] = useState<Store | null>(null);
  const [name, setName] = useState("");
  const [tier, setTier] = useState(3);
  const [location, setLocation] = useState("");
  // Per-store daily waste cap override. Empty string = use the global default.
  const [wasteCap, setWasteCap] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("details");

  const canManage = isStoreManager;

  // Drop stale responses so racing realtime events can't clobber the list.
  const reloadStoresTokenRef = useRef(0);
  const reloadStores = useCallback(async () => {
    if (!canManage) {
      setStores([]);
      return;
    }
    const myToken = ++reloadStoresTokenRef.current;
    const { data } = await supabase
      .from("stores")
      .select("*")
      .order("created_at", { ascending: false });
    if (myToken !== reloadStoresTokenRef.current) return;
    if (data) setStores(data as Store[]);
  }, [canManage]);

  useEffect(() => {
    reloadStores();
  }, [reloadStores]);

  useRealtimeRefetch(
    canManage ? [{ table: "stores" }] : [],
    reloadStores,
    "admin-stores",
  );

  const selectedStore = useMemo(
    () => stores.find((s) => s.id === selectedStoreId) ?? null,
    [stores, selectedStoreId],
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage) return;
    setLoading(true);
    setMessage(null);

    const trimmedCap = wasteCap.trim();
    const parsedCap = trimmedCap === "" ? null : parseInt(trimmedCap, 10);
    if (parsedCap !== null && (!Number.isFinite(parsedCap) || parsedCap <= 0)) {
      setLoading(false);
      setMessage("Daily waste cap must be a positive whole number, or left blank.");
      return;
    }

    const payload = {
      name: name.trim(),
      tier,
      location: location.trim() || null,
      daily_waste_cap: parsedCap,
    };

    try {
      const { error } = editingStore
        ? await supabase.from("stores").update(payload).eq("id", editingStore.id)
        : await supabase.from("stores").insert([payload]);

      if (error) {
        setMessage(error.message);
        return;
      }

      setMessage(editingStore ? "Store updated." : "Store created.");
      setShowForm(false);
      setEditingStore(null);
      setName("");
      setTier(3);
      setLocation("");
      setWasteCap("");
      await reloadStores();
    } catch (err) {
      setMessage(
        `Couldn't save store: ${err instanceof Error ? err.message : "network timeout"}. Try again.`,
      );
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (store: Store) => {
    setEditingStore(store);
    setName(store.name);
    setTier(store.tier);
    setLocation(store.location || "");
    setWasteCap(store.daily_waste_cap != null ? String(store.daily_waste_cap) : "");
    setShowForm(true);
  };

  const handleDelete = async (store: Store) => {
    if (!confirm(`Delete store "${store.name}"? This cannot be undone.`)) return;
    try {
      const { error } = await supabase.from("stores").delete().eq("id", store.id);
      if (error) {
        setMessage(error.message);
        return;
      }
      setMessage("Store deleted.");
      if (selectedStoreId === store.id) setSelectedStoreId(null);
      setStores(stores.filter((s) => s.id !== store.id));
    } catch (err) {
      setMessage(
        `Couldn't delete store: ${err instanceof Error ? err.message : "network timeout"}. Try again.`,
      );
    }
  };

  const openManagePanel = (store: Store) => {
    setSelectedStoreId(store.id);
    setActiveTab("details");
    handleEdit(store);
  };

  const columnDefs: ColDef<Store>[] = [
    { headerName: "Name", field: "name", sortable: true, filter: true, flex: 2, minWidth: 150 },
    { headerName: "Tier", field: "tier", sortable: true, filter: true, width: 100 },
    { headerName: "Location", field: "location", sortable: true, filter: true, flex: 2, minWidth: 130 },
    {
      headerName: "Actions",
      width: 200,
      cellRenderer: (params: ICellRendererParams<Store>) => (
        <div className="flex h-full items-center justify-center gap-2">
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
      {!viewSelector && (
        <>
          <h1 className="text-3xl font-semibold text-white">Admin: Stores</h1>
          <p className="mt-3 text-slate-400">
            Add stores, choose what they carry, and set which factories ship to them.
          </p>
        </>
      )}

      {authLoading ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Loading…</p>
        </div>
      ) : !isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in to access this page.</p>
        </div>
      ) : !isStoreManager ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to Store Managers.</p>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          <div className="flex flex-wrap justify-between items-center gap-3">
            {viewSelector ?? (
              <h2 className="text-xl font-semibold text-white">Stores</h2>
            )}
            <button
              onClick={() => {
                setEditingStore(null);
                setName("");
                setTier(3);
                setLocation("");
                setWasteCap("");
                setShowForm(true);
                setSelectedStoreId(null);
              }}
              className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
            >
              Add Store
            </button>
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          <div style={{ height: 360 }}>
            <AgGridReact
              rowData={stores}
              columnDefs={columnDefs}
              defaultColDef={{ resizable: true, sortable: true, filter: true, minWidth: 80 }}
            />
          </div>

          {showForm && !selectedStoreId && (
            <StoreEditForm
              editing={editingStore}
              name={name}
              tier={tier}
              location={location}
              wasteCap={wasteCap}
              loading={loading}
              setName={setName}
              setTier={setTier}
              setLocation={setLocation}
              setWasteCap={setWasteCap}
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
                {(["details", "items"] as TabKey[]).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-4 py-2 text-sm font-medium transition border-b-2 ${
                      activeTab === tab
                        ? "border-cyan-400 text-cyan-300"
                        : "border-transparent text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {tab === "details" ? "Details" : "Items & Capacity"}
                  </button>
                ))}
              </div>

              {activeTab === "details" && (
                <StoreEditForm
                  editing={editingStore}
                  name={name}
                  tier={tier}
                  location={location}
                  wasteCap={wasteCap}
                  loading={loading}
                  setName={setName}
                  setTier={setTier}
                  setLocation={setLocation}
                  setWasteCap={setWasteCap}
                  onSubmit={handleSubmit}
                  onCancel={() => setSelectedStoreId(null)}
                />
              )}
              {activeTab === "items" && <StoreItemsTab storeId={selectedStore.id} />}
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
  tier: number;
  location: string;
  wasteCap: string;
  loading: boolean;
  setName: (v: string) => void;
  setTier: (v: number) => void;
  setLocation: (v: string) => void;
  setWasteCap: (v: string) => void;
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
        <label className="block text-sm font-medium text-slate-300">
          Tier <span className="text-xs text-slate-500">(1 = highest priority for stock)</span>
        </label>
        <input
          type="number"
          min={1}
          value={props.tier}
          onChange={(e) =>
            props.setTier(Math.max(1, parseInt(e.target.value, 10) || 1))
          }
          className="mt-1 rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400 w-32"
        />
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

      <div>
        <label className="block text-sm font-medium text-slate-300">
          Daily waste cap{" "}
          <span className="text-xs text-slate-500">
            (items/day before this store is flagged — leave blank to use the global default)
          </span>
        </label>
        <input
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={props.wasteCap}
          onChange={(e) => props.setWasteCap(e.target.value)}
          placeholder="Global default"
          className="mt-1 w-40 rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
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
  name: string;
  type: string;
};

type StoreItemRow = {
  item_id: string;
  name: string;
  type: string;
  is_active: boolean;
  capacity: number;
};

function StoreItemsTab({ storeId }: { storeId: string }) {
  const [allItems, setAllItems] = useState<Item[]>([]);
  const [storeItems, setStoreItems] = useState<{ item_id: string; is_active: boolean; capacity: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Drop stale responses so racing realtime events (toggling many items,
  // edits from another tab) can't overwrite the grid with old data.
  const reloadTokenRef = useRef(0);
  const reload = useCallback(async () => {
    const myToken = ++reloadTokenRef.current;
    const [itemsRes, storeItemsRes] = await Promise.all([
      supabase.from("items").select("id,name,type").order("name"),
      supabase
        .from("store_items")
        .select("item_id,is_active,capacity")
        .eq("store_id", storeId),
    ]);
    if (myToken !== reloadTokenRef.current) return;
    if (itemsRes.data) setAllItems(itemsRes.data as Item[]);
    if (storeItemsRes.data) setStoreItems(storeItemsRes.data);
  }, [storeId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useRealtimeRefetch(
    [{ table: "items" }, { table: "store_items" }],
    reload,
    `admin-stores-${storeId}-items`,
  );

  const rows: StoreItemRow[] = useMemo(() => {
    const byId = new Map(storeItems.map((si) => [si.item_id, si]));
    return allItems.map((item) => {
      const si = byId.get(item.id);
      return {
        item_id: item.id,
        name: item.name,
        type: item.type,
        is_active: si?.is_active ?? false,
        capacity: si?.capacity ?? 0,
      };
    });
  }, [allItems, storeItems]);

  const toggleActive = async (itemId: string, currentActive: boolean) => {
    setLoading(true);
    setMessage(null);
    const now = new Date().toISOString();

    try {
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
      setMessage(currentActive ? "Item deactivated." : "Item activated.");
    } catch (err) {
      setMessage(
        `Couldn't ${currentActive ? "deactivate" : "activate"} item: ${err instanceof Error ? err.message : "network timeout"}. Try again.`,
      );
    } finally {
      setLoading(false);
    }
  };

  const setCapacity = async (itemId: string, capacity: number) => {
    setLoading(true);
    setMessage(null);
    const now = new Date().toISOString();
    try {
      const { error } = await supabase.from("store_items").upsert({
        store_id: storeId,
        item_id: itemId,
        is_active: true,
        capacity,
        activated_at: now,
      });
      await reload();
      setMessage(error ? error.message : "Capacity updated.");
    } catch (err) {
      setMessage(
        `Couldn't update capacity: ${err instanceof Error ? err.message : "network timeout"}. Try again.`,
      );
    } finally {
      setLoading(false);
    }
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
    try {
      await supabase.from("store_items").upsert(payload);
      await reload();
      setMessage("All items activated.");
    } catch (err) {
      setMessage(
        `Couldn't activate all items: ${err instanceof Error ? err.message : "network timeout"}. Try again.`,
      );
    } finally {
      setLoading(false);
    }
  };

  const columnDefs: ColDef<StoreItemRow>[] = [
    { headerName: "Name", field: "name", sortable: true, filter: true, flex: 2, minWidth: 150 },
    {
      headerName: "Type",
      field: "type",
      sortable: true,
      filter: true,
      width: 130,
      valueFormatter: (p) => {
        const v = (p.value as string | undefined) ?? "";
        return v ? v.charAt(0).toUpperCase() + v.slice(1) : "";
      },
    },
    {
      headerName: "Active",
      field: "is_active",
      width: 90,
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
      width: 110,
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
          Pick which items this store sells and set each one&apos;s full
          capacity (how many they hold when fully stocked).
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
      <div style={{ height: 480 }}>
        <AgGridReact
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: true, filter: true, minWidth: 80 }}
          pagination
          paginationPageSize={20}
        />
      </div>
    </div>
  );
}

