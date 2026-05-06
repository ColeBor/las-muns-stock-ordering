"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "@/lib/supabaseClient";
import { AgGridReact } from "@/lib/agGrid";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";

type Profile = {
  id: string;
  role: string | null;
  store_id: string | null;
  factory_id: string | null;
};

type OrderCycle = {
  id: string;
  name: string;
  started_at: string;
  status: string;
  order_date: string | null;
  created_by: string | null;
  created_at: string;
  cycle_stores?: { stores: { id: string; name: string } }[];
};

type Store = {
  id: string;
  name: string;
  is_high_volume: boolean;
};

type TabKey = "details" | "stockEntries" | "factoryCounts" | "allocations" | "overrides";

export default function AdminCycles() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [cycles, setCycles] = useState<OrderCycle[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingCycle, setEditingCycle] = useState<OrderCycle | null>(null);
  const [name, setName] = useState("");
  const [status, setStatus] = useState<"draft" | "active" | "allocated" | "finalized">("draft");
  const [orderDate, setOrderDate] = useState<string>("");
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedCycleId, setSelectedCycleId] = useState<string | null>(null);
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

  const reloadCycles = async () => {
    const { data } = await supabase
      .from("order_cycles")
      .select("*, cycle_stores(stores(id, name))")
      .order("started_at", { ascending: false });
    if (data) setCycles(data as OrderCycle[]);
  };

  useEffect(() => {
    if (!canManage) {
      setCycles([]);
      setStores([]);
      return;
    }
    const loadAll = async () => {
      const [storesRes] = await Promise.all([
        supabase.from("stores").select("id, name, is_high_volume").order("name"),
        reloadCycles(),
      ]);
      if (storesRes.data) setStores(storesRes.data as Store[]);
    };
    loadAll();
  }, [canManage]);

  const selectedCycle = useMemo(
    () => cycles.find((c) => c.id === selectedCycleId) ?? null,
    [cycles, selectedCycleId],
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage) return;
    setLoading(true);
    setMessage(null);

    const cycleData = {
      name: name.trim(),
      status,
      order_date: orderDate || null,
      created_by: session?.user?.email || null,
    };

    let cycleId: string;
    if (editingCycle) {
      const { error } = await supabase
        .from("order_cycles")
        .update(cycleData)
        .eq("id", editingCycle.id);
      if (error) {
        setMessage(error.message);
        setLoading(false);
        return;
      }
      cycleId = editingCycle.id;
    } else {
      const { data, error } = await supabase
        .from("order_cycles")
        .insert([cycleData])
        .select()
        .single();
      if (error) {
        setMessage(error.message);
        setLoading(false);
        return;
      }
      cycleId = data.id;
    }

    if (editingCycle) {
      await supabase.from("cycle_stores").delete().eq("cycle_id", cycleId);
    }
    if (selectedStoreIds.length > 0) {
      const assignments = selectedStoreIds.map((storeId) => ({
        cycle_id: cycleId,
        store_id: storeId,
      }));
      const { error } = await supabase.from("cycle_stores").insert(assignments);
      if (error) {
        setMessage(error.message);
        setLoading(false);
        return;
      }
    }

    setLoading(false);
    setMessage(editingCycle ? "Cycle updated." : "Cycle created.");
    setShowForm(false);
    setEditingCycle(null);
    setName("");
    setStatus("draft");
    setOrderDate("");
    setSelectedStoreIds([]);
    await reloadCycles();
  };

  const handleEdit = (cycle: OrderCycle) => {
    setEditingCycle(cycle);
    setName(cycle.name);
    setStatus(cycle.status as "draft" | "active" | "allocated" | "finalized");
    setOrderDate(cycle.order_date ?? "");
    setSelectedStoreIds(cycle.cycle_stores?.map((cs) => cs.stores.id) || []);
    setShowForm(true);
  };

  const handleDelete = async (cycle: OrderCycle) => {
    if (cycle.status !== "draft") {
      setMessage("Only draft cycles can be deleted.");
      return;
    }
    if (!confirm(`Delete cycle "${cycle.name}"? This cannot be undone.`)) return;
    const { error } = await supabase.from("order_cycles").delete().eq("id", cycle.id);
    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage("Cycle deleted.");
    if (selectedCycleId === cycle.id) setSelectedCycleId(null);
    setCycles(cycles.filter((c) => c.id !== cycle.id));
  };

  const handleStatusChange = async (cycle: OrderCycle, newStatus: string) => {
    const { error } = await supabase
      .from("order_cycles")
      .update({ status: newStatus })
      .eq("id", cycle.id);
    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage(`Cycle status updated to ${newStatus}.`);
    setCycles(cycles.map((c) => (c.id === cycle.id ? { ...c, status: newStatus } : c)));
  };

  const openManagePanel = (cycle: OrderCycle) => {
    setSelectedCycleId(cycle.id);
    setActiveTab("details");
    handleEdit(cycle);
  };

  const columnDefs: ColDef<OrderCycle>[] = [
    { headerName: "Name", field: "name", sortable: true, filter: true },
    { headerName: "Status", field: "status", sortable: true, filter: true, width: 120 },
    {
      headerName: "Started",
      field: "started_at",
      sortable: true,
      filter: true,
      width: 120,
      valueFormatter: (params) => new Date(params.value).toLocaleDateString(),
    },
    {
      headerName: "Order date",
      field: "order_date",
      sortable: true,
      filter: true,
      width: 130,
      valueFormatter: (params) =>
        params.value ? new Date(params.value).toLocaleDateString() : "",
    },
    {
      headerName: "Stores",
      valueGetter: (params) =>
        params.data?.cycle_stores?.map((cs) => cs.stores.name).join(", ") || "",
      sortable: false,
      filter: false,
    },
    {
      headerName: "Actions",
      width: 320,
      cellRenderer: (params: ICellRendererParams<OrderCycle>) => (
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
            disabled={params.data!.status !== "draft"}
          >
            Delete
          </button>
          {params.data!.status === "draft" && (
            <button
              onClick={() => handleStatusChange(params.data!, "active")}
              className="px-2 py-1 text-xs bg-green-500 text-white rounded"
            >
              Activate
            </button>
          )}
          {params.data!.status === "active" && (
            <button
              onClick={() => handleStatusChange(params.data!, "allocated")}
              className="px-2 py-1 text-xs bg-purple-500 text-white rounded"
            >
              Mark allocated
            </button>
          )}
          {params.data!.status === "allocated" && (
            <button
              onClick={() => handleStatusChange(params.data!, "finalized")}
              className="px-2 py-1 text-xs bg-orange-500 text-white rounded"
            >
              Finalize
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <h1 className="text-3xl font-semibold text-white">Admin: Order Cycles</h1>
      <p className="mt-3 text-slate-400">
        Manage cycles, see stock entries and factory counts, run allocations, and set
        manual overrides — all from one place.
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
            <h2 className="text-xl font-semibold text-white">Cycles</h2>
            <button
              onClick={() => {
                setEditingCycle(null);
                setName("");
                setStatus("draft");
                setOrderDate("");
                setSelectedStoreIds([]);
                setShowForm(true);
                setSelectedCycleId(null);
              }}
              className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
            >
              Create Cycle
            </button>
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          <div className="ag-theme-alpine-dark" style={{ height: 360 }}>
            <AgGridReact
              rowData={cycles}
              columnDefs={columnDefs}
              defaultColDef={{ resizable: true, sortable: true, filter: true }}
            />
          </div>

          {showForm && !selectedCycleId && (
            <CycleEditForm
              editing={editingCycle}
              name={name}
              status={status}
              orderDate={orderDate}
              selectedStoreIds={selectedStoreIds}
              stores={stores}
              loading={loading}
              setName={setName}
              setStatus={setStatus}
              setOrderDate={setOrderDate}
              setSelectedStoreIds={setSelectedStoreIds}
              onSubmit={handleSubmit}
              onCancel={() => setShowForm(false)}
            />
          )}

          {selectedCycle && (
            <div className="rounded-3xl border border-white/10 bg-slate-900/80 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-white">
                  Manage: {selectedCycle.name}{" "}
                  <span className="text-sm font-normal text-slate-400">
                    ({selectedCycle.status})
                  </span>
                </h2>
                <button
                  onClick={() => {
                    setSelectedCycleId(null);
                    setShowForm(false);
                  }}
                  className="px-3 py-1 text-sm border border-white/10 rounded-full text-slate-300 hover:border-cyan-300 hover:text-cyan-300"
                >
                  Close
                </button>
              </div>

              <div className="flex gap-2 border-b border-white/10 mb-4 flex-wrap">
                {(["details", "stockEntries", "factoryCounts", "allocations", "overrides"] as TabKey[]).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-4 py-2 text-sm font-medium transition border-b-2 ${
                      activeTab === tab
                        ? "border-cyan-400 text-cyan-300"
                        : "border-transparent text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {tab === "details"
                      ? "Details"
                      : tab === "stockEntries"
                        ? "Stock entries"
                        : tab === "factoryCounts"
                          ? "Factory counts"
                          : tab === "allocations"
                            ? "Allocations"
                            : "Overrides"}
                  </button>
                ))}
              </div>

              {activeTab === "details" && (
                <CycleEditForm
                  editing={editingCycle}
                  name={name}
                  status={status}
                  orderDate={orderDate}
                  selectedStoreIds={selectedStoreIds}
                  stores={stores}
                  loading={loading}
                  setName={setName}
                  setStatus={setStatus}
                  setOrderDate={setOrderDate}
                  setSelectedStoreIds={setSelectedStoreIds}
                  onSubmit={handleSubmit}
                  onCancel={() => setSelectedCycleId(null)}
                />
              )}
              {activeTab === "stockEntries" && <StockEntriesTab cycleId={selectedCycle.id} />}
              {activeTab === "factoryCounts" && <FactoryCountsTab cycleId={selectedCycle.id} />}
              {activeTab === "allocations" && <AllocationsTab cycleId={selectedCycle.id} />}
              {activeTab === "overrides" && <OverridesTab cycleId={selectedCycle.id} />}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function CycleEditForm(props: {
  editing: OrderCycle | null;
  name: string;
  status: "draft" | "active" | "allocated" | "finalized";
  orderDate: string;
  selectedStoreIds: string[];
  stores: Store[];
  loading: boolean;
  setName: (v: string) => void;
  setStatus: (v: "draft" | "active" | "allocated" | "finalized") => void;
  setOrderDate: (v: string) => void;
  setSelectedStoreIds: (v: string[]) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  return (
    <form onSubmit={props.onSubmit} className="rounded-2xl bg-slate-950/60 p-6 space-y-4">
      <h3 className="text-lg font-semibold text-white">
        {props.editing ? "Edit Cycle" : "Create New Cycle"}
      </h3>

      <div>
        <label className="block text-sm font-medium text-slate-300">Cycle Name</label>
        <input
          type="text"
          value={props.name}
          onChange={(e) => props.setName(e.target.value)}
          className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-300">Status</label>
        <select
          value={props.status}
          onChange={(e) => props.setStatus(e.target.value as "draft" | "active" | "allocated" | "finalized")}
          className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
        >
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="allocated">Allocated</option>
          <option value="finalized">Finalized</option>
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-300">Order date</label>
        <input
          type="date"
          value={props.orderDate}
          onChange={(e) => props.setOrderDate(e.target.value)}
          className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-300 mb-2">
          Participating stores (cycle_stores)
        </label>
        <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto border border-white/10 rounded-2xl p-4 bg-slate-950">
          {props.stores.map((store) => (
            <label key={store.id} className="flex items-center">
              <input
                type="checkbox"
                checked={props.selectedStoreIds.includes(store.id)}
                onChange={(e) => {
                  if (e.target.checked) {
                    props.setSelectedStoreIds([...props.selectedStoreIds, store.id]);
                  } else {
                    props.setSelectedStoreIds(
                      props.selectedStoreIds.filter((id) => id !== store.id),
                    );
                  }
                }}
                className="mr-2"
              />
              <span className="text-sm text-slate-300">
                {store.name} {store.is_high_volume ? "(HV)" : ""}
              </span>
            </label>
          ))}
        </div>
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

type StockEntryRow = {
  store_name: string;
  item_sku: string;
  item_name: string;
  current_count: number;
  entered_at: string;
  entered_by: string | null;
};

function StockEntriesTab({ cycleId }: { cycleId: string }) {
  const [rows, setRows] = useState<StockEntryRow[]>([]);
  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from("stock_entries")
        .select(
          "current_count,entered_at,entered_by,stores(name),items(sku,name)",
        )
        .eq("cycle_id", cycleId)
        .order("entered_at", { ascending: false });
      if (data) {
        setRows(
          (data as unknown as Array<{
            current_count: number;
            entered_at: string;
            entered_by: string | null;
            stores: { name: string } | null;
            items: { sku: string; name: string } | null;
          }>).map((e) => ({
            store_name: e.stores?.name ?? "",
            item_sku: e.items?.sku ?? "",
            item_name: e.items?.name ?? "",
            current_count: e.current_count,
            entered_at: e.entered_at,
            entered_by: e.entered_by,
          })),
        );
      }
    };
    load();
  }, [cycleId]);

  const columnDefs: ColDef<StockEntryRow>[] = [
    { headerName: "Store", field: "store_name", sortable: true, filter: true, width: 180 },
    { headerName: "SKU", field: "item_sku", sortable: true, filter: true, width: 120 },
    { headerName: "Item", field: "item_name", sortable: true, filter: true, width: 220 },
    { headerName: "Count", field: "current_count", sortable: true, filter: true, width: 110 },
    {
      headerName: "Entered",
      field: "entered_at",
      sortable: true,
      filter: true,
      width: 180,
      valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString() : ""),
    },
    { headerName: "By", field: "entered_by", sortable: true, filter: true, width: 200 },
  ];

  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-400">
        Read-only view of what stores have entered for this cycle.
      </p>
      <div className="ag-theme-alpine-dark" style={{ height: 480 }}>
        <AgGridReact
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: true, filter: true }}
        />
      </div>
    </div>
  );
}

type FactoryCountRow = {
  factory_name: string;
  item_sku: string;
  item_name: string;
  available_qty: number;
  counted_at: string;
  counted_by: string | null;
};

function FactoryCountsTab({ cycleId }: { cycleId: string }) {
  const [rows, setRows] = useState<FactoryCountRow[]>([]);
  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from("factory_counts")
        .select(
          "available_qty,counted_at,counted_by,factories(name),items(sku,name)",
        )
        .eq("cycle_id", cycleId)
        .order("counted_at", { ascending: false });
      if (data) {
        setRows(
          (data as unknown as Array<{
            available_qty: number;
            counted_at: string;
            counted_by: string | null;
            factories: { name: string } | null;
            items: { sku: string; name: string } | null;
          }>).map((e) => ({
            factory_name: e.factories?.name ?? "",
            item_sku: e.items?.sku ?? "",
            item_name: e.items?.name ?? "",
            available_qty: e.available_qty,
            counted_at: e.counted_at,
            counted_by: e.counted_by,
          })),
        );
      }
    };
    load();
  }, [cycleId]);

  const columnDefs: ColDef<FactoryCountRow>[] = [
    { headerName: "Factory", field: "factory_name", sortable: true, filter: true, width: 180 },
    { headerName: "SKU", field: "item_sku", sortable: true, filter: true, width: 120 },
    { headerName: "Item", field: "item_name", sortable: true, filter: true, width: 220 },
    { headerName: "Available", field: "available_qty", sortable: true, filter: true, width: 130 },
    {
      headerName: "Counted",
      field: "counted_at",
      sortable: true,
      filter: true,
      width: 180,
      valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString() : ""),
    },
    { headerName: "By", field: "counted_by", sortable: true, filter: true, width: 200 },
  ];

  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-400">
        Read-only view of what factories have reported for this cycle.
      </p>
      <div className="ag-theme-alpine-dark" style={{ height: 480 }}>
        <AgGridReact
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: true, filter: true }}
        />
      </div>
    </div>
  );
}

type AllocationRow = {
  store_name: string;
  item_sku: string;
  item_name: string;
  qty: number;
  source: string;
  factory_name: string;
  shortfall: number;
};

function AllocationsTab({ cycleId }: { cycleId: string }) {
  const [rows, setRows] = useState<AllocationRow[]>([]);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reload = async () => {
    const { data } = await supabase
      .from("allocations")
      .select(
        "qty,source,shortfall,stores(name),items(sku,name),factories!allocations_factory_id_fkey(name)",
      )
      .eq("cycle_id", cycleId);
    if (data) {
      setRows(
        (data as unknown as Array<{
          qty: number;
          source: string;
          shortfall: number;
          stores: { name: string } | null;
          items: { sku: string; name: string } | null;
          factories: { name: string } | null;
        }>).map((a) => ({
          store_name: a.stores?.name ?? "",
          item_sku: a.items?.sku ?? "",
          item_name: a.items?.name ?? "",
          qty: a.qty,
          source: a.source,
          factory_name: a.factories?.name ?? "",
          shortfall: a.shortfall,
        })),
      );
    }
  };

  useEffect(() => {
    reload();
  }, [cycleId]);

  const runAllocations = async () => {
    setRunning(true);
    setMessage(null);
    try {
      const response = await fetch("/api/allocations/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cycle_id: cycleId }),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(`Error: ${data.error}`);
      } else {
        const parts = [
          `${data.allocations_created} allocations`,
          `${data.factory_splits_created ?? 0} factory splits`,
          `${data.purchase_orders_created} purchase orders`,
          `${data.shortfalls} shortfalls`,
        ];
        setMessage(`✅ ${data.message} — ${parts.join(", ")}`);
        await reload();
      }
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally {
      setRunning(false);
    }
  };

  const columnDefs: ColDef<AllocationRow>[] = [
    { headerName: "Store", field: "store_name", sortable: true, filter: true, width: 180 },
    { headerName: "SKU", field: "item_sku", sortable: true, filter: true, width: 120 },
    { headerName: "Item", field: "item_name", sortable: true, filter: true, width: 200 },
    { headerName: "Qty", field: "qty", sortable: true, filter: true, width: 90 },
    { headerName: "Source", field: "source", sortable: true, filter: true, width: 130 },
    { headerName: "Factory", field: "factory_name", sortable: true, filter: true, width: 180 },
    {
      headerName: "Shortfall",
      field: "shortfall",
      sortable: true,
      filter: true,
      width: 110,
      cellStyle: (p) => ({ color: (p.value ?? 0) > 0 ? "#ef4444" : "#10b981" }),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">
          Run the allocation algorithm for this cycle. Each run wipes prior
          allocations + POs and recomputes.
        </p>
        <button
          onClick={runAllocations}
          disabled={running}
          className="px-4 py-2 bg-emerald-500 text-slate-950 rounded-full font-semibold disabled:opacity-50"
        >
          {running ? "Running..." : "Run allocations"}
        </button>
      </div>
      {message && (
        <div
          className={`rounded-2xl p-3 text-sm ${
            message.startsWith("Error") ? "bg-rose-950/80 text-rose-200" : "bg-green-950/80 text-green-200"
          }`}
        >
          {message}
        </div>
      )}
      <div className="ag-theme-alpine-dark" style={{ height: 440 }}>
        <AgGridReact
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: true, filter: true }}
        />
      </div>
    </div>
  );
}

type OverrideRow = {
  cycle_id: string;
  store_id: string;
  item_id: string;
  qty: number;
  reason: string | null;
  set_by: string | null;
  store_name: string;
  item_sku: string;
  item_name: string;
};

function OverridesTab({ cycleId }: { cycleId: string }) {
  const [overrides, setOverrides] = useState<
    Array<{ cycle_id: string; store_id: string; item_id: string; qty: number; reason: string | null; set_by: string | null }>
  >([]);
  const [stores, setStores] = useState<Array<{ id: string; name: string }>>([]);
  const [items, setItems] = useState<Array<{ id: string; name: string; sku: string }>>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [storeId, setStoreId] = useState("");
  const [itemId, setItemId] = useState("");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = async () => {
    const [overridesRes, storesRes, itemsRes] = await Promise.all([
      supabase
        .from("allocation_overrides")
        .select("cycle_id,store_id,item_id,qty,reason,set_by")
        .eq("cycle_id", cycleId)
        .order("set_at", { ascending: false }),
      supabase.from("stores").select("id,name").order("name"),
      supabase.from("items").select("id,name,sku").order("name"),
    ]);
    if (overridesRes.data) setOverrides(overridesRes.data);
    if (storesRes.data) setStores(storesRes.data);
    if (itemsRes.data) setItems(itemsRes.data);
  };

  useEffect(() => {
    reload();
  }, [cycleId]);

  const storeNameById = useMemo(
    () => new Map(stores.map((s) => [s.id, s.name])),
    [stores],
  );
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const rows: OverrideRow[] = useMemo(
    () =>
      overrides.map((o) => ({
        ...o,
        store_name: storeNameById.get(o.store_id) ?? o.store_id,
        item_sku: itemById.get(o.item_id)?.sku ?? "",
        item_name: itemById.get(o.item_id)?.name ?? o.item_id,
      })),
    [overrides, storeNameById, itemById],
  );

  const resetForm = () => {
    setEditingKey(null);
    setStoreId("");
    setItemId("");
    setQty("");
    setReason("");
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const qtyNum = parseInt(qty, 10);
    if (!storeId || !itemId) {
      setMessage("Store and item are required.");
      return;
    }
    if (Number.isNaN(qtyNum) || qtyNum < 0) {
      setMessage("Qty must be non-negative.");
      return;
    }
    setLoading(true);
    setMessage(null);
    const { error } = await supabase.from("allocation_overrides").upsert(
      [{ cycle_id: cycleId, store_id: storeId, item_id: itemId, qty: qtyNum, reason: reason.trim() || null }],
      { onConflict: "cycle_id,store_id,item_id" },
    );
    setLoading(false);
    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage(editingKey ? "Override updated." : "Override created.");
    setShowForm(false);
    resetForm();
    await reload();
  };

  const handleEdit = (row: OverrideRow) => {
    setEditingKey(`${row.store_id}|${row.item_id}`);
    setStoreId(row.store_id);
    setItemId(row.item_id);
    setQty(String(row.qty));
    setReason(row.reason ?? "");
    setShowForm(true);
  };

  const handleDelete = async (row: OverrideRow) => {
    if (!confirm(`Delete override for ${row.store_name} / ${row.item_name}?`)) return;
    const { error } = await supabase
      .from("allocation_overrides")
      .delete()
      .eq("cycle_id", cycleId)
      .eq("store_id", row.store_id)
      .eq("item_id", row.item_id);
    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage("Override deleted.");
    setOverrides((prev) =>
      prev.filter((o) => !(o.store_id === row.store_id && o.item_id === row.item_id)),
    );
  };

  const columnDefs: ColDef<OverrideRow>[] = [
    { headerName: "Store", field: "store_name", sortable: true, filter: true, width: 180 },
    { headerName: "SKU", field: "item_sku", sortable: true, filter: true, width: 120 },
    { headerName: "Item", field: "item_name", sortable: true, filter: true, width: 200 },
    { headerName: "Qty", field: "qty", sortable: true, filter: true, width: 100 },
    { headerName: "Reason", field: "reason", sortable: true, filter: true, flex: 1 },
    { headerName: "Set by", field: "set_by", sortable: true, filter: true, width: 200 },
    {
      headerName: "Actions",
      width: 160,
      cellRenderer: (params: { data: OverrideRow }) => (
        <div className="flex gap-2">
          <button
            onClick={() => handleEdit(params.data)}
            className="px-2 py-1 text-xs bg-blue-500 text-white rounded"
          >
            Edit
          </button>
          <button
            onClick={() => handleDelete(params.data)}
            className="px-2 py-1 text-xs bg-red-500 text-white rounded"
          >
            Delete
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">
          Force a specific qty for (store, item). Allocation pulls from factories using
          the override qty; on the next run the override appears as
          source=manual_override.
        </p>
        <button
          onClick={() => {
            resetForm();
            setShowForm(true);
          }}
          className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
        >
          Add override
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-2xl bg-slate-950/60 p-6 space-y-4">
          <h3 className="text-lg font-semibold text-white">
            {editingKey ? "Edit Override" : "Add Override"}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-slate-300">Store</label>
              <select
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
                disabled={!!editingKey}
                className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400 disabled:opacity-60"
                required
              >
                <option value="">-- select --</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300">Item</label>
              <select
                value={itemId}
                onChange={(e) => setItemId(e.target.value)}
                disabled={!!editingKey}
                className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400 disabled:opacity-60"
                required
              >
                <option value="">-- select --</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>{i.sku} — {i.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300">Qty</label>
              <input
                type="number"
                min="0"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300">Reason</label>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
            >
              {loading ? "Saving..." : editingKey ? "Update" : "Create"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                resetForm();
              }}
              className="px-4 py-2 bg-slate-600 text-white rounded-full"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {message && <p className="text-sm text-cyan-300">{message}</p>}

      <div className="ag-theme-alpine-dark" style={{ height: 380 }}>
        <AgGridReact
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: true, filter: true }}
        />
      </div>
    </div>
  );
}
