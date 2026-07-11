"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { formatLocalDate, parseLocalDate } from "@/lib/dateOnly";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import { AgGridReact } from "@/lib/agGrid";
import type {
  CellClassParams,
  CellValueChangedEvent,
  ColDef,
  GridApi,
  GridReadyEvent,
  ICellRendererParams,
  IRowNode,
  ValueFormatterParams,
} from "ag-grid-community";

type OrderCycle = {
  id: string;
  status: string;
  order_date: string;
  created_by: string | null;
  created_at: string;
  cycle_stores?: { stores: { id: string; name: string } }[];
};

const formatCycleName = (cycle: { order_date: string } | null | undefined) =>
  formatLocalDate(cycle?.order_date, "(no date)");

type Store = {
  id: string;
  name: string;
  tier: number;
};

type TabKey = "details" | "stock" | "deliveries";

export default function AdminCycles() {
  const { session, profile, loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
  const isFactoryWorker = profile?.role === "factory_worker";
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

  // Factory workers get full cycle access alongside store managers — they need
  // to see and manage what's being delivered.
  const canManage = isStoreManager || isFactoryWorker;

  // Drop stale responses — deleting a cycle fires both order_cycles AND
  // cycle_stores realtime events (cascade delete), so two reloadCycles
  // run in parallel; without a guard a slower one can land last with
  // stale data and the cycle "comes back" in the UI.
  const reloadCyclesTokenRef = useRef(0);
  const reloadCycles = useCallback(async () => {
    const myToken = ++reloadCyclesTokenRef.current;
    const { data } = await supabase
      .from("order_cycles")
      .select("*, cycle_stores(stores(id, name))")
      .order("created_at", { ascending: false });
    if (myToken !== reloadCyclesTokenRef.current) return;
    if (!data) return;
    // Active cycles (draft / allocated) first, delivered (archived) last.
    const sorted = [...(data as OrderCycle[])].sort((a, b) => {
      const aDelivered = a.status === "delivered" ? 1 : 0;
      const bDelivered = b.status === "delivered" ? 1 : 0;
      if (aDelivered !== bDelivered) return aDelivered - bDelivered;
      return 0; // preserve created_at desc within each group
    });
    setCycles(sorted);
  }, []);

  useRealtimeRefetch(
    canManage ? [{ table: "order_cycles" }, { table: "cycle_stores" }] : [],
    reloadCycles,
    "admin-cycles-list",
  );

  useEffect(() => {
    if (!canManage) {
      setCycles([]);
      setStores([]);
      return;
    }
    const loadAll = async () => {
      const [storesRes] = await Promise.all([
        supabase.from("stores").select("id, name, tier").order("name"),
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

  // Stores that are already in some OTHER non-delivered cycle. Mapped to
  // the conflicting cycle so the form can show a "(in Y/M/D cycle)"
  // hint. We exclude the cycle currently being edited so a store stays
  // selectable inside its own cycle.
  const storesInOtherOpenCycles = useMemo(() => {
    const map = new Map<string, OrderCycle>();
    for (const c of cycles) {
      if (c.status === "delivered") continue;
      if (editingCycle && c.id === editingCycle.id) continue;
      for (const cs of c.cycle_stores ?? []) {
        map.set(cs.stores.id, c);
      }
    }
    return map;
  }, [cycles, editingCycle]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage) return;
    setLoading(true);
    setMessage(null);

    try {
      // Status is machine-driven (draft → allocated → delivered) so we never
      // include it in the upsert. Inserts let the DB default to 'draft';
      // updates leave whatever the run/finalize endpoints set.
      if (!orderDate) {
        setMessage("Order date is required.");
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
          return;
        }
        cycleId = data.id;
      }

      // Diff-based cycle_stores update so a failed INSERT (e.g. validation
      // trigger rejecting an already-in-another-cycle store) doesn't leave
      // the cycle with zero stores. INSERT runs first; only on success do
      // we DELETE the now-removed ones.
      if (editingCycle) {
        const existingStoreIds = new Set(
          editingCycle.cycle_stores?.map((cs) => cs.stores.id) ?? [],
        );
        const selectedSet = new Set(selectedStoreIds);
        const toAdd = selectedStoreIds.filter((id) => !existingStoreIds.has(id));
        const toRemove = [...existingStoreIds].filter(
          (id) => !selectedSet.has(id),
        );
        if (toAdd.length > 0) {
          const { error } = await supabase.from("cycle_stores").insert(
            toAdd.map((id) => ({ cycle_id: cycleId, store_id: id })),
          );
          if (error) {
            setMessage(error.message);
            return;
          }
        }
        if (toRemove.length > 0) {
          const { error } = await supabase
            .from("cycle_stores")
            .delete()
            .eq("cycle_id", cycleId)
            .in("store_id", toRemove);
          if (error) {
            setMessage(error.message);
            return;
          }
        }
      } else if (selectedStoreIds.length > 0) {
        const { error } = await supabase.from("cycle_stores").insert(
          selectedStoreIds.map((id) => ({ cycle_id: cycleId, store_id: id })),
        );
        if (error) {
          setMessage(error.message);
          return;
        }
      }

      setMessage(editingCycle ? "Cycle updated." : "Cycle created.");
      setShowForm(false);
      setEditingCycle(null);
      setOrderDate("");
      setSelectedStoreIds([]);
      await reloadCycles();
    } catch (err) {
      setMessage(
        `Couldn't save cycle: ${
          err instanceof Error ? err.message : "network timeout"
        }. Try again.`,
      );
    } finally {
      setLoading(false);
    }
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
    try {
      const { error } = await supabase.from("order_cycles").delete().eq("id", cycle.id);
      if (error) {
        setMessage(error.message);
        return;
      }
      setMessage("Cycle deleted.");
      if (selectedCycleId === cycle.id) setSelectedCycleId(null);
      setCycles(cycles.filter((c) => c.id !== cycle.id));
    } catch (err) {
      setMessage(
        `Couldn't delete cycle: ${
          err instanceof Error ? err.message : "network timeout"
        }. Try again.`,
      );
    }
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
      valueFormatter: (p) => formatLocalDate(p.value as string | null, "(no date)"),
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
        Create and manage weekly order cycles. Each cycle tracks store counts,
        factory stock, and what gets delivered.
      </p>

      {authLoading ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Loading…</p>
        </div>
      ) : !isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in to access this page.</p>
        </div>
      ) : !canManage ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to Store Managers and Factory Workers.</p>
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
              storesInOtherOpenCycles={storesInOtherOpenCycles}
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
                {(["details", "stock", "deliveries"] as TabKey[]).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-4 py-2 text-sm font-medium transition border-b-2 ${
                      activeTab === tab
                        ? "border-cyan-400 text-cyan-300"
                        : "border-transparent text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {tab === "details" ? "Details" : tab === "stock" ? "Stock" : "Delivery"}
                  </button>
                ))}
              </div>

              {activeTab === "details" && (
                <CycleEditForm
                  editing={editingCycle}
                  orderDate={orderDate}
                  selectedStoreIds={selectedStoreIds}
                  stores={stores}
                  storesInOtherOpenCycles={storesInOtherOpenCycles}
                  loading={loading}
                  readOnly={selectedCycle.status === "delivered" || selectedCycle.status === "finalized"}
                  setOrderDate={setOrderDate}
                  setSelectedStoreIds={setSelectedStoreIds}
                  onSubmit={handleSubmit}
                  onCancel={() => setSelectedCycleId(null)}
                />
              )}
              {activeTab === "stock" && (
                <CountsTab
                  cycleId={selectedCycle.id}
                  cycleStatus={selectedCycle.status}
                />
              )}
              {activeTab === "deliveries" && (
                <DeliveriesTab
                  cycleId={selectedCycle.id}
                  cycleStatus={selectedCycle.status}
                  cycleOrderDate={selectedCycle.order_date}
                  onFinalized={reloadCycles}
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
  storesInOtherOpenCycles: Map<string, OrderCycle>;
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
        <label className="block text-sm font-medium text-slate-300">Order Date</label>
        <input
          type="date"
          value={props.orderDate}
          onChange={(e) => props.setOrderDate(e.target.value)}
          onKeyDown={(e) => e.preventDefault()}
          onClick={(e) => {
            const el = e.currentTarget as HTMLInputElement & {
              showPicker?: () => void;
            };
            el.showPicker?.();
          }}
          disabled={ro}
          style={{ colorScheme: "dark" }}
          className="mt-1 rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="block text-sm font-medium text-slate-300">
            Participating Stores
          </label>
          {!ro && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() =>
                  props.setSelectedStoreIds(
                    props.stores
                      .filter((s) => !props.storesInOtherOpenCycles.has(s.id))
                      .map((s) => s.id),
                  )
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
          {props.stores.map((store) => {
            const conflict = props.storesInOtherOpenCycles.get(store.id);
            const isConflict = !!conflict;
            const conflictDate = formatLocalDate(conflict?.order_date) || null;
            return (
              <label
                key={store.id}
                className={`flex items-center ${isConflict ? "opacity-70" : ""}`}
                title={
                  isConflict
                    ? `${store.name} is already in the open cycle on ${conflictDate}. Finish or remove them from that cycle first.`
                    : undefined
                }
              >
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
                  disabled={ro || isConflict}
                  className="mr-2 disabled:cursor-not-allowed"
                />
                <span className="text-sm text-slate-300">
                  {store.name}{" "}
                  <span className="text-xs text-slate-500">(Tier {store.tier})</span>
                  {isConflict && (
                    <span className="ml-2 inline-flex items-center rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-300">
                      in {conflictDate}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
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
  source: string;
  sub_category: string | null;
  current_count: number;
  entered_at: string;
};

// Stock tab: dropdown switches between the live Preview (per-item
// demand vs factory available, the "where's it tight this week" view),
// the raw per-store Stock Entries, and the raw per-factory Factory
// Counts. Each underlying component is independent — this just bundles
// them under one tab. Preview defaults to selected while the cycle is
// still open, since that's the most useful mid-week view; on delivered
// cycles we default to Store Counts since the preview isn't actionable.
function CountsTab({
  cycleId,
  cycleStatus,
}: {
  cycleId: string;
  cycleStatus: string;
}) {
  type View = "preview" | "stock" | "factory";
  const [view, setView] = useState<View>(
    cycleStatus === "delivered" ? "stock" : "preview",
  );
  // On the Preview view, optionally break demand out per store.
  const [byStore, setByStore] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <label htmlFor="stock-view" className="text-sm font-medium text-slate-300">
          Show:
        </label>
        <select
          id="stock-view"
          value={view}
          onChange={(e) => setView(e.target.value as View)}
          className="rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400"
        >
          <option value="preview">Preview</option>
          <option value="stock">Store Counts</option>
          <option value="factory">Factory Counts</option>
        </select>
        {view === "preview" && (
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={byStore}
              onChange={(e) => setByStore(e.target.checked)}
              className="h-4 w-4 rounded border-slate-600 bg-slate-800"
            />
            Break down by store
          </label>
        )}
      </div>
      {view === "preview" ? (
        byStore ? (
          <PreviewByStoreTab cycleId={cycleId} />
        ) : (
          <PreviewTab cycleId={cycleId} />
        )
      ) : view === "stock" ? (
        <StockEntriesTab cycleId={cycleId} />
      ) : (
        <FactoryCountsTab cycleId={cycleId} />
      )}
    </div>
  );
}

function StockEntriesTab({ cycleId }: { cycleId: string }) {
  const [rows, setRows] = useState<StockEntryRow[]>([]);
  // Drop stale responses so racing realtime events can't clobber state.
  const loadTokenRef = useRef(0);
  const load = useCallback(async () => {
    const myToken = ++loadTokenRef.current;
    const { data, error } = await supabase
      .from("stock_entries")
      .select(
        "current_count,entered_at,stores(name),items(name,type,sub_category)",
      )
      .eq("cycle_id", cycleId)
      .order("entered_at", { ascending: false });
    if (myToken !== loadTokenRef.current) return;
    if (error) {
      // eslint-disable-next-line no-console
      console.error("StockEntriesTab load failed:", error);
    }
    if (data) {
      setRows(
        (data as unknown as Array<{
          current_count: number;
          entered_at: string;
          stores: { name: string } | null;
          items: { name: string; type: string; sub_category: string | null } | null;
        }>)
          .map((e) => {
            const itemType = e.items?.type ?? "";
            const source =
              itemType === "manufactured" ? "factory"
                : itemType === "purchased" ? "purchase"
                  : itemType;
            return {
              store_name: e.stores?.name ?? "",
              item_name: e.items?.name ?? "",
              source,
              sub_category: e.items?.sub_category ?? null,
              current_count: e.current_count,
              entered_at: e.entered_at,
            };
          })
          .sort((a, b) =>
            a.store_name.localeCompare(b.store_name) ||
            a.source.localeCompare(b.source) ||
            (a.sub_category ?? "").localeCompare(b.sub_category ?? ""),
          ),
      );
    }
  }, [cycleId]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtimeRefetch(
    [{ table: "stock_entries", filter: `cycle_id=eq.${cycleId}` }],
    load,
    `cycle-${cycleId}-stock-entries`,
  );

  const columnDefs: ColDef<StockEntryRow>[] = [
    {
      headerName: "Store",
      field: "store_name",
      sortable: true,
      filter: true,
      width: 150,
    },
    {
      headerName: "Source",
      field: "source",
      sortable: true,
      filter: true,
      width: 130,
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
    },
    { headerName: "Item", field: "item_name", sortable: true, filter: true, flex: 2, minWidth: 150 },
    { headerName: "Count", field: "current_count", sortable: true, filter: true, width: 100 },
    {
      headerName: "Entered",
      field: "entered_at",
      sortable: true,
      filter: true,
      flex: 1,
      minWidth: 160,
      valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString() : ""),
    },
  ];

  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-400">
        What each store has on hand.
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
  sub_category: string | null;
  available_qty: number;
  counted_at: string;
};

function FactoryCountsTab({ cycleId }: { cycleId: string }) {
  const [rows, setRows] = useState<FactoryCountRow[]>([]);
  // Drop stale responses so racing realtime events can't clobber state.
  const loadTokenRef = useRef(0);
  const load = useCallback(async () => {
    const myToken = ++loadTokenRef.current;
    const { data, error } = await supabase
      .from("factory_counts")
      .select(
        "available_qty,counted_at,factories(name),items(name,sub_category)",
      )
      .eq("cycle_id", cycleId)
      .order("counted_at", { ascending: false });
    if (myToken !== loadTokenRef.current) return;
    if (error) {
      // eslint-disable-next-line no-console
      console.error("FactoryCountsTab load failed:", error);
    }
    if (data) {
      setRows(
        (data as unknown as Array<{
          available_qty: number;
          counted_at: string;
          factories: { name: string } | null;
          items: { name: string; sub_category: string | null } | null;
        }>)
          .map((e) => ({
            factory_name: e.factories?.name ?? "",
            item_name: e.items?.name ?? "",
            sub_category: e.items?.sub_category ?? null,
            available_qty: e.available_qty,
            counted_at: e.counted_at,
          }))
          .sort((a, b) =>
            a.factory_name.localeCompare(b.factory_name) ||
            (a.sub_category ?? "").localeCompare(b.sub_category ?? ""),
          ),
      );
    }
  }, [cycleId]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtimeRefetch(
    [{ table: "factory_counts", filter: `cycle_id=eq.${cycleId}` }],
    load,
    `cycle-${cycleId}-factory-counts`,
  );

  const columnDefs: ColDef<FactoryCountRow>[] = [
    {
      headerName: "Factory",
      field: "factory_name",
      sortable: true,
      filter: true,
      width: 150,
    },
    {
      headerName: "Category",
      field: "sub_category",
      sortable: true,
      filter: true,
      width: 140,
    },
    { headerName: "Item", field: "item_name", sortable: true, filter: true, flex: 2, minWidth: 150 },
    { headerName: "Available", field: "available_qty", sortable: true, filter: true, width: 110 },
    {
      headerName: "Counted",
      field: "counted_at",
      sortable: true,
      filter: true,
      flex: 1,
      minWidth: 160,
      valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString() : ""),
    },
  ];

  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-400">
        What each factory has available.
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

// ─── Preview tab ─────────────────────────────────────────────────────────────
// Live, item-level summary of the open cycle. Aggregates demand
// (capacity - current_count, clamped at 0) across all participating
// stores, compares it to total factory_counts.available_qty for the
// item, and surfaces the projected shortfall. Refreshes via realtime so
// admin can spot tight items as box traces decrement counts during the
// week. Read-only — running allocations is still done from the
// Allocations tab.
//
// Shows every item with positive demand across the cycle's stores, regardless
// of category. Box-traced items (Empanada/Dessert) update live as boxes are
// logged during the week; other items we stock (drinks, supplies, untraced
// factory items) are static once counted, but their demand — and any factory
// shortfall — is still worth surfacing here.
type PreviewRow = {
  item_id: string;
  item_name: string;
  type: string;
  sub_category: string | null;
  total_demand: number;
  factory_available: number;
  projected_shortfall: number;
  // True if any (store, item) pair contributing to this item's demand
  // has a hard override active — the shortfall is being forced past
  // factory stock for that allocation, not just running short naturally.
  has_hard_override: boolean;
};

function PreviewTab({ cycleId }: { cycleId: string }) {
  const [rows, setRows] = useState<PreviewRow[]>([]);
  // Categories to include in the PDF export. null = all (the default); once
  // the admin unticks one it becomes an explicit set.
  const [exportCats, setExportCats] = useState<Set<string> | null>(null);
  const [exporting, setExporting] = useState(false);
  const [cycleDate, setCycleDate] = useState<string | null>(null);
  // Drop stale responses so racing realtime events can't clobber state.
  const loadTokenRef = useRef(0);

  // Cycle's order date, for the PDF title/filename. Cheap standalone fetch so
  // it doesn't tangle with the demand load's strict all-or-nothing guard.
  useEffect(() => {
    let active = true;
    supabase
      .from("order_cycles")
      .select("order_date")
      .eq("id", cycleId)
      .maybeSingle()
      .then(({ data }) => {
        if (active) setCycleDate((data as { order_date: string | null } | null)?.order_date ?? null);
      });
    return () => {
      active = false;
    };
  }, [cycleId]);

  const load = useCallback(async () => {
    const myToken = ++loadTokenRef.current;
    const [
      cycleStoresRes,
      stockEntriesRes,
      storeItemsRes,
      factoryCountsRes,
      itemsRes,
      overridesRes,
    ] = await Promise.all([
      supabase.from("cycle_stores").select("store_id").eq("cycle_id", cycleId),
      supabase
        .from("stock_entries")
        .select("store_id,item_id,current_count")
        .eq("cycle_id", cycleId),
      supabase
        .from("store_items")
        .select("store_id,item_id,capacity")
        .eq("is_active", true),
      supabase
        .from("factory_counts")
        .select("item_id,available_qty")
        .eq("cycle_id", cycleId),
      supabase.from("items").select("id,name,type,sub_category,track_factory_stock"),
      supabase
        .from("allocation_overrides")
        .select("store_id,item_id,qty,mode")
        .eq("cycle_id", cycleId),
    ]);

    if (myToken !== loadTokenRef.current) return; // stale, ignore

    if (
      !cycleStoresRes.data ||
      !stockEntriesRes.data ||
      !storeItemsRes.data ||
      !factoryCountsRes.data ||
      !itemsRes.data ||
      !overridesRes.data
    ) {
      return;
    }

    const allowedStoreIds = new Set(
      cycleStoresRes.data.map((c: { store_id: string }) => c.store_id),
    );

    // Capacity per (store, item) for the participating stores only.
    const capByKey = new Map<string, number>();
    for (const si of storeItemsRes.data as Array<{
      store_id: string;
      item_id: string;
      capacity: number;
    }>) {
      if (!allowedStoreIds.has(si.store_id)) continue;
      capByKey.set(`${si.store_id}|${si.item_id}`, si.capacity);
    }

    // current_count per (store, item) — defaults to 0 when no entry yet.
    const onHandByKey = new Map<string, number>();
    for (const se of stockEntriesRes.data as Array<{
      store_id: string;
      item_id: string;
      current_count: number;
    }>) {
      onHandByKey.set(`${se.store_id}|${se.item_id}`, se.current_count);
    }

    // Overrides replace the natural (capacity - on_hand) demand for the
    // (store, item) they target. Hard overrides also force the qty past
    // available factory stock — flag the item so the shortfall renderer
    // can show the alarming visual.
    const overrideByKey = new Map<
      string,
      { qty: number; mode: "soft" | "hard" }
    >();
    for (const o of overridesRes.data as Array<{
      store_id: string;
      item_id: string;
      qty: number;
      mode: "soft" | "hard";
    }>) {
      if (!allowedStoreIds.has(o.store_id)) continue;
      overrideByKey.set(`${o.store_id}|${o.item_id}`, {
        qty: o.qty,
        mode: o.mode,
      });
    }

    // Sum demand per item across all participating stores. Override.qty
    // wins over natural demand for that (store, item) pair.
    const demandByItem = new Map<string, number>();
    const hardOverrideItems = new Set<string>();
    for (const [key, capacity] of capByKey.entries()) {
      const [, itemId] = key.split("|");
      const override = overrideByKey.get(key);
      let demand: number;
      if (override) {
        demand = override.qty;
        if (override.mode === "hard") hardOverrideItems.add(itemId);
      } else {
        const onHand = onHandByKey.get(key) ?? 0;
        demand = Math.max(0, capacity - onHand);
      }
      demandByItem.set(itemId, (demandByItem.get(itemId) ?? 0) + demand);
    }

    // Surface overrides for (store, item) pairs that aren't in store_items
    // (e.g. an item the admin force-overrode for a store that doesn't have
    // it active). Without this they'd be invisible to the preview.
    for (const [key, override] of overrideByKey.entries()) {
      if (capByKey.has(key)) continue;
      const [, itemId] = key.split("|");
      demandByItem.set(itemId, (demandByItem.get(itemId) ?? 0) + override.qty);
      if (override.mode === "hard") hardOverrideItems.add(itemId);
    }

    // Sum factory_counts.available_qty per item across all factories.
    const factoryByItem = new Map<string, number>();
    for (const fc of factoryCountsRes.data as Array<{
      item_id: string;
      available_qty: number;
    }>) {
      factoryByItem.set(
        fc.item_id,
        (factoryByItem.get(fc.item_id) ?? 0) + fc.available_qty,
      );
    }

    const itemsById = new Map(
      (
        itemsRes.data as Array<{
          id: string;
          name: string;
          type: string;
          sub_category: string | null;
          track_factory_stock: boolean;
        }>
      ).map((i) => [i.id, i]),
    );

    const previewRows: PreviewRow[] = [];
    for (const [itemId, totalDemand] of demandByItem.entries()) {
      if (totalDemand <= 0) continue; // skip items with no demand
      const item = itemsById.get(itemId);
      if (!item) continue;
      // Factory-supplied items (manufactured, or purchased-but-tracked like
      // drinks) get a factory-availability + shortfall. Purchased store-direct
      // items (sauces, cleaning supplies, …) come via supplier POs — unlimited
      // supply, so no factory availability and never "short" — but they're
      // still included so the demand view (and its PDF) is complete.
      const factoryStocked = item.type === "manufactured" || item.track_factory_stock;
      const factoryAvailable = factoryStocked ? (factoryByItem.get(itemId) ?? 0) : 0;
      const shortfall = factoryStocked ? Math.max(0, totalDemand - factoryAvailable) : 0;
      previewRows.push({
        item_id: itemId,
        item_name: item.name,
        type: item.type,
        sub_category: item.sub_category,
        total_demand: totalDemand,
        factory_available: factoryAvailable,
        projected_shortfall: shortfall,
        has_hard_override: hardOverrideItems.has(itemId),
      });
    }

    previewRows.sort((a, b) => {
      // Shortfalls bubble to top, then by sub_category, then name.
      if (a.projected_shortfall !== b.projected_shortfall) {
        return b.projected_shortfall - a.projected_shortfall;
      }
      return (
        (a.sub_category ?? "").localeCompare(b.sub_category ?? "") ||
        a.item_name.localeCompare(b.item_name)
      );
    });

    setRows(previewRows);
  }, [cycleId]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtimeRefetch(
    [
      { table: "stock_entries", filter: `cycle_id=eq.${cycleId}` },
      { table: "factory_counts", filter: `cycle_id=eq.${cycleId}` },
      { table: "cycle_stores", filter: `cycle_id=eq.${cycleId}` },
      { table: "allocation_overrides", filter: `cycle_id=eq.${cycleId}` },
      { table: "store_items" },
    ],
    load,
    `cycle-${cycleId}-preview`,
  );

  const totals = useMemo(() => {
    let demand = 0;
    let shortfall = 0;
    let itemsShort = 0;
    for (const r of rows) {
      demand += r.total_demand;
      if (r.projected_shortfall > 0) {
        shortfall += r.projected_shortfall;
        itemsShort += 1;
      }
    }
    return { demand, shortfall, itemsShort };
  }, [rows]);

  // Distinct categories present in the current preview, for the export picker.
  const categories = useMemo(
    () =>
      Array.from(
        new Set(rows.map((r) => r.sub_category).filter((c): c is string => !!c)),
      ).sort((a, b) => a.localeCompare(b)),
    [rows],
  );

  const isCatPicked = (c: string) => exportCats === null || exportCats.has(c);
  const toggleCat = (c: string) =>
    setExportCats((prev) => {
      const base = prev === null ? new Set(categories) : new Set(prev);
      if (base.has(c)) base.delete(c);
      else base.add(c);
      return base;
    });

  const pickedCategories = exportCats === null ? categories : categories.filter((c) => exportCats.has(c));

  const exportPdf = async () => {
    const picked = new Set(pickedCategories);
    const selected = rows.filter((r) => r.sub_category && picked.has(r.sub_category));
    if (selected.length === 0) return;
    setExporting(true);
    try {
      const [{ jsPDF }, autoTableMod] = await Promise.all([
        import("jspdf"),
        import("jspdf-autotable"),
      ]);
      const autoTable = autoTableMod.default;
      const dateLabel = formatLocalDate(cycleDate, "");
      const doc = new jsPDF();
      doc.setFontSize(15);
      doc.text(`Demand Preview${dateLabel ? ` — ${dateLabel}` : ""}`, 14, 16);
      doc.setFontSize(10);
      doc.setTextColor(110);
      doc.text(`Categories: ${pickedCategories.join(", ")}`, 14, 23);

      const totalDemand = selected.reduce((s, r) => s + r.total_demand, 0);
      const totalShort = selected.reduce((s, r) => s + r.projected_shortfall, 0);

      autoTable(doc, {
        startY: 28,
        head: [["Item", "Category", "Demand", "Factory Avail.", "Shortfall"]],
        body: selected.map((r) => [
          r.item_name,
          r.sub_category ?? "",
          String(r.total_demand),
          r.type === "manufactured" ? String(r.factory_available) : "—",
          r.projected_shortfall > 0 ? String(r.projected_shortfall) : "0",
        ]),
        foot: [["Total", "", String(totalDemand), "", String(totalShort)]],
        styles: { fontSize: 9, cellPadding: 2 },
        headStyles: { fillColor: [15, 23, 42], halign: "right" },
        footStyles: { fillColor: [241, 245, 249], textColor: 20, fontStyle: "bold" },
        // Right-align the numeric columns (Demand, Factory Avail., Shortfall)
        // across head, body and foot; Item and Category stay left-aligned.
        didParseCell: (data) => {
          if (data.column.index < 2) data.cell.styles.halign = "left";
          else data.cell.styles.halign = "right";
        },
      });

      const safe = (pickedCategories.length === categories.length
        ? "all"
        : pickedCategories.join("-")
      )
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-");
      doc.save(`demand-${dateLabel || cycleId.slice(0, 8)}-${safe}.pdf`);
    } finally {
      setExporting(false);
    }
  };

  const columnDefs: ColDef<PreviewRow>[] = [
    {
      headerName: "Item",
      field: "item_name",
      sortable: true,
      filter: true,
      flex: 2,
      minWidth: 160,
    },
    {
      headerName: "Type",
      field: "type",
      sortable: true,
      filter: true,
      width: 110,
      valueFormatter: (p) => {
        const v = (p.value as string | undefined) ?? "";
        return v ? v.charAt(0).toUpperCase() + v.slice(1) : "";
      },
    },
    {
      headerName: "Category",
      field: "sub_category",
      sortable: true,
      filter: true,
      width: 140,
    },
    {
      headerName: "Total Demand",
      field: "total_demand",
      sortable: true,
      filter: true,
      width: 140,
      cellStyle: { textAlign: "right" },
    },
    {
      headerName: "Factory Avail.",
      field: "factory_available",
      sortable: true,
      filter: true,
      width: 145,
      cellStyle: { textAlign: "right" },
      valueFormatter: (p) => {
        const row = (p.data as PreviewRow | undefined) ?? null;
        if (!row) return "";
        return row.type === "purchased" ? "—" : String(p.value ?? 0);
      },
    },
    {
      headerName: "Projected Shortfall",
      field: "projected_shortfall",
      sortable: true,
      filter: true,
      width: 195,
      cellStyle: { textAlign: "right" },
      cellRenderer: (params: ICellRendererParams<PreviewRow>) => {
        const row = params.data;
        if (!row) return null;
        if (row.type === "purchased") {
          return <span className="text-slate-500">PO via supplier</span>;
        }
        if (row.projected_shortfall > 0) {
          // A hard override is forcing the qty past factory stock for at
          // least one (store, item) contributing to this row. Match the
          // Allocations Qty cell's alarming visual: red bold + rose octagon.
          if (row.has_hard_override) {
            return (
              <span
                className="inline-flex items-center justify-end gap-1 font-semibold text-red-400"
                title="A store is set to receive more than the factory has. Bake more before delivery."
              >
                <svg
                  viewBox="0 0 24 24"
                  className="h-3 w-3 text-rose-400"
                  aria-hidden="true"
                >
                  <polygon
                    points="7,2 17,2 22,7 22,17 17,22 7,22 2,17 2,7"
                    fill="currentColor"
                  />
                </svg>
                {row.projected_shortfall}
              </span>
            );
          }
          return (
            <span className="font-semibold text-rose-300">
              {row.projected_shortfall}
            </span>
          );
        }
        return <span className="text-emerald-400">0</span>;
      },
    },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-slate-950/60 p-4 text-sm text-slate-300 flex flex-wrap gap-4">
        <span>
          <strong className="text-white">{rows.length}</strong> items with demand
        </span>
        <span>
          <strong className="text-white">{totals.demand}</strong> total units demanded
        </span>
        <span>
          <strong className={totals.itemsShort > 0 ? "text-rose-300" : "text-emerald-400"}>
            {totals.itemsShort}
          </strong>{" "}
          items short
        </span>
        <span>
          <strong className={totals.shortfall > 0 ? "text-rose-300" : "text-emerald-400"}>
            {totals.shortfall}
          </strong>{" "}
          units short
        </span>
      </div>
      <p className="text-xs text-slate-500">
        Live demand vs available stock. Updates as boxes are logged. Use
        the Allocations tab when you&apos;re ready to finalize the order.
      </p>

      {categories.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-slate-950/40 p-3">
          <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
            Export PDF
          </span>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => toggleCat(c)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                isCatPicked(c)
                  ? "bg-cyan-500/20 text-cyan-200 ring-1 ring-cyan-400/40"
                  : "bg-slate-800 text-slate-500 ring-1 ring-white/10"
              }`}
            >
              {c}
            </button>
          ))}
          <button
            type="button"
            onClick={exportPdf}
            disabled={exporting || pickedCategories.length === 0}
            className="ml-auto rounded-full bg-cyan-500 px-4 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
          >
            {exporting ? "Generating…" : "Export PDF"}
          </button>
        </div>
      )}

      <div style={{ height: 460 }}>
        <AgGridReact
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: true, filter: true, minWidth: 80 }}
        />
      </div>
    </div>
  );
}

// ─── Preview by Store ────────────────────────────────────────────────────────
// Same per-item demand as the Preview tab, but kept broken out per store:
// rows = items, columns = participating stores, cell = that store's demand
// (override qty, else capacity - on_hand clamped at 0). Columns are keyed by
// store id (name in the header) so they're stable across reloads. The PDF
// export mirrors the grid — demand per store per item — with a totals row.
type StoreDemandRow = {
  item_id: string;
  item_name: string;
  type: string;
  sub_category: string;
  total: number;
  // Per-store demand, keyed by store id (the column's colId/field).
  [storeId: string]: string | number;
};

function PreviewByStoreTab({ cycleId }: { cycleId: string }) {
  const [storeColumns, setStoreColumns] = useState<Array<{ id: string; name: string }>>([]);
  const [rows, setRows] = useState<StoreDemandRow[]>([]);
  const [exportCats, setExportCats] = useState<Set<string> | null>(null);
  const [exporting, setExporting] = useState(false);
  const [cycleDate, setCycleDate] = useState<string | null>(null);
  const loadTokenRef = useRef(0);

  useEffect(() => {
    let active = true;
    supabase
      .from("order_cycles")
      .select("order_date")
      .eq("id", cycleId)
      .maybeSingle()
      .then(({ data }) => {
        if (active) setCycleDate((data as { order_date: string | null } | null)?.order_date ?? null);
      });
    return () => {
      active = false;
    };
  }, [cycleId]);

  const load = useCallback(async () => {
    const myToken = ++loadTokenRef.current;
    const [cycleStoresRes, stockEntriesRes, storeItemsRes, itemsRes, overridesRes] =
      await Promise.all([
        supabase.from("cycle_stores").select("stores(id,name)").eq("cycle_id", cycleId),
        supabase.from("stock_entries").select("store_id,item_id,current_count").eq("cycle_id", cycleId),
        supabase.from("store_items").select("store_id,item_id,capacity").eq("is_active", true),
        supabase.from("items").select("id,name,type,sub_category,track_factory_stock"),
        supabase.from("allocation_overrides").select("store_id,item_id,qty,mode").eq("cycle_id", cycleId),
      ]);
    if (myToken !== loadTokenRef.current) return;
    if (
      !cycleStoresRes.data ||
      !stockEntriesRes.data ||
      !storeItemsRes.data ||
      !itemsRes.data ||
      !overridesRes.data
    ) {
      return;
    }

    const stores = (cycleStoresRes.data as unknown as Array<{ stores: { id: string; name: string } | null }>)
      .map((c) => c.stores)
      .filter((s): s is { id: string; name: string } => !!s)
      .sort((a, b) => a.name.localeCompare(b.name));
    const allowed = new Set(stores.map((s) => s.id));

    const onHandByKey = new Map<string, number>();
    for (const se of stockEntriesRes.data as Array<{ store_id: string; item_id: string; current_count: number }>) {
      onHandByKey.set(`${se.store_id}|${se.item_id}`, se.current_count);
    }
    const overrideByKey = new Map<string, { qty: number; mode: "soft" | "hard" }>();
    for (const o of overridesRes.data as Array<{ store_id: string; item_id: string; qty: number; mode: "soft" | "hard" }>) {
      if (allowed.has(o.store_id)) overrideByKey.set(`${o.store_id}|${o.item_id}`, { qty: o.qty, mode: o.mode });
    }

    const itemsById = new Map(
      (
        itemsRes.data as Array<{
          id: string;
          name: string;
          type: string;
          sub_category: string | null;
          track_factory_stock: boolean;
        }>
      ).map((i) => [i.id, i]),
    );

    type Acc = { type: string; sub_category: string | null; item_name: string; perStore: Map<string, number> };
    const acc = new Map<string, Acc>();
    const capKeys = new Set<string>();
    const add = (storeId: string, itemId: string, demand: number) => {
      if (demand <= 0) return;
      const it = itemsById.get(itemId);
      if (!it) return;
      // Include every item with demand — manufactured, factory-tracked, and
      // purchased store-direct (sauces, …) — so the per-store demand view and
      // its PDF are complete.
      let a = acc.get(itemId);
      if (!a) {
        a = { type: it.type, sub_category: it.sub_category, item_name: it.name, perStore: new Map() };
        acc.set(itemId, a);
      }
      a.perStore.set(storeId, (a.perStore.get(storeId) ?? 0) + demand);
    };

    for (const si of storeItemsRes.data as Array<{ store_id: string; item_id: string; capacity: number }>) {
      if (!allowed.has(si.store_id)) continue;
      const key = `${si.store_id}|${si.item_id}`;
      capKeys.add(key);
      const ov = overrideByKey.get(key);
      const demand = ov ? ov.qty : Math.max(0, si.capacity - (onHandByKey.get(key) ?? 0));
      add(si.store_id, si.item_id, demand);
    }
    // Override-only pairs (a store force-overridden for an item it doesn't carry).
    for (const [key, ov] of overrideByKey.entries()) {
      if (capKeys.has(key)) continue;
      const [storeId, itemId] = key.split("|");
      add(storeId, itemId, ov.qty);
    }

    const rowList: StoreDemandRow[] = [];
    for (const [itemId, a] of acc.entries()) {
      let total = 0;
      const row: StoreDemandRow = {
        item_id: itemId,
        item_name: a.item_name,
        type: a.type,
        sub_category: a.sub_category ?? "Uncategorized",
        total: 0,
      };
      for (const s of stores) {
        const v = a.perStore.get(s.id) ?? 0;
        row[s.id] = v;
        total += v;
      }
      if (total <= 0) continue;
      row.total = total;
      rowList.push(row);
    }
    rowList.sort(
      (a, b) =>
        (a.sub_category ?? "").localeCompare(b.sub_category ?? "") ||
        a.item_name.localeCompare(b.item_name),
    );

    setStoreColumns(stores);
    setRows(rowList);
  }, [cycleId]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtimeRefetch(
    [
      { table: "stock_entries", filter: `cycle_id=eq.${cycleId}` },
      { table: "cycle_stores", filter: `cycle_id=eq.${cycleId}` },
      { table: "allocation_overrides", filter: `cycle_id=eq.${cycleId}` },
      { table: "store_items" },
    ],
    load,
    `cycle-${cycleId}-preview-by-store`,
  );

  const categories = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => r.sub_category).filter((c): c is string => !!c))).sort((a, b) =>
        a.localeCompare(b),
      ),
    [rows],
  );
  const isCatPicked = (c: string) => exportCats === null || exportCats.has(c);
  const toggleCat = (c: string) =>
    setExportCats((prev) => {
      const base = prev === null ? new Set(categories) : new Set(prev);
      if (base.has(c)) base.delete(c);
      else base.add(c);
      return base;
    });
  const pickedCategories = exportCats === null ? categories : categories.filter((c) => exportCats.has(c));

  const grandTotal = useMemo(() => rows.reduce((s, r) => s + r.total, 0), [rows]);

  const columnDefs = useMemo<ColDef<StoreDemandRow>[]>(() => {
    const dimZeros = (params: ValueFormatterParams<StoreDemandRow>) => {
      const v = Number(params.value ?? 0);
      return v === 0 ? "—" : String(v);
    };
    const cellClassZero = (params: CellClassParams<StoreDemandRow>) =>
      Number(params.value ?? 0) === 0 ? "text-slate-600" : "";
    const numericCellStyle = { textAlign: "right" as const };
    return [
      { headerName: "Item", field: "item_name", pinned: "left", flex: 1, minWidth: 170 },
      { headerName: "Category", field: "sub_category", width: 140 },
      {
        headerName: "Total",
        field: "total",
        width: 90,
        cellStyle: numericCellStyle,
        cellClass: "font-semibold",
      },
      ...storeColumns.map<ColDef<StoreDemandRow>>((s) => ({
        headerName: s.name,
        colId: s.id,
        field: s.id,
        width: 110,
        valueFormatter: dimZeros,
        cellStyle: numericCellStyle,
        cellClass: cellClassZero,
      })),
    ];
  }, [storeColumns]);

  const exportPdf = async () => {
    const picked = new Set(pickedCategories);
    const selected = rows.filter((r) => r.sub_category && picked.has(r.sub_category));
    if (selected.length === 0) return;
    setExporting(true);
    try {
      const [{ jsPDF }, autoTableMod] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
      const autoTable = autoTableMod.default;
      const dateLabel = formatLocalDate(cycleDate, "");
      // Landscape — a column per store gets wide fast.
      const doc = new jsPDF({ orientation: "landscape" });
      doc.setFontSize(15);
      doc.text(`Demand by Store${dateLabel ? ` — ${dateLabel}` : ""}`, 14, 15);
      doc.setFontSize(10);
      doc.setTextColor(110);
      doc.text(`Categories: ${pickedCategories.join(", ")}`, 14, 21);

      const storeTotals = storeColumns.map((s) =>
        selected.reduce((sum, r) => sum + Number(r[s.id] ?? 0), 0),
      );
      const grand = selected.reduce((sum, r) => sum + r.total, 0);

      autoTable(doc, {
        startY: 26,
        head: [["Item", "Category", ...storeColumns.map((s) => s.name), "Total"]],
        body: selected.map((r) => [
          r.item_name,
          r.sub_category ?? "",
          ...storeColumns.map((s) => {
            const v = Number(r[s.id] ?? 0);
            return v === 0 ? "—" : String(v);
          }),
          String(r.total),
        ]),
        foot: [["Total", "", ...storeTotals.map((t) => String(t)), String(grand)]],
        styles: { fontSize: 8, cellPadding: 1.5 },
        headStyles: { fillColor: [15, 23, 42], halign: "right" },
        footStyles: { fillColor: [241, 245, 249], textColor: 20, fontStyle: "bold" },
        // Right-align every numeric column (stores + Total) across head, body
        // and foot so each header sits directly over its numbers. Item and
        // Category (cols 0-1) stay left-aligned.
        didParseCell: (data) => {
          if (data.column.index < 2) data.cell.styles.halign = "left";
          else data.cell.styles.halign = "right";
        },
      });

      const safe = (pickedCategories.length === categories.length ? "all" : pickedCategories.join("-"))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-");
      doc.save(`demand-by-store-${dateLabel || cycleId.slice(0, 8)}-${safe}.pdf`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-slate-950/60 p-4 text-sm text-slate-300 flex flex-wrap gap-4">
        <span>
          <strong className="text-white">{rows.length}</strong> items with demand
        </span>
        <span>
          <strong className="text-white">{grandTotal}</strong> total units demanded
        </span>
        <span>
          <strong className="text-white">{storeColumns.length}</strong> stores
        </span>
      </div>
      <p className="text-xs text-slate-500">
        Per-store demand (capacity minus on-hand, or an override) for every item.
        Export a category-filtered PDF broken down by store.
      </p>

      {categories.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-slate-950/40 p-3">
          <span className="text-xs font-medium uppercase tracking-wider text-slate-400">Export PDF</span>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => toggleCat(c)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                isCatPicked(c)
                  ? "bg-cyan-500/20 text-cyan-200 ring-1 ring-cyan-400/40"
                  : "bg-slate-800 text-slate-500 ring-1 ring-white/10"
              }`}
            >
              {c}
            </button>
          ))}
          <button
            type="button"
            onClick={exportPdf}
            disabled={exporting || pickedCategories.length === 0}
            className="ml-auto rounded-full bg-cyan-500 px-4 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
          >
            {exporting ? "Generating…" : "Export PDF"}
          </button>
        </div>
      )}

      <div style={{ height: 460 }}>
        <AgGridReact
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: true, filter: true, minWidth: 80 }}
        />
      </div>
    </div>
  );
}

// ─── Deliveries tab ──────────────────────────────────────────────────────────
// "What gets loaded on the truck" view of a cycle: each item as a row,
// each participating store as a column, with the total to load up front.
// Mark-delivered action lives here too since it's a deliveries action.
type DeliveryAllocation = {
  cycle_id: string;
  store_id: string;
  item_id: string;
  qty: number;
  factory_id: string;
  stores?: { name: string };
  items?: { name: string; type: string; sub_category: string | null };
};

type DeliveryRow = {
  item_id: string;
  type: string;
  sub_category: string;
  item_name: string;
  total: number;
  // Per-store quantities, keyed by store id (the column's colId/field).
  [storeId: string]: string | number;
};

const titleCaseDelivery = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function DeliveriesTab({
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
  const [allocations, setAllocations] = useState<DeliveryAllocation[]>([]);
  // Stores participating in this cycle (id + name), the authoritative column
  // list. Sourced from cycle_stores so a store's column never blinks out of
  // existence just because its delivered quantity dropped to zero — that
  // vanishing column was what made AG Grid log "column <store> not found"
  // whenever the grid was sorted/filtered by a store whose total went to 0.
  const [cycleStores, setCycleStores] = useState<
    Array<{ id: string; name: string; delivered_at: string | null; finished_at: string | null }>
  >([]);
  const [marking, setMarking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // null = every category selected; otherwise the explicit picked set.
  const [exportCats, setExportCats] = useState<Set<string> | null>(null);

  // Drop stale responses: Run does DELETE + INSERT, so two reloads can race and
  // an earlier empty result must not clobber a later populated one.
  const reloadTokenRef = useRef(0);
  const reload = useCallback(async () => {
    const myToken = ++reloadTokenRef.current;
    const [allocRes, storesRes] = await Promise.all([
      supabase
        .from("allocations")
        .select(
          "cycle_id,store_id,item_id,qty,factory_id,stores(name),items(name,type,sub_category)",
        )
        .eq("cycle_id", cycleId),
      supabase
        .from("cycle_stores")
        .select("delivered_at, finished_at, stores(id,name)")
        .eq("cycle_id", cycleId),
    ]);
    if (myToken !== reloadTokenRef.current) return;
    if (allocRes.error) {
      // eslint-disable-next-line no-console
      console.error("DeliveriesTab reload failed:", allocRes.error);
    }
    if (allocRes.data) setAllocations(allocRes.data as unknown as DeliveryAllocation[]);
    if (storesRes.data) {
      const list = (
        storesRes.data as unknown as Array<{
          delivered_at: string | null;
          finished_at: string | null;
          stores: { id: string; name: string } | null;
        }>
      )
        .filter((cs) => !!cs.stores)
        .map((cs) => ({
          id: cs.stores!.id,
          name: cs.stores!.name,
          delivered_at: cs.delivered_at,
          finished_at: cs.finished_at,
        }));
      setCycleStores(list);
    }
  }, [cycleId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useRealtimeRefetch(
    [
      { table: "allocations", filter: `cycle_id=eq.${cycleId}` },
      { table: "cycle_stores", filter: `cycle_id=eq.${cycleId}` },
    ],
    reload,
    `cycle-${cycleId}-deliveries`,
  );

  const { storeColumns, deliveryRows } = useMemo(() => {
    const positive = allocations.filter((a) => a.qty > 0);
    type ItemAcc = {
      item_id: string;
      type: string;
      sub_category: string;
      item_name: string;
      // Keyed by store id (stable), not name.
      perStore: Map<string, number>;
    };
    const items = new Map<string, ItemAcc>();

    positive.forEach((a) => {
      const itemName = a.items?.name ?? a.item_id;
      const type = titleCaseDelivery(a.items?.type ?? "uncategorized");
      const sub = a.items?.sub_category ?? "Uncategorized";

      if (!items.has(a.item_id)) {
        items.set(a.item_id, {
          item_id: a.item_id,
          type,
          sub_category: sub,
          item_name: itemName,
          perStore: new Map(),
        });
      }
      const acc = items.get(a.item_id)!;
      acc.perStore.set(a.store_id, (acc.perStore.get(a.store_id) ?? 0) + a.qty);
    });

    // Columns come from the cycle's participating stores, sorted by name, and
    // are identified by store id so the column id is stable across reloads and
    // safe regardless of the store's display name (slashes, dots, etc.).
    const sortedStores = [...cycleStores].sort((x, y) => x.name.localeCompare(y.name));
    const sortedItems = Array.from(items.values()).sort((x, y) => {
      const t = x.type.localeCompare(y.type);
      if (t !== 0) return t;
      const s = x.sub_category.localeCompare(y.sub_category);
      if (s !== 0) return s;
      return x.item_name.localeCompare(y.item_name);
    });
    const rows: DeliveryRow[] = sortedItems.map((acc) => {
      const row: DeliveryRow = {
        item_id: acc.item_id,
        type: acc.type,
        sub_category: acc.sub_category,
        item_name: acc.item_name,
        total: 0,
      };
      let total = 0;
      sortedStores.forEach((s) => {
        const qty = acc.perStore.get(s.id) ?? 0;
        row[s.id] = qty;
        total += qty;
      });
      row.total = total;
      return row;
    });

    return { storeColumns: sortedStores, deliveryRows: rows };
  }, [allocations, cycleStores]);

  const totalUnits = useMemo(
    () => deliveryRows.reduce((sum, r) => sum + r.total, 0),
    [deliveryRows],
  );
  const storeCount = storeColumns.length;

  const columnDefs = useMemo<ColDef<DeliveryRow>[]>(() => {
    const dimZeros = (params: ValueFormatterParams<DeliveryRow>) => {
      const v = Number(params.value ?? 0);
      return v === 0 ? "—" : String(v);
    };
    const cellClassZero = (params: CellClassParams<DeliveryRow>) =>
      Number(params.value ?? 0) === 0 ? "text-slate-600" : "";
    const numericCellStyle = { textAlign: "right" as const };
    return [
      { headerName: "Item", field: "item_name", pinned: "left", flex: 1, minWidth: 180 },
      { headerName: "Type", field: "type", width: 110 },
      { headerName: "Sub-Category", field: "sub_category", width: 140 },
      {
        headerName: "Total",
        field: "total",
        width: 100,
        cellStyle: numericCellStyle,
        cellClass: "font-semibold",
      },
      ...storeColumns.map<ColDef<DeliveryRow>>((s) => ({
        headerName: s.name,
        // colId/field is the store id — stable and free of name special chars.
        colId: s.id,
        field: s.id,
        width: 110,
        valueFormatter: dimZeros,
        cellStyle: numericCellStyle,
        cellClass: cellClassZero,
        // Delivery numbers are hand-correctable only while finalized (locked
        // from auto-changes, before Delivered) — so the digital plan can be made
        // to match what actually went on the truck.
        editable: cycleStatus === "finalized",
        cellEditor: "agNumberCellEditor",
        cellEditorParams: { min: 0, precision: 0 },
      })),
    ];
  }, [storeColumns, cycleStatus]);

  // Persist a hand-edited delivery cell to the allocation (cycle, store, item).
  // The store carry-forward reads allocations.qty, so editing here flows straight
  // into each store's next-cycle opening count. Only reachable while finalized.
  const handleDeliveryCellChanged = async (params: CellValueChangedEvent<DeliveryRow>) => {
    const storeId = params.colDef.field;
    const itemId = params.data.item_id;
    if (!storeId || !itemId || params.newValue === params.oldValue) return;
    const qty = Math.trunc(Number(params.newValue));
    if (!Number.isFinite(qty) || qty < 0) {
      setMessage("Delivery qty must be a whole number of boxes (0 or more).");
      params.node.setDataValue(storeId, params.oldValue);
      return;
    }
    setMessage(null);
    const payload = {
      cycle_id: cycleId,
      store_id: storeId,
      item_id: itemId,
      qty,
      source: "manual_override",
      shortfall: 0,
      overdraft: 0,
    };
    let { error } = await supabase
      .from("allocations")
      .upsert([payload], { onConflict: "cycle_id,store_id,item_id" });
    if (error) {
      // Token may have expired while idle — refresh and retry once.
      await supabase.auth.getSession();
      ({ error } = await supabase
        .from("allocations")
        .upsert([payload], { onConflict: "cycle_id,store_id,item_id" }));
    }
    if (error) {
      setMessage(`Couldn't save delivery change: ${error.message}`);
      params.node.setDataValue(storeId, params.oldValue);
    }
  };

  // Category picker + PDF export — the same delivery sheet as the demand-by-store
  // export, but built from the finalised per-store allocations, so it includes
  // purchased items (sauces, drinks, …) that the factory-only demand preview omits.
  const categories = useMemo(
    () =>
      Array.from(
        new Set(deliveryRows.map((r) => r.sub_category).filter((c): c is string => !!c)),
      ).sort((a, b) => a.localeCompare(b)),
    [deliveryRows],
  );
  const isCatPicked = (c: string) => exportCats === null || exportCats.has(c);
  const toggleCat = (c: string) =>
    setExportCats((prev) => {
      const base = prev === null ? new Set(categories) : new Set(prev);
      if (base.has(c)) base.delete(c);
      else base.add(c);
      return base;
    });
  const pickedCategories = exportCats === null ? categories : categories.filter((c) => exportCats.has(c));

  const exportPdf = async () => {
    const picked = new Set(pickedCategories);
    const selected = deliveryRows.filter((r) => r.sub_category && picked.has(r.sub_category));
    if (selected.length === 0) return;
    setExporting(true);
    try {
      const [{ jsPDF }, autoTableMod] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
      const autoTable = autoTableMod.default;
      const dateLabel = formatLocalDate(cycleOrderDate, "");
      // Landscape — a column per store gets wide fast.
      const doc = new jsPDF({ orientation: "landscape" });
      doc.setFontSize(15);
      doc.text(`Deliveries${dateLabel ? ` — ${dateLabel}` : ""}`, 14, 15);
      doc.setFontSize(10);
      doc.setTextColor(110);
      doc.text(`Categories: ${pickedCategories.join(", ")}`, 14, 21);

      const storeTotals = storeColumns.map((s) =>
        selected.reduce((sum, r) => sum + Number(r[s.id] ?? 0), 0),
      );
      const grand = selected.reduce((sum, r) => sum + r.total, 0);

      autoTable(doc, {
        startY: 26,
        head: [["Item", "Category", ...storeColumns.map((s) => s.name), "Total"]],
        body: selected.map((r) => [
          r.item_name,
          r.sub_category ?? "",
          ...storeColumns.map((s) => {
            const v = Number(r[s.id] ?? 0);
            return v === 0 ? "—" : String(v);
          }),
          String(r.total),
        ]),
        foot: [["Total", "", ...storeTotals.map((t) => String(t)), String(grand)]],
        styles: { fontSize: 8, cellPadding: 1.5 },
        headStyles: { fillColor: [15, 23, 42], halign: "right" },
        footStyles: { fillColor: [241, 245, 249], textColor: 20, fontStyle: "bold" },
        didParseCell: (data) => {
          if (data.column.index < 2) data.cell.styles.halign = "left";
          else data.cell.styles.halign = "right";
        },
      });

      const safe = (pickedCategories.length === categories.length ? "all" : pickedCategories.join("-"))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-");
      doc.save(`deliveries-${dateLabel || cycleId.slice(0, 8)}-${safe}.pdf`);
    } finally {
      setExporting(false);
    }
  };

  const isFinalized = cycleStatus === "finalized";
  const isDelivered = cycleStatus === "delivered";
  const hasOrderDate = !!cycleOrderDate;

  // Allocations run automatically from cycle creation, so there's no "run" step.
  // Finalize is the lock: a human clicks it once EVERY store has marked its
  // stock finished (it never auto-finalizes). It must come before Delivered.
  const allStoresFinished = cycleStores.length > 0 && cycleStores.every((s) => !!s.finished_at);
  const unfinishedCount = cycleStores.filter((s) => !s.finished_at).length;
  const canFinalize = allStoresFinished && hasOrderDate && !isFinalized && !isDelivered;
  const finalizeTitle = isDelivered
    ? "Already delivered."
    : isFinalized
      ? "Already finalized."
      : !allStoresFinished
        ? `Waiting on ${unfinishedCount} store${unfinishedCount === 1 ? "" : "s"} to finish their stock entry.`
        : !hasOrderDate
          ? "Set an order date first."
          : undefined;

  // Per-store delivery (requires the cycle to be finalized first). Each store is
  // marked as the truck drops it; the cycle flips to delivered once all are done.
  const deliveredStoreCount = cycleStores.filter((s) => s.delivered_at).length;
  const remainingStores = cycleStores.filter((s) => !s.delivered_at);
  const showDeliveryPanel = (isFinalized || isDelivered) && cycleStores.length > 0;

  const cycleDateLabel = formatLocalDate(cycleOrderDate, "Not set");

  const deliverStore = async (storeId: string, storeName: string) => {
    if (!confirm(`Mark ${storeName} delivered? Its stock moves to its next cycle and this can't be undone here.`)) {
      return;
    }
    setMarking(true);
    setMessage(null);
    try {
      const response = await fetch("/api/allocations/deliver-store", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cycle_id: cycleId, store_id: storeId }),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(`Error: ${data.error}`);
        return;
      }
      await onFinalized();
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally {
      setMarking(false);
    }
  };

  const deliverAllRemaining = async () => {
    if (remainingStores.length === 0) return;
    if (
      !confirm(
        `Mark all ${remainingStores.length} remaining store${remainingStores.length === 1 ? "" : "s"} delivered? This closes the cycle and moves their stock.`,
      )
    ) {
      return;
    }
    setMarking(true);
    setMessage(null);
    try {
      for (const s of remainingStores) {
        const response = await fetch("/api/allocations/deliver-store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cycle_id: cycleId, store_id: s.id }),
        });
        const data = await response.json();
        if (!response.ok) {
          setMessage(`Error delivering ${s.name}: ${data.error}`);
          break;
        }
      }
      await onFinalized();
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally {
      setMarking(false);
    }
  };

  const finalize = async (lock: boolean) => {
    setMarking(true);
    setMessage(null);
    try {
      const response = await fetch("/api/allocations/lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cycle_id: cycleId, locked: lock }),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(`Error: ${data.error}`);
        return;
      }
      await onFinalized();
      if (lock) {
        // Auto-download the delivery manifest the crew loads from.
        await exportPdf();
        setMessage("✅ Delivery finalized — the plan is locked and the PDF has downloaded.");
      } else {
        setMessage("Delivery unlocked — allocations can be re-run again.");
      }
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally {
      setMarking(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-400">
          {deliveryRows.length === 0 ? (
            "Calculating — the delivery plan fills in automatically as stores enter stock."
          ) : (
            <>
              {deliveryRows.length} items · {storeCount} {storeCount === 1 ? "store" : "stores"} · {totalUnits} total units
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isFinalized && !isDelivered && (
            <button
              type="button"
              onClick={() => finalize(true)}
              disabled={!canFinalize || marking}
              title={finalizeTitle}
              className="rounded-full bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {marking ? "Working..." : "Finalize delivery"}
            </button>
          )}
          {isFinalized && !isDelivered && (
            <button
              type="button"
              onClick={() => finalize(false)}
              disabled={marking}
              title="Unlock to re-run allocations."
              className="rounded-full border border-white/15 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-700 disabled:opacity-50"
            >
              {marking ? "Working..." : "Unlock"}
            </button>
          )}
          {isDelivered ? (
            <span className="rounded-full bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-emerald-300 ring-1 ring-emerald-400/40">
              Delivered ✓
            </span>
          ) : (
            isFinalized &&
            remainingStores.length > 0 && (
              <button
                type="button"
                onClick={deliverAllRemaining}
                disabled={marking}
                className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {marking ? "Marking..." : "Deliver all remaining"}
              </button>
            )
          )}
        </div>
      </div>

      {isFinalized && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-950/50 px-4 py-3 text-sm text-amber-200">
          🔒 Delivery is <strong>finalized</strong> — the plan is locked and won&apos;t
          auto-change. Mark each store below as the truck drops it; the cycle closes once all
          {" "}
          {cycleStores.length} are delivered.
        </div>
      )}

      {showDeliveryPanel && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-white">Per-store delivery</h3>
            <span className="text-xs text-slate-400">
              {deliveredStoreCount} / {cycleStores.length} delivered
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {[...cycleStores]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((s) => (
                <div
                  key={s.id}
                  className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-slate-950 px-3 py-1.5 text-sm"
                >
                  <span className={s.delivered_at ? "text-emerald-300" : "text-slate-200"}>{s.name}</span>
                  {s.delivered_at ? (
                    <span className="text-xs font-semibold text-emerald-400">✓ delivered</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => deliverStore(s.id, s.name)}
                      disabled={marking}
                      className="rounded-full bg-emerald-500 px-3 py-0.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
                    >
                      Deliver
                    </button>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}

      {deliveryRows.length > 0 && categories.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-slate-950/40 p-3">
          <span className="text-xs font-medium uppercase tracking-wider text-slate-400">Export PDF</span>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => toggleCat(c)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                isCatPicked(c)
                  ? "bg-cyan-500/20 text-cyan-200 ring-1 ring-cyan-400/40"
                  : "bg-slate-800 text-slate-500 ring-1 ring-white/10"
              }`}
            >
              {c}
            </button>
          ))}
          <button
            type="button"
            onClick={exportPdf}
            disabled={exporting || pickedCategories.length === 0}
            className="ml-auto rounded-full bg-cyan-500 px-4 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
          >
            {exporting ? "Generating…" : "Export PDF"}
          </button>
        </div>
      )}

      {message && <p className="text-sm text-cyan-300">{message}</p>}

      {isFinalized && !isDelivered && (
        <p className="text-xs text-slate-500">
          Tap a store cell to adjust what that store actually receives before marking it
          delivered — the change flows straight into that store&apos;s stock.
        </p>
      )}

      {/* Always render the grid container so switching to this tab doesn't
          cause a height-shift / scroll jump while allocations are still
          loading. AG Grid shows its own "No rows" placeholder when the
          rowData array is empty. */}
      <div style={{ height: 480 }}>
        <AgGridReact
          rowData={deliveryRows}
          columnDefs={columnDefs}
          // Stable row identity keeps the scroll/edit position when a save
          // reloads the grid (see StoreStockEntry).
          getRowId={(p) => p.data.item_id}
          onCellValueChanged={handleDeliveryCellChanged}
          stopEditingWhenCellsLoseFocus={true}
          defaultColDef={{ resizable: true, sortable: true, filter: true, minWidth: 80 }}
        />
      </div>
    </div>
  );
}
