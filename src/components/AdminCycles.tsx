"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { AgGridReact } from "@/lib/agGrid";
import type { ColDef, ICellRendererParams } from "ag-grid-community";

type Profile = {
  id: string;
  role: string | null;
  store_id: string | null;
  factory_id: string | null;
};

type OrderCycle = {
  id: string;
  status: string;
  order_date: string;
  created_by: string | null;
  created_at: string;
  cycle_stores?: { stores: { id: string; name: string } }[];
};

const formatCycleName = (cycle: { order_date: string } | null | undefined) =>
  cycle?.order_date
    ? new Date(cycle.order_date).toLocaleDateString()
    : "(no date)";

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
      .order("created_at", { ascending: false });
    if (!data) return;
    // Active cycles (draft / allocated) first, delivered (archived) last.
    const sorted = [...(data as OrderCycle[])].sort((a, b) => {
      const aDelivered = a.status === "delivered" ? 1 : 0;
      const bDelivered = b.status === "delivered" ? 1 : 0;
      if (aDelivered !== bDelivered) return aDelivered - bDelivered;
      return 0; // preserve created_at desc within each group
    });
    setCycles(sorted);
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

    // Status is machine-driven (draft → allocated → delivered) so we never
    // include it in the upsert. Inserts let the DB default to 'draft';
    // updates leave whatever the run/finalize endpoints set.
    if (!orderDate) {
      setMessage("Order date is required.");
      setLoading(false);
      return;
    }
    const cycleData = {
      order_date: orderDate,
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
    setOrderDate("");
    setSelectedStoreIds([]);
    await reloadCycles();
  };

  const handleEdit = (cycle: OrderCycle) => {
    setEditingCycle(cycle);
    setOrderDate(cycle.order_date ?? "");
    setSelectedStoreIds(cycle.cycle_stores?.map((cs) => cs.stores.id) || []);
    setShowForm(true);
  };

  const handleDelete = async (cycle: OrderCycle) => {
    if (cycle.status !== "draft") {
      setMessage("Only draft cycles can be deleted.");
      return;
    }
    if (!confirm(`Delete cycle "${formatCycleName(cycle)}"? This cannot be undone.`)) return;
    const { error } = await supabase.from("order_cycles").delete().eq("id", cycle.id);
    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage("Cycle deleted.");
    if (selectedCycleId === cycle.id) setSelectedCycleId(null);
    setCycles(cycles.filter((c) => c.id !== cycle.id));
  };

  const openManagePanel = (cycle: OrderCycle) => {
    setSelectedCycleId(cycle.id);
    setActiveTab("details");
    handleEdit(cycle);
  };

  // Auto-open the cycle requested via ?cycle=<id> (e.g. from the archive
  // page). Fires once after cycles load; subsequent reloads of the cycle
  // list don't re-trigger.
  const searchParams = useSearchParams();
  const cycleParam = searchParams.get("cycle");
  const [paramHandled, setParamHandled] = useState(false);
  useEffect(() => {
    if (paramHandled || !cycleParam || cycles.length === 0) return;
    const target = cycles.find((c) => c.id === cycleParam);
    if (target) {
      openManagePanel(target);
      setParamHandled(true);
    }
  }, [cycleParam, cycles, paramHandled]);

  const columnDefs: ColDef<OrderCycle>[] = [
    {
      headerName: "Cycle",
      field: "order_date",
      sortable: true,
      filter: true,
      flex: 2,
      minWidth: 150,
      valueFormatter: (p) =>
        p.value ? new Date(p.value).toLocaleDateString() : "(no date)",
    },
    {
      headerName: "Status",
      field: "status",
      sortable: true,
      filter: true,
      width: 110,
      valueFormatter: (p) =>
        p.value ? p.value.charAt(0).toUpperCase() + p.value.slice(1) : "",
    },
    {
      headerName: "Stores",
      valueGetter: (params) =>
        params.data?.cycle_stores?.map((cs) => cs.stores.name).join(", ") || "",
      sortable: false,
      filter: false,
      flex: 2,
      minWidth: 150,
    },
    {
      headerName: "Actions",
      width: 180,
      cellRenderer: (params: ICellRendererParams<OrderCycle>) => (
        <div className="flex h-full items-center justify-center gap-2">
          <button
            onClick={() => openManagePanel(params.data!)}
            className="px-2 py-1 text-xs bg-cyan-500 text-slate-950 rounded font-semibold"
          >
            {params.data!.status === "delivered" ? "Review" : "Manage"}
          </button>
          {params.data!.status !== "delivered" && (
            <button
              onClick={() => handleDelete(params.data!)}
              className="px-2 py-1 text-xs bg-red-500 text-white rounded"
              disabled={params.data!.status !== "draft"}
            >
              Delete
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

          <div style={{ height: 360 }}>
            <AgGridReact
              rowData={cycles}
              columnDefs={columnDefs}
              defaultColDef={{ resizable: true, sortable: true, filter: true, minWidth: 80 }}
            />
          </div>

          {showForm && !selectedCycleId && (
            <CycleEditForm
              editing={editingCycle}
              orderDate={orderDate}
              selectedStoreIds={selectedStoreIds}
              stores={stores}
              loading={loading}
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
                  {selectedCycle.status === "delivered" ? "Review" : "Manage"}: {formatCycleName(selectedCycle)}{" "}
                  <span className="text-sm font-normal text-slate-400">
                    ({selectedCycle.status.charAt(0).toUpperCase() + selectedCycle.status.slice(1)})
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
                  orderDate={orderDate}
                  selectedStoreIds={selectedStoreIds}
                  stores={stores}
                  loading={loading}
                  readOnly={selectedCycle.status === "delivered"}
                  setOrderDate={setOrderDate}
                  setSelectedStoreIds={setSelectedStoreIds}
                  onSubmit={handleSubmit}
                  onCancel={() => setSelectedCycleId(null)}
                />
              )}
              {activeTab === "stockEntries" && <StockEntriesTab cycleId={selectedCycle.id} />}
              {activeTab === "factoryCounts" && <FactoryCountsTab cycleId={selectedCycle.id} />}
              {activeTab === "allocations" && (
                <AllocationsTab
                  cycleId={selectedCycle.id}
                  cycleStatus={selectedCycle.status}
                  cycleOrderDate={selectedCycle.order_date}
                  onFinalized={reloadCycles}
                />
              )}
              {activeTab === "overrides" && (
                <OverridesTab
                  cycleId={selectedCycle.id}
                  readOnly={selectedCycle.status === "delivered"}
                />
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function CycleEditForm(props: {
  editing: OrderCycle | null;
  orderDate: string;
  selectedStoreIds: string[];
  stores: Store[];
  loading: boolean;
  readOnly?: boolean;
  setOrderDate: (v: string) => void;
  setSelectedStoreIds: (v: string[]) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const ro = !!props.readOnly;
  return (
    <form onSubmit={props.onSubmit} className="rounded-2xl bg-slate-950/60 p-6 space-y-4">
      <h3 className="text-lg font-semibold text-white">
        {ro
          ? "Cycle details (read-only)"
          : props.editing
            ? "Edit Cycle"
            : "Create New Cycle"}
      </h3>

      <div>
        <label className="block text-sm font-medium text-slate-300">Order date</label>
        <input
          type="date"
          value={props.orderDate}
          onChange={(e) => props.setOrderDate(e.target.value)}
          onKeyDown={(e) => e.preventDefault()}
          disabled={ro}
          className="mt-1 rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="block text-sm font-medium text-slate-300">
            Participating stores (cycle_stores)
          </label>
          {!ro && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() =>
                  props.setSelectedStoreIds(props.stores.map((s) => s.id))
                }
                className="px-2 py-1 text-xs bg-emerald-500 text-slate-950 rounded font-semibold"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => props.setSelectedStoreIds([])}
                className="px-2 py-1 text-xs border border-white/10 text-slate-300 rounded"
              >
                Clear
              </button>
            </div>
          )}
        </div>
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
                disabled={ro}
                className="mr-2 disabled:cursor-not-allowed"
              />
              <span className="text-sm text-slate-300">
                {store.name} {store.is_high_volume ? "(HV)" : ""}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        {!ro && (
          <button
            type="submit"
            disabled={props.loading}
            className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
          >
            {props.loading ? "Saving..." : props.editing ? "Update" : "Create"}
          </button>
        )}
        <button type="button" onClick={props.onCancel} className="px-4 py-2 bg-slate-600 text-white rounded-full">
          {ro ? "Close" : "Cancel"}
        </button>
      </div>
    </form>
  );
}

type StockEntryRow = {
  store_name: string;
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
          "current_count,entered_at,entered_by,stores(name),items(name)",
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
            items: { name: string } | null;
          }>).map((e) => ({
            store_name: e.stores?.name ?? "",
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
    { headerName: "Store", field: "store_name", sortable: true, filter: true, width: 150 },
    { headerName: "Item", field: "item_name", sortable: true, filter: true, flex: 2, minWidth: 150 },
    { headerName: "Count", field: "current_count", sortable: true, filter: true, width: 100 },
    {
      headerName: "Entered",
      field: "entered_at",
      sortable: true,
      filter: true,
      width: 160,
      valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString() : ""),
    },
    { headerName: "By", field: "entered_by", sortable: true, filter: true, flex: 1, minWidth: 130 },
  ];

  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-400">
        Read-only view of what stores have entered for this cycle.
      </p>
      <div style={{ height: 480 }}>
        <AgGridReact
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: true, filter: true, minWidth: 80 }}
        />
      </div>
    </div>
  );
}

type FactoryCountRow = {
  factory_name: string;
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
          "available_qty,counted_at,counted_by,factories(name),items(name)",
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
            items: { name: string } | null;
          }>).map((e) => ({
            factory_name: e.factories?.name ?? "",
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
    { headerName: "Factory", field: "factory_name", sortable: true, filter: true, width: 150 },
    { headerName: "Item", field: "item_name", sortable: true, filter: true, flex: 2, minWidth: 150 },
    { headerName: "Available", field: "available_qty", sortable: true, filter: true, width: 110 },
    {
      headerName: "Counted",
      field: "counted_at",
      sortable: true,
      filter: true,
      width: 160,
      valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString() : ""),
    },
    { headerName: "By", field: "counted_by", sortable: true, filter: true, flex: 1, minWidth: 130 },
  ];

  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-400">
        Read-only view of what factories have reported for this cycle.
      </p>
      <div style={{ height: 480 }}>
        <AgGridReact
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: true, filter: true, minWidth: 80 }}
        />
      </div>
    </div>
  );
}

type AllocationRow = {
  store_name: string;
  item_name: string;
  sub_category: string | null;
  qty: number;
  source: string;
  factory_name: string;
  shortfall: number;
};

function AllocationsTab({
  cycleId,
  cycleStatus,
  cycleOrderDate,
  onFinalized,
}: {
  cycleId: string;
  cycleStatus: string;
  cycleOrderDate: string | null;
  onFinalized: () => Promise<void> | void;
}) {
  const [rows, setRows] = useState<AllocationRow[]>([]);
  const [running, setRunning] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isDelivered = cycleStatus === "delivered";
  const isAllocated = cycleStatus === "allocated";
  const hasOrderDate = !!cycleOrderDate;

  const reload = async () => {
    const { data } = await supabase
      .from("allocations")
      .select(
        "qty,source,shortfall,stores(name),items(name,sub_category),factories!allocations_factory_id_fkey(name)",
      )
      .eq("cycle_id", cycleId);
    if (data) {
      setRows(
        (data as unknown as Array<{
          qty: number;
          source: string;
          shortfall: number;
          stores: { name: string } | null;
          items: { name: string; sub_category: string | null } | null;
          factories: { name: string } | null;
        }>).map((a) => ({
          store_name: a.stores?.name ?? "",
          item_name: a.items?.name ?? "",
          sub_category: a.items?.sub_category ?? null,
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
        // Run also flips status to 'allocated' on the server. Tell the
        // parent to refetch so its cycle list reflects the new status.
        await onFinalized();
      }
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally {
      setRunning(false);
    }
  };

  const finalizeCycle = async () => {
    if (
      !confirm(
        "Mark this cycle as delivered? This will subtract the allocated qty from each factory_counts row and set the cycle's status to 'delivered'. The status gate prevents this from running twice, but the decrement itself is not undoable.",
      )
    ) {
      return;
    }
    setFinalizing(true);
    setMessage(null);
    try {
      const response = await fetch("/api/allocations/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cycle_id: cycleId }),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(`Error: ${data.error}`);
      } else {
        setMessage(`✅ ${data.message}`);
        await onFinalized();
      }
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally {
      setFinalizing(false);
    }
  };

  const columnDefs: ColDef<AllocationRow>[] = [
    {
      headerName: "Store",
      field: "store_name",
      sortable: true,
      filter: true,
      width: 150,
      sort: "asc",
      sortIndex: 0,
    },
    {
      headerName: "Source",
      field: "source",
      sortable: true,
      filter: true,
      width: 120,
      sort: "asc",
      sortIndex: 1,
      valueFormatter: (p) => {
        const v = (p.value as string | undefined) ?? "";
        if (!v) return "";
        const spaced = v.replace(/_/g, " ");
        return spaced.charAt(0).toUpperCase() + spaced.slice(1);
      },
    },
    {
      headerName: "Category",
      field: "sub_category",
      sortable: true,
      filter: true,
      width: 140,
      sort: "asc",
      sortIndex: 2,
    },
    { headerName: "Item", field: "item_name", sortable: true, filter: true, flex: 2, minWidth: 150 },
    { headerName: "Qty", field: "qty", sortable: true, filter: true, width: 90 },
    { headerName: "Factory", field: "factory_name", sortable: true, filter: true, width: 150 },
    {
      headerName: "Shortfall",
      field: "shortfall",
      sortable: true,
      filter: true,
      width: 115,
      cellStyle: (p) => ({ color: (p.value ?? 0) > 0 ? "#ef4444" : "#10b981" }),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-slate-400">
          Run the allocation algorithm for this cycle. Each run wipes prior
          allocations + POs and recomputes. Once the order is delivered,
          mark it to subtract the allocated qty from factory stock.
        </p>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={runAllocations}
            disabled={running || isDelivered}
            className="px-4 py-2 bg-emerald-500 text-slate-950 rounded-full font-semibold disabled:opacity-50"
            title={isDelivered ? "Cycle is delivered — re-running allocations would invalidate the delivery decrement" : undefined}
          >
            {running ? "Running..." : "Run allocations"}
          </button>
          <button
            onClick={finalizeCycle}
            disabled={finalizing || isDelivered || !isAllocated || !hasOrderDate}
            className="px-4 py-2 bg-amber-500 text-slate-950 rounded-full font-semibold disabled:opacity-50"
            title={
              isDelivered
                ? "Already delivered"
                : !isAllocated
                  ? "Run allocations first — Mark delivered is only available once the cycle is in 'allocated' status"
                  : !hasOrderDate
                    ? "Set the cycle's order date on the Details tab before marking delivered"
                    : undefined
            }
          >
            {finalizing
              ? "Marking..."
              : isDelivered
                ? "Delivered ✓"
                : "Mark delivered"}
          </button>
        </div>
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
      <div style={{ height: 440 }}>
        <AgGridReact
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: true, filter: true, minWidth: 80 }}
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
  item_name: string;
};

function OverridesTab({
  cycleId,
  readOnly = false,
}: {
  cycleId: string;
  readOnly?: boolean;
}) {
  const [overrides, setOverrides] = useState<
    Array<{ cycle_id: string; store_id: string; item_id: string; qty: number; reason: string | null; set_by: string | null }>
  >([]);
  const [stores, setStores] = useState<Array<{ id: string; name: string }>>([]);
  const [items, setItems] = useState<Array<{ id: string; name: string }>>([]);
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
      supabase.from("items").select("id,name").order("name"),
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
    { headerName: "Store", field: "store_name", sortable: true, filter: true, width: 150 },
    { headerName: "Item", field: "item_name", sortable: true, filter: true, flex: 2, minWidth: 150 },
    { headerName: "Qty", field: "qty", sortable: true, filter: true, width: 90 },
    { headerName: "Reason", field: "reason", sortable: true, filter: true, flex: 1, minWidth: 120 },
    { headerName: "Set by", field: "set_by", sortable: true, filter: true, flex: 1, minWidth: 130 },
    ...(readOnly
      ? []
      : [
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
          } as ColDef<OverrideRow>,
        ]),
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">
          {readOnly
            ? "Read-only — overrides for this delivered cycle are locked."
            : "Force a specific qty for (store, item). Allocation pulls from factories using the override qty; on the next run the override appears as source=manual_override."}
        </p>
        {!readOnly && (
          <button
            onClick={() => {
              resetForm();
              setShowForm(true);
            }}
            className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
          >
            Add override
          </button>
        )}
      </div>

      {showForm && !readOnly && (
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
                  <option key={i.id} value={i.id}>{i.name}</option>
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

      <div style={{ height: 380 }}>
        <AgGridReact
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: true, filter: true, minWidth: 80 }}
        />
      </div>
    </div>
  );
}
