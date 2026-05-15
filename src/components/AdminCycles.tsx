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

type TabKey = "details" | "stock" | "allocations" | "deliveries";

// Form state for the Overrides tab. Lifted out of OverridesTab so switching
// tabs inside the cycle modal keeps the in-progress entry. AdminCycles
// resets it when selectedCycleId changes.
type OverrideMode = "soft" | "hard";
type OverrideDraft = {
  showForm: boolean;
  editingKey: string | null;
  storeId: string;
  itemId: string;
  qty: string;
  reason: string;
  // Soft = respect factory stock (shortfall if short). Hard = bypass
  // factory stock; allocation gets the full qty even if factory is short
  // (factory_counts go negative for that item).
  mode: OverrideMode;
};
const emptyOverrideDraft: OverrideDraft = {
  showForm: false,
  editingKey: null,
  storeId: "",
  itemId: "",
  qty: "",
  reason: "",
  mode: "soft",
};

export default function AdminCycles() {
  const { session, loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
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

  // Override draft — lifted out of OverridesTab so tab switches inside the
  // cycle modal don't blow away in-progress entry. Reset whenever the
  // selected cycle changes (closing the modal counts as a change to null).
  const [overrideDraft, setOverrideDraft] = useState<OverrideDraft>(emptyOverrideDraft);
  useEffect(() => {
    setOverrideDraft(emptyOverrideDraft);
  }, [selectedCycleId]);

  const canManage = isStoreManager;

  const reloadCycles = useCallback(async () => {
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
          setLoading(false);
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
          setLoading(false);
          return;
        }
      }
    } else if (selectedStoreIds.length > 0) {
      const { error } = await supabase.from("cycle_stores").insert(
        selectedStoreIds.map((id) => ({ cycle_id: cycleId, store_id: id })),
      );
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
      ) : !isStoreManager ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to Store Managers.</p>
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
                {(["details", "stock", "allocations", "deliveries"] as TabKey[]).map((tab) => (
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
                      : tab === "stock"
                        ? "Stock"
                        : tab === "allocations"
                          ? "Allocations"
                          : "Deliveries"}
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
                  readOnly={selectedCycle.status === "delivered"}
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
              {activeTab === "allocations" && (
                <AllocationsTab
                  cycleId={selectedCycle.id}
                  cycleStatus={selectedCycle.status}
                  onFinalized={reloadCycles}
                  overrideDraft={overrideDraft}
                  setOverrideDraft={setOverrideDraft}
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
      </div>
      {view === "preview" ? (
        <PreviewTab cycleId={cycleId} />
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
  const load = useCallback(async () => {
    const { data } = await supabase
      .from("stock_entries")
      .select(
        "current_count,entered_at,stores(name),items(name,type,sub_category)",
      )
      .eq("cycle_id", cycleId)
      .order("entered_at", { ascending: false });
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
  const load = useCallback(async () => {
    const { data } = await supabase
      .from("factory_counts")
      .select(
        "available_qty,counted_at,factories(name),items(name,sub_category)",
      )
      .eq("cycle_id", cycleId)
      .order("counted_at", { ascending: false });
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
// Scoped to BOX_TRACED_CATEGORIES because those are the only items whose
// counts auto-update from box traces during the week. Manually-counted
// items (drinks etc.) don't change between cycle start and end-of-week
// entry, so a live preview wouldn't tell admin anything useful for them.
// Keep this list in sync with the Box Trace Log + StoreStockEntry's
// BOX_TRACED_CATEGORIES.
const PREVIEW_CATEGORIES = ["Empanada", "Dessert"];
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

  const load = useCallback(async () => {
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
      supabase.from("items").select("id,name,type,sub_category"),
      supabase
        .from("allocation_overrides")
        .select("store_id,item_id,qty,mode")
        .eq("cycle_id", cycleId),
    ]);

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
        }>
      ).map((i) => [i.id, i]),
    );

    const previewRows: PreviewRow[] = [];
    for (const [itemId, totalDemand] of demandByItem.entries()) {
      if (totalDemand <= 0) continue; // skip items with no demand
      const item = itemsById.get(itemId);
      if (!item) continue;
      if (!item.sub_category || !PREVIEW_CATEGORIES.includes(item.sub_category)) {
        continue; // preview is for box-traced categories only
      }
      const factoryAvailable = factoryByItem.get(itemId) ?? 0;
      // Manufactured items rely on factory stock; purchased items go to
      // suppliers via POs and "factory available" doesn't apply — treat
      // the whole demand as a "to-order" amount instead.
      const shortfall =
        item.type === "manufactured"
          ? Math.max(0, totalDemand - factoryAvailable)
          : 0;
      previewRows.push({
        item_id: itemId,
        item_name: item.name,
        type: item.type,
        sub_category: item.sub_category,
        total_demand: totalDemand,
        factory_available: item.type === "manufactured" ? factoryAvailable : 0,
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

type AllocationRecord = {
  store_id: string;
  item_id: string;
  store_name: string;
  item_name: string;
  sub_category: string | null;
  // null supplier name → manufactured in-house (we make it). Drives the
  // master sort grouping in the Allocations grid.
  supplier_name: string | null;
  qty: number;
  source: string;
  factory_name: string;
  shortfall: number;
  // Amount a hard override forced past available factory stock. >0 means
  // the factory is in the hole by this many units of this item.
  overdraft: number;
};

type OverrideRecord = {
  store_id: string;
  item_id: string;
  qty: number;
  reason: string | null;
  mode: OverrideMode;
};

type AllocationRow = AllocationRecord & {
  override_reason: string | null;
  has_override: boolean;
  override_mode: OverrideMode | null;
  // True when there is an override for this (store, item) but the
  // current allocation row doesn't yet reflect it — i.e. a re-run is
  // needed before it lands.
  override_pending: boolean;
};

function AllocationsTab({
  cycleId,
  cycleStatus,
  onFinalized,
  overrideDraft,
  setOverrideDraft,
}: {
  cycleId: string;
  cycleStatus: string;
  onFinalized: () => Promise<void> | void;
  overrideDraft: OverrideDraft;
  setOverrideDraft: (
    nextOrUpdater: OverrideDraft | ((prev: OverrideDraft) => OverrideDraft),
  ) => void;
}) {
  const [allocations, setAllocations] = useState<AllocationRecord[]>([]);
  const [overrides, setOverrides] = useState<OverrideRecord[]>([]);
  const [stores, setStores] = useState<Array<{ id: string; name: string }>>([]);
  const [items, setItems] = useState<
    Array<{ id: string; name: string; supplier_name: string | null }>
  >([]);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  // External filters (driven by the chip bar above the grid).
  const [sourceFilter, setSourceFilter] = useState<
    "all" | "factory" | "purchase" | "manual" | "hard"
  >("all");
  const [deficitFilter, setDeficitFilter] = useState<
    "all" | "any" | "hard"
  >("all");
  const gridApiRef = useRef<GridApi<AllocationRow> | null>(null);
  const isDelivered = cycleStatus === "delivered";
  const readOnly = isDelivered;

  const { showForm, editingKey, storeId, itemId, qty, reason, mode } = overrideDraft;
  const patchDraft = (patch: Partial<OverrideDraft>) =>
    setOverrideDraft((prev) => ({ ...prev, ...patch }));

  const reload = useCallback(async () => {
    const [allocRes, overrideRes, storesRes, itemsRes] = await Promise.all([
      supabase
        .from("allocations")
        .select(
          "store_id,item_id,qty,source,shortfall,overdraft,stores(name),items(name,sub_category,suppliers(name)),factories!allocations_factory_id_fkey(name)",
        )
        .eq("cycle_id", cycleId),
      supabase
        .from("allocation_overrides")
        .select("store_id,item_id,qty,reason,mode")
        .eq("cycle_id", cycleId),
      supabase.from("stores").select("id,name").order("name"),
      supabase
        .from("items")
        .select("id,name,suppliers(name)")
        .order("name"),
    ]);

    if (storesRes.data) setStores(storesRes.data);
    if (itemsRes.data) {
      setItems(
        (itemsRes.data as unknown as Array<{
          id: string;
          name: string;
          suppliers: { name: string } | null;
        }>).map((i) => ({
          id: i.id,
          name: i.name,
          supplier_name: i.suppliers?.name ?? null,
        })),
      );
    }
    if (overrideRes.data) setOverrides(overrideRes.data as OverrideRecord[]);
    if (allocRes.data) {
      setAllocations(
        (allocRes.data as unknown as Array<{
          store_id: string;
          item_id: string;
          qty: number;
          source: string;
          shortfall: number;
          overdraft: number | null;
          stores: { name: string } | null;
          items: {
            name: string;
            sub_category: string | null;
            suppliers: { name: string } | null;
          } | null;
          factories: { name: string } | null;
        }>).map((a) => ({
          store_id: a.store_id,
          item_id: a.item_id,
          store_name: a.stores?.name ?? "",
          item_name: a.items?.name ?? "",
          sub_category: a.items?.sub_category ?? null,
          supplier_name: a.items?.suppliers?.name ?? null,
          qty: a.qty,
          source: a.source,
          factory_name: a.factories?.name ?? "",
          shortfall: a.shortfall,
          overdraft: a.overdraft ?? 0,
        })),
      );
    }
  }, [cycleId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useRealtimeRefetch(
    [
      { table: "allocations", filter: `cycle_id=eq.${cycleId}` },
      { table: "allocation_overrides", filter: `cycle_id=eq.${cycleId}` },
    ],
    reload,
    `cycle-${cycleId}-allocations`,
  );

  const overrideByKey = useMemo(() => {
    const m = new Map<string, OverrideRecord>();
    overrides.forEach((o) => m.set(`${o.store_id}|${o.item_id}`, o));
    return m;
  }, [overrides]);

  const storeNameById = useMemo(
    () => new Map(stores.map((s) => [s.id, s.name])),
    [stores],
  );
  const itemNameById = useMemo(
    () => new Map(items.map((i) => [i.id, i.name])),
    [items],
  );
  const supplierNameByItem = useMemo(
    () => new Map(items.map((i) => [i.id, i.supplier_name])),
    [items],
  );

  const rows: AllocationRow[] = useMemo(() => {
    const allocByKey = new Map<string, AllocationRecord>();
    allocations.forEach((a) =>
      allocByKey.set(`${a.store_id}|${a.item_id}`, a),
    );

    const merged: AllocationRow[] = allocations.map((a) => {
      const ov = overrideByKey.get(`${a.store_id}|${a.item_id}`);
      // Match the pendingRerun logic: soft requires overdraft = 0 and
      // qty + shortfall = ov.qty; hard requires qty = ov.qty and
      // shortfall = 0. The overdraft check is essential for catching
      // hard→soft flips (hard leaves shortfall at 0 too, so the simpler
      // soft check would pass falsely).
      let pending = false;
      if (ov) {
        if (a.source !== "manual_override") {
          pending = true;
        } else if (ov.mode === "hard") {
          pending = a.qty !== ov.qty || a.shortfall !== 0;
        } else {
          pending = a.overdraft !== 0 || a.qty + a.shortfall !== ov.qty;
        }
      }
      return {
        ...a,
        override_reason: ov?.reason ?? null,
        has_override: !!ov,
        override_mode: ov?.mode ?? null,
        override_pending: pending,
      };
    });

    // Surface overrides that don't yet have a matching allocation row so
    // the user can see + edit them. They appear with qty 0 and a synthetic
    // 'pending' source — re-running allocations materializes them.
    overrides.forEach((o) => {
      const key = `${o.store_id}|${o.item_id}`;
      if (!allocByKey.has(key)) {
        merged.push({
          store_id: o.store_id,
          item_id: o.item_id,
          store_name: storeNameById.get(o.store_id) ?? o.store_id,
          item_name: itemNameById.get(o.item_id) ?? o.item_id,
          sub_category: null,
          supplier_name: supplierNameByItem.get(o.item_id) ?? null,
          qty: o.qty,
          source: "pending_override",
          factory_name: "",
          shortfall: 0,
          overdraft: 0,
          override_reason: o.reason,
          has_override: true,
          override_mode: o.mode,
          override_pending: true,
        });
      }
    });

    // Master sort: Store → Supplier (Manufactured first, then alpha by
    // supplier name) → Category → Item. The empty-string prefix on
    // Manufactured guarantees it sorts before any real supplier name.
    const supplierSortKey = (s: string | null) =>
      s === null ? "" : `1:${s}`;
    return merged.sort(
      (x, y) =>
        x.store_name.localeCompare(y.store_name) ||
        supplierSortKey(x.supplier_name).localeCompare(supplierSortKey(y.supplier_name)) ||
        (x.sub_category ?? "").localeCompare(y.sub_category ?? "") ||
        x.item_name.localeCompare(y.item_name),
    );
  }, [allocations, overrides, overrideByKey, storeNameById, itemNameById, supplierNameByItem]);

  // External filter hooks for the chip bar above the grid. AG Grid
  // captures these function refs at mount and doesn't always pick up
  // prop changes. We keep the function identities stable and read the
  // latest filter state from refs so AG Grid's cached refs still see
  // the current values.
  const sourceFilterRef = useRef(sourceFilter);
  const deficitFilterRef = useRef(deficitFilter);
  sourceFilterRef.current = sourceFilter;
  deficitFilterRef.current = deficitFilter;

  const isExternalFilterPresent = useCallback(
    () =>
      sourceFilterRef.current !== "all" || deficitFilterRef.current !== "all",
    [],
  );
  const doesExternalFilterPass = useCallback(
    (node: IRowNode<AllocationRow>) => {
      const row = node.data;
      if (!row) return false;
      const sf = sourceFilterRef.current;
      const df = deficitFilterRef.current;
      if (sf === "factory") {
        if (row.source !== "factory") return false;
      } else if (sf === "purchase") {
        if (row.source !== "purchase") return false;
      } else if (sf === "manual") {
        if (
          row.source !== "manual_override" ||
          !row.has_override ||
          row.override_mode === "hard"
        ) {
          return false;
        }
      } else if (sf === "hard") {
        if (
          row.source !== "manual_override" ||
          row.override_mode !== "hard"
        ) {
          return false;
        }
      }
      if (df === "any") {
        if ((row.shortfall ?? 0) === 0 && (row.overdraft ?? 0) === 0) {
          return false;
        }
      } else if (df === "hard") {
        if ((row.overdraft ?? 0) === 0) return false;
      }
      return true;
    },
    [],
  );
  useEffect(() => {
    gridApiRef.current?.onFilterChanged();
  }, [sourceFilter, deficitFilter]);

  // Aggregate totals for the warning banner. Overdraft is the hard-override
  // factory deficit — drawn in rose so it's impossible to miss.
  const totals = useMemo(() => {
    let shortfall = 0;
    let overdraft = 0;
    const overdraftItems = new Set<string>();
    for (const a of allocations) {
      shortfall += a.shortfall;
      if (a.overdraft > 0) {
        overdraft += a.overdraft;
        overdraftItems.add(a.item_id);
      }
    }
    return { shortfall, overdraft, overdraftItemCount: overdraftItems.size };
  }, [allocations]);

  // An override is "pending apply" if either (a) no matching allocation
  // row exists, or (b) the matching allocation isn't yet sourced from the
  // override (source !== manual_override) or the qty doesn't match.
  const pendingRerun = useMemo(() => {
    const allocByKey = new Map<string, AllocationRecord>();
    allocations.forEach((a) =>
      allocByKey.set(`${a.store_id}|${a.item_id}`, a),
    );
    // Each override must match a manual_override allocation row.
    // Soft and hard differ in WHICH side absorbs the factory shortage:
    //   soft: store eats it  → qty + shortfall = override.qty, overdraft = 0
    //   hard: factory eats it → qty = override.qty, shortfall = 0
    // The overdraft check is what catches a hard→soft flip when the qty
    // and shortfall coincidentally match the soft form (because hard sets
    // shortfall to 0 too).
    for (const o of overrides) {
      const a = allocByKey.get(`${o.store_id}|${o.item_id}`);
      if (!a) return true;
      if (a.source !== "manual_override") return true;
      if (o.mode === "hard") {
        if (a.qty !== o.qty) return true;
        if (a.shortfall !== 0) return true;
      } else {
        if (a.overdraft !== 0) return true;
        if (a.qty + a.shortfall !== o.qty) return true;
      }
    }
    // Orphaned manual_override allocations: row still sourced from a
    // deleted override. Re-run will recompute it from the natural source.
    const overrideKeys = new Set(
      overrides.map((o) => `${o.store_id}|${o.item_id}`),
    );
    for (const a of allocations) {
      if (
        a.source === "manual_override" &&
        !overrideKeys.has(`${a.store_id}|${a.item_id}`)
      ) {
        return true;
      }
    }
    return false;
  }, [allocations, overrides]);

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

  const openOverrideFor = (row: AllocationRow) => {
    setOverrideDraft({
      showForm: true,
      // Only flag as "editing" when the override actually exists in the DB.
      // Otherwise this is a fresh override created by clicking the qty of
      // a non-overridden row — submit upserts a new row.
      editingKey: row.has_override ? `${row.store_id}|${row.item_id}` : null,
      storeId: row.store_id,
      itemId: row.item_id,
      qty: String(row.qty),
      reason: row.override_reason ?? "",
      mode: row.override_mode ?? "soft",
    });
  };

  const handleOverrideSubmit = async (e: FormEvent<HTMLFormElement>) => {
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
    setFormLoading(true);
    setMessage(null);
    const { error } = await supabase.from("allocation_overrides").upsert(
      [{
        cycle_id: cycleId,
        store_id: storeId,
        item_id: itemId,
        qty: qtyNum,
        reason: reason.trim() || null,
        mode,
      }],
      { onConflict: "cycle_id,store_id,item_id" },
    );
    setFormLoading(false);
    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage(editingKey ? "Override updated. Re-run allocations to apply." : "Override created. Re-run allocations to apply.");
    setOverrideDraft(emptyOverrideDraft);
    await reload();
  };

  const handleDeleteOverride = async () => {
    if (!storeId || !itemId) return;
    const storeName = storeNameById.get(storeId) ?? storeId;
    const itemName = itemNameById.get(itemId) ?? itemId;
    if (!confirm(`Delete override for ${storeName} / ${itemName}?`)) return;
    setFormLoading(true);
    setMessage(null);
    const { error } = await supabase
      .from("allocation_overrides")
      .delete()
      .eq("cycle_id", cycleId)
      .eq("store_id", storeId)
      .eq("item_id", itemId);
    setFormLoading(false);
    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage("Override deleted. Re-run allocations to apply.");
    setOverrideDraft(emptyOverrideDraft);
    await reload();
  };

  const columnDefs: ColDef<AllocationRow>[] = [
    {
      headerName: "Store",
      field: "store_name",
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
    {
      headerName: "Qty",
      field: "qty",
      sortable: true,
      filter: true,
      width: 170,
      // The Qty cell is the override edit affordance AND the override
      // state indicator (Source column having been retired). A small
      // pill before the number shows Manual / Hard / Pending; bold red
      // + octagon still indicates an overdraft (hard override past
      // factory stock).
      cellRenderer: (params: ICellRendererParams<AllocationRow>) => {
        const row = params.data;
        const value = (params.value as number | undefined) ?? 0;
        if (!row || readOnly) return <span>{value}</span>;
        const overdrawn = row.overdraft > 0;

        // Choose at most one pill — overdraft is implied visually by
        // the red number + octagon, so we suppress the "Hard" pill when
        // an overdraft is present to avoid double-flagging.
        let pill: { label: string; cls: string; title: string } | null = null;
        if (row.override_pending) {
          const suffix = row.override_mode === "hard" ? " · Hard" : "";
          pill = {
            label: `Pending${suffix}`,
            cls: "bg-slate-500/20 text-slate-300",
            title: "Override hasn't been applied yet — re-run allocations.",
          };
        } else if (row.source === "manual_override" && !row.has_override) {
          pill = {
            label: "Pending update",
            cls: "bg-slate-500/20 text-slate-300",
            title: "Manual change was removed. Re-run allocations to refresh.",
          };
        } else if (row.has_override && row.override_mode === "hard" && !overdrawn) {
          pill = {
            label: "Hard",
            cls: "bg-rose-500/20 text-rose-300",
            title: "Hard manual override.",
          };
        } else if (row.has_override) {
          pill = {
            label: "Manual",
            cls: "bg-amber-500/20 text-amber-300",
            title: "Manual override.",
          };
        }

        const numberCls = overdrawn
          ? "inline-flex items-center gap-1 font-semibold text-red-400 hover:text-red-300"
          : "underline decoration-dotted decoration-slate-500 underline-offset-4 hover:text-cyan-300 hover:decoration-cyan-300";

        return (
          <button
            type="button"
            onClick={() => openOverrideFor(row)}
            title={
              overdrawn
                ? `This is ${row.overdraft} more than the factory has. Click to edit.`
                : "Click to set a manual amount"
            }
            className="w-full h-full inline-flex items-center gap-2 text-left cursor-pointer"
          >
            {pill && (
              <span
                title={pill.title}
                className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ${pill.cls}`}
              >
                {pill.label}
              </span>
            )}
            <span className={numberCls}>
              {overdrawn && (
                <svg
                  viewBox="0 0 24 24"
                  className="h-3 w-3 text-red-400"
                  aria-hidden="true"
                >
                  <polygon
                    points="7,2 17,2 22,7 22,17 17,22 7,22 2,17 2,7"
                    fill="currentColor"
                  />
                </svg>
              )}
              {value}
            </span>
          </button>
        );
      },
    },
    { headerName: "Factory", field: "factory_name", sortable: true, filter: true, width: 150 },
    {
      headerName: "Deficit",
      field: "shortfall",
      sortable: true,
      filter: true,
      width: 110,
      headerTooltip:
        "How short the factory is on this item. Red means the store will get less. Rose means the factory needs to make up the difference before delivery.",
      // shortfall: factory couldn't fulfill → store gets less (soft / no override)
      // overdraft: factory was forced past stock → factory ate the deficit (hard override)
      cellRenderer: (params: ICellRendererParams<AllocationRow>) => {
        const row = params.data;
        if (!row) return null;
        const { shortfall, overdraft } = row;
        if (overdraft > 0) {
          return (
            <span
              className="font-semibold text-rose-300"
              title={`Factory is ${overdraft} short on this item. Bake more before delivery.`}
            >
              {overdraft}
            </span>
          );
        }
        if (shortfall > 0) {
          return (
            <span className="font-semibold text-rose-300">{shortfall}</span>
          );
        }
        return <span className="text-emerald-400">0</span>;
      },
    },
    {
      headerName: "Reason",
      field: "override_reason",
      sortable: false,
      filter: true,
      flex: 1,
      minWidth: 140,
      valueFormatter: (p) => (p.value as string | null) ?? "",
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-slate-400">
          Click <strong>Run allocations</strong> to calculate how much each
          store gets. Tap any <strong>Qty</strong> to set a manual amount
          for that store + item. When the order is delivered, mark it
          under Deliveries.
        </p>
        <button
          onClick={runAllocations}
          disabled={running || isDelivered}
          className="shrink-0 px-4 py-2 bg-emerald-500 text-slate-950 rounded-full font-semibold disabled:opacity-50"
          title={isDelivered ? "This cycle is already delivered." : undefined}
        >
          {running ? "Running..." : pendingRerun ? "Re-run allocations" : "Run allocations"}
        </button>
      </div>

      {pendingRerun && !running && !isDelivered && (
        <div className="rounded-2xl bg-amber-950/60 border border-amber-500/30 px-4 py-3 text-sm text-amber-200">
          Manual changes haven&apos;t been applied yet. Click{" "}
          <strong>Re-run allocations</strong> to update.
        </div>
      )}

      {totals.overdraft > 0 && (
        <div className="rounded-2xl bg-rose-950/60 border border-rose-500/40 px-4 py-3 text-sm text-rose-100 flex items-start gap-3">
          <span className="text-lg leading-none">⚠</span>
          <div className="space-y-1">
            <div className="font-semibold text-rose-200">
              {totals.overdraft} unit{totals.overdraft === 1 ? "" : "s"}{" "}
              across {totals.overdraftItemCount} item
              {totals.overdraftItemCount === 1 ? "" : "s"} will be short
              at the factory.
            </div>
            <div className="text-rose-200/80">
              Stores will still get their full amount, so the factory
              needs to bake more before delivery. Look for the red{" "}
              <strong>Qty</strong> cells marked with an octagon.
            </div>
          </div>
        </div>
      )}

      {showForm && !readOnly && (
        <form onSubmit={handleOverrideSubmit} className="rounded-2xl bg-slate-950/60 p-6 space-y-4">
          <h3 className="text-lg font-semibold text-white">
            {editingKey ? "Edit Override" : "Add Override"}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-slate-300">Store</label>
              <select
                value={storeId}
                onChange={(e) => patchDraft({ storeId: e.target.value })}
                disabled
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
                onChange={(e) => patchDraft({ itemId: e.target.value })}
                disabled
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
                onChange={(e) => patchDraft({ qty: e.target.value })}
                className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300">Reason</label>
              <input
                type="text"
                value={reason}
                onChange={(e) => patchDraft({ reason: e.target.value })}
                className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300">Mode</label>
            <div className="mt-1 inline-flex rounded-full border border-white/10 bg-slate-950 p-1">
              <button
                type="button"
                onClick={() => patchDraft({ mode: "soft" })}
                className={`px-4 py-1.5 text-xs font-semibold rounded-full transition ${
                  mode === "soft"
                    ? "bg-amber-500/20 text-amber-300"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                Soft
              </button>
              <button
                type="button"
                onClick={() => patchDraft({ mode: "hard" })}
                className={`px-4 py-1.5 text-xs font-semibold rounded-full transition ${
                  mode === "hard"
                    ? "bg-rose-500/20 text-rose-300"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                Hard
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              {mode === "soft"
                ? "Send this amount, but only if the factory has enough. If short, the store gets less."
                : "Send this amount no matter what. The factory will need to bake more if short."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={formLoading}
              className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
            >
              {formLoading ? "Saving..." : editingKey ? "Update" : "Save override"}
            </button>
            <button
              type="button"
              onClick={() => setOverrideDraft(emptyOverrideDraft)}
              className="px-4 py-2 bg-slate-600 text-white rounded-full"
            >
              Cancel
            </button>
            {editingKey && (
              <button
                type="button"
                onClick={handleDeleteOverride}
                disabled={formLoading}
                className="ml-auto px-4 py-2 bg-rose-500/80 text-white rounded-full font-semibold hover:bg-rose-500 disabled:opacity-50"
              >
                Delete override
              </button>
            )}
          </div>
        </form>
      )}

      {message && (
        <div
          className={`rounded-2xl p-3 text-sm ${
            message.startsWith("Error") ? "bg-rose-950/80 text-rose-200" : "bg-green-950/80 text-green-200"
          }`}
        >
          {message}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4 text-xs">
        <FilterGroup
          label="Source"
          value={sourceFilter}
          onChange={setSourceFilter}
          options={[
            { value: "all", label: "All" },
            { value: "factory", label: "Factory" },
            { value: "purchase", label: "Purchase" },
            { value: "manual", label: "Manual Override" },
            { value: "hard", label: "Manual Override · Hard" },
          ]}
        />
        <FilterGroup
          label="Deficit"
          value={deficitFilter}
          onChange={setDeficitFilter}
          options={[
            { value: "all", label: "All" },
            { value: "any", label: "Has deficit" },
            { value: "hard", label: "Hard only" },
          ]}
        />
      </div>

      <div style={{ height: 440 }}>
        <AgGridReact<AllocationRow>
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: true, filter: true, minWidth: 80 }}
          isExternalFilterPresent={isExternalFilterPresent}
          doesExternalFilterPass={doesExternalFilterPass}
          onGridReady={(params: GridReadyEvent<AllocationRow>) => {
            gridApiRef.current = params.api;
          }}
        />
      </div>
    </div>
  );
}

function FilterGroup<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-slate-400 mr-1">{label}:</span>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={
            "rounded-full border px-2.5 py-0.5 text-xs font-medium transition " +
            (value === opt.value
              ? "border-cyan-400/60 bg-cyan-500/15 text-cyan-200"
              : "border-white/10 text-slate-400 hover:border-white/30 hover:text-slate-200")
          }
        >
          {opt.label}
        </button>
      ))}
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
  type: string;
  sub_category: string;
  item_name: string;
  total: number;
  [storeName: string]: string | number;
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
  const [marking, setMarking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const { data } = await supabase
      .from("allocations")
      .select(
        "cycle_id,store_id,item_id,qty,factory_id,stores(name),items(name,type,sub_category)",
      )
      .eq("cycle_id", cycleId);
    if (data) setAllocations(data as unknown as DeliveryAllocation[]);
  }, [cycleId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useRealtimeRefetch(
    [{ table: "allocations", filter: `cycle_id=eq.${cycleId}` }],
    reload,
    `cycle-${cycleId}-deliveries`,
  );

  const { storeNames, deliveryRows } = useMemo(() => {
    const positive = allocations.filter((a) => a.qty > 0);
    const stores = new Set<string>();
    type ItemAcc = {
      type: string;
      sub_category: string;
      item_name: string;
      perStore: Map<string, number>;
    };
    const items = new Map<string, ItemAcc>();

    positive.forEach((a) => {
      const storeName = a.stores?.name ?? a.store_id;
      const itemName = a.items?.name ?? a.item_id;
      const type = titleCaseDelivery(a.items?.type ?? "uncategorized");
      const sub = a.items?.sub_category ?? "Uncategorized";
      stores.add(storeName);

      if (!items.has(a.item_id)) {
        items.set(a.item_id, {
          type,
          sub_category: sub,
          item_name: itemName,
          perStore: new Map(),
        });
      }
      const acc = items.get(a.item_id)!;
      acc.perStore.set(storeName, (acc.perStore.get(storeName) ?? 0) + a.qty);
    });

    const sortedStores = Array.from(stores).sort((x, y) => x.localeCompare(y));
    const sortedItems = Array.from(items.values()).sort((x, y) => {
      const t = x.type.localeCompare(y.type);
      if (t !== 0) return t;
      const s = x.sub_category.localeCompare(y.sub_category);
      if (s !== 0) return s;
      return x.item_name.localeCompare(y.item_name);
    });
    const rows: DeliveryRow[] = sortedItems.map((acc) => {
      const row: DeliveryRow = {
        type: acc.type,
        sub_category: acc.sub_category,
        item_name: acc.item_name,
        total: 0,
      };
      let total = 0;
      sortedStores.forEach((s) => {
        const qty = acc.perStore.get(s) ?? 0;
        row[s] = qty;
        total += qty;
      });
      row.total = total;
      return row;
    });

    return { storeNames: sortedStores, deliveryRows: rows };
  }, [allocations]);

  const totalUnits = useMemo(
    () => deliveryRows.reduce((sum, r) => sum + r.total, 0),
    [deliveryRows],
  );
  const storeCount = storeNames.length;

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
      ...storeNames.map<ColDef<DeliveryRow>>((s) => ({
        headerName: s,
        field: s,
        width: 110,
        valueFormatter: dimZeros,
        cellStyle: numericCellStyle,
        cellClass: cellClassZero,
      })),
    ];
  }, [storeNames]);

  const isAllocated = cycleStatus === "allocated";
  const isDelivered = cycleStatus === "delivered";
  const hasOrderDate = !!cycleOrderDate;
  const canMarkDelivered = isAllocated && hasOrderDate && !isDelivered;
  const markDeliveredTitle = isDelivered
    ? "Already delivered."
    : !isAllocated
      ? "Run allocations first."
      : !hasOrderDate
        ? "Set an order date first."
        : undefined;

  const cycleDateLabel = formatLocalDate(cycleOrderDate, "Not set");

  const markDelivered = async () => {
    if (!canMarkDelivered) return;
    if (
      !confirm(
        `Mark the ${cycleDateLabel} cycle as delivered? It will be locked from further changes.`,
      )
    ) {
      return;
    }
    setMarking(true);
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
      setMarking(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-400">
          {deliveryRows.length === 0 ? (
            "Run allocations first to see what to load."
          ) : (
            <>
              {deliveryRows.length} items · {storeCount} {storeCount === 1 ? "store" : "stores"} · {totalUnits} total units
            </>
          )}
        </div>
        <button
          type="button"
          onClick={markDelivered}
          disabled={!canMarkDelivered || marking}
          title={markDeliveredTitle}
          className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {marking ? "Marking..." : isDelivered ? "Delivered ✓" : "Mark delivered"}
        </button>
      </div>

      {message && <p className="text-sm text-cyan-300">{message}</p>}

      {/* Always render the grid container so switching to this tab doesn't
          cause a height-shift / scroll jump while allocations are still
          loading. AG Grid shows its own "No rows" placeholder when the
          rowData array is empty. */}
      <div style={{ height: 480 }}>
        <AgGridReact
          rowData={deliveryRows}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: true, filter: true, minWidth: 80 }}
        />
      </div>
    </div>
  );
}
