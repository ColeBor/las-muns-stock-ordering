"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { formatLocalDate, parseLocalDate } from "@/lib/dateOnly";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import { AgGridReact } from "@/lib/agGrid";
import type { ColDef, ICellRendererParams } from "ag-grid-community";

// Items in these sub_categories are box-traced — their count is
// auto-decremented when a freezer box is logged in the Box Trace Log, so
// the worker doesn't need to manually count them end-of-week. Keep in
// sync with the Box Trace Log UI's category dropdown.
const BOX_TRACED_CATEGORIES = ["Empanada", "Dessert"];

type Store = {
  id: string;
  name: string;
};

type OrderCycle = {
  id: string;
  status: string;
  order_date: string;
};

type StoreItem = {
  item_id: string;
  is_active: boolean;
  capacity: number;
  items?: {
    name: string;
    sub_category: string | null;
    packaging_type: string | null;
  };
};

type StockEntry = {
  cycle_id: string;
  store_id: string;
  item_id: string;
  current_count: number;
  entered_at: string;
  items?: {
    name: string;
  };
};

type StockEntryRow = {
  item_id: string;
  item_name: string;
  capacity: number;
  current_count: number;
  is_active: boolean;
  has_existing_entry: boolean;
  sub_category: string | null;
  packaging_type: string | null;
  // True when this is a box-traced item the store has never written an
  // entry for in any prior delivered cycle. The worker needs to do a
  // one-time calibration count; after that, traces handle decrements.
  needs_calibration: boolean;
};

export default function StoreStockEntry() {
  const { session, profile, loading: authLoading, isSignedIn, isStoreManager, isEmployee } = useAuthGate();
  const [store, setStore] = useState<Store | null>(null);
  const [allStores, setAllStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState("");
  const [cycles, setCycles] = useState<OrderCycle[]>([]);
  const [storeItems, setStoreItems] = useState<StoreItem[]>([]);
  const [entries, setEntries] = useState<StockEntry[]>([]);
  // Set of item_ids the store has prior delivered-cycle stock_entries
  // for. Used to detect "first cycle ever for this item" → show the
  // CALIBRATE badge on those Auto rows.
  const [priorEntryItemIds, setPriorEntryItemIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedCycleId, setSelectedCycleId] = useState("");
  const [gridData, setGridData] = useState<StockEntryRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [finishedAt, setFinishedAt] = useState<string | null>(null);
  const [finishToggling, setFinishToggling] = useState(false);

  const hasAssignedStore = useMemo(() => !!profile?.store_id, [profile]);
  const effectiveStoreId = useMemo(
    () => (isStoreManager ? selectedStoreId || null : profile?.store_id ?? null),
    [isStoreManager, selectedStoreId, profile?.store_id],
  );
  const canManage = (isEmployee && hasAssignedStore) || (isStoreManager && !!effectiveStoreId);
  const selectedCycle = useMemo(
    () => cycles.find((c) => c.id === selectedCycleId) ?? null,
    [cycles, selectedCycleId],
  );

  useEffect(() => {
    if (!isStoreManager) return;
    const loadStores = async () => {
      const { data } = await supabase.from("stores").select("id,name").order("name");
      if (data) setAllStores(data as Store[]);
    };
    loadStores();
  }, [isStoreManager]);

  // Load this (cycle, store)'s finished_at so we know whether the
  // employee has already marked their stock entry done for this cycle.
  useEffect(() => {
    if (!selectedCycleId || !effectiveStoreId) {
      setFinishedAt(null);
      return;
    }
    const loadFinished = async () => {
      const { data } = await supabase
        .from("cycle_stores")
        .select("finished_at")
        .eq("cycle_id", selectedCycleId)
        .eq("store_id", effectiveStoreId)
        .maybeSingle();
      setFinishedAt(data?.finished_at ?? null);
    };
    loadFinished();
  }, [selectedCycleId, effectiveStoreId]);

  const toggleFinished = async () => {
    if (!selectedCycleId || !effectiveStoreId) return;
    setFinishToggling(true);
    setMessage(null);
    const newValue = finishedAt ? null : new Date().toISOString();

    // When FINISHING, sweep any active grid rows that don't yet have a
    // stock_entries row and write them at their current grid value
    // (typically 0). The per-cell upsert only fires when the value
    // actually changes, so a store with genuine zeros on the default 0
    // cells could mark Finish without saving a single row — invisible to
    // the allocator. Writing the zeros explicitly fixes that.
    if (newValue) {
      const missing = gridData
        .filter((r) => r.is_active && !r.has_existing_entry)
        .map((r) => ({
          cycle_id: selectedCycleId,
          store_id: effectiveStoreId,
          item_id: r.item_id,
          current_count: r.current_count,
          entered_by: session?.user?.email ?? session?.user?.id ?? null,
        }));
      if (missing.length > 0) {
        const { error: upsertErr } = await supabase
          .from("stock_entries")
          .upsert(missing, { onConflict: "cycle_id,store_id,item_id" });
        if (upsertErr) {
          setMessage(upsertErr.message);
          setFinishToggling(false);
          return;
        }
      }
    }

    const { error } = await supabase
      .from("cycle_stores")
      .update({ finished_at: newValue })
      .eq("cycle_id", selectedCycleId)
      .eq("store_id", effectiveStoreId);
    setFinishToggling(false);
    if (error) {
      setMessage(error.message);
      return;
    }
    setFinishedAt(newValue);
    setMessage(newValue ? "Marked as finished." : "Reopened for editing.");
    if (newValue) await loadEntries();
  };

  useEffect(() => {
    if (!canManage || !effectiveStoreId) {
      setStore(null);
      setCycles([]);
      setStoreItems([]);
      setEntries([]);
      setGridData([]);
      setPriorEntryItemIds(new Set());
      return;
    }

    const loadStoreData = async () => {
      // Cycle dropdown shows every active cycle plus at most the 2 most
      // recent delivered ones — store employees don't need a long history,
      // but a couple of recent finished orders are useful for reference.
      // stock_entries is fetched lazily once the cycle is selected (see
      // separate effect below) so we don't pull every entry across every
      // cycle for the store.
      const [
        storeResponse,
        activeCyclesResponse,
        deliveredCyclesResponse,
        itemsResponse,
        priorEntriesResponse,
      ] = await Promise.all([
        supabase.from("stores").select("id,name").eq("id", effectiveStoreId).single(),
        supabase
          .from("order_cycles")
          .select("id,status,order_date")
          .neq("status", "delivered")
          .order("created_at", { ascending: false }),
        supabase
          .from("order_cycles")
          .select("id,status,order_date")
          .eq("status", "delivered")
          .order("created_at", { ascending: false })
          .limit(2),
        supabase
          .from("store_items")
          .select("item_id,is_active,capacity,items(name,sub_category,packaging_type)")
          .eq("store_id", effectiveStoreId)
          .order("item_id"),
        supabase
          .from("stock_entries")
          .select("item_id,order_cycles!inner(status)")
          .eq("store_id", effectiveStoreId)
          .eq("order_cycles.status", "delivered"),
      ]);

      if (storeResponse.data) {
        setStore(storeResponse.data as Store);
      }

      const cycleList = [
        ...((activeCyclesResponse.data as OrderCycle[]) ?? []),
        ...((deliveredCyclesResponse.data as OrderCycle[]) ?? []),
      ];
      setCycles(cycleList);

      if (itemsResponse.data) {
        setStoreItems(itemsResponse.data as unknown as StoreItem[]);
      }

      if (priorEntriesResponse.data) {
        const ids = new Set<string>(
          (priorEntriesResponse.data as Array<{ item_id: string }>).map(
            (e) => e.item_id,
          ),
        );
        setPriorEntryItemIds(ids);
      } else {
        setPriorEntryItemIds(new Set());
      }
    };

    loadStoreData();
  }, [canManage, effectiveStoreId]);

  // Lazy-fetch stock entries scoped to (cycle, store) only — no embed,
  // no cross-cycle data. Refetched whenever the selection changes.
  // Drop stale responses — realtime can fire multiple events per write
  // and the responses can arrive out of order, otherwise letting an
  // older empty result clobber the latest state.
  const entriesTokenRef = useRef(0);
  const loadEntries = useCallback(async () => {
    if (!selectedCycleId || !effectiveStoreId) {
      setEntries([]);
      return;
    }
    const myToken = ++entriesTokenRef.current;
    const { data, error } = await supabase
      .from("stock_entries")
      .select("cycle_id,store_id,item_id,current_count,entered_at")
      .eq("cycle_id", selectedCycleId)
      .eq("store_id", effectiveStoreId);
    if (myToken !== entriesTokenRef.current) return;
    if (error) {
      // eslint-disable-next-line no-console
      console.error("StoreStockEntry loadEntries failed:", error);
    }
    if (data) setEntries(data as StockEntry[]);
  }, [selectedCycleId, effectiveStoreId]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  useRealtimeRefetch(
    selectedCycleId && effectiveStoreId
      ? [
          {
            table: "stock_entries",
            filter: `cycle_id=eq.${selectedCycleId}`,
          },
        ]
      : [],
    loadEntries,
    `store-${effectiveStoreId}-cycle-${selectedCycleId}-entries`,
  );

  // Auto-select the "most recent open cycle". We prefer the cycle whose
  // order_date is closest to today AND not delivered AND not more than a
  // year out (so stray test cycles with far-future dates don't trap
  // employees into entering counts on the wrong cycle).
  useEffect(() => {
    if (cycles.length === 0 || selectedCycleId) return;
    const oneYearOut = new Date();
    oneYearOut.setFullYear(oneYearOut.getFullYear() + 1);
    const now = Date.now();
    const candidates = cycles
      .filter((c) => c.status !== "delivered")
      .filter((c) => {
        const t = parseLocalDate(c.order_date)?.getTime();
        return t !== undefined && t <= oneYearOut.getTime();
      })
      .sort((a, b) => {
        // Smallest absolute distance from today wins.
        const da = Math.abs((parseLocalDate(a.order_date)?.getTime() ?? 0) - now);
        const db = Math.abs((parseLocalDate(b.order_date)?.getTime() ?? 0) - now);
        return da - db;
      });
    const pick = candidates[0] ?? cycles[0];
    setSelectedCycleId(pick.id);
  }, [cycles, selectedCycleId]);

  useEffect(() => {
    if (!selectedCycleId || !effectiveStoreId) {
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
        const sub_category = storeItem.items?.sub_category || null;
        const isBoxTraced =
          !!sub_category && BOX_TRACED_CATEGORIES.includes(sub_category);
        // First cycle ever for this item if no prior delivered cycle has an
        // entry. Worker needs to do a one-time calibration; after that,
        // traces handle decrements.
        const needs_calibration =
          isBoxTraced && !priorEntryItemIds.has(storeItem.item_id);

        return {
          item_id: storeItem.item_id,
          item_name: storeItem.items?.name || storeItem.item_id,
          capacity: storeItem.capacity,
          current_count: existingEntry?.current_count || 0,
          is_active: storeItem.is_active,
          has_existing_entry: !!existingEntry,
          sub_category,
          packaging_type: storeItem.items?.packaging_type || null,
          needs_calibration,
        };
      });

    // Sort by sub_category for grouping
    gridRows.sort((a, b) => (a.sub_category || "").localeCompare(b.sub_category || ""));

    setGridData(gridRows);
  }, [selectedCycleId, storeItems, entries, effectiveStoreId, priorEntryItemIds]);

  const handleCellValueChanged = async (params: any) => {
    if (!selectedCycleId || !effectiveStoreId) return;

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
          store_id: effectiveStoreId,
          item_id: data.item_id,
          current_count: countValue,
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
          items: { name: data.item_name },
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
    { headerName: "Category", field: "sub_category", sortable: true, filter: true, width: 120 },
    { headerName: "Item", field: "item_name", sortable: true, filter: true, flex: 2, minWidth: 150 },
    { headerName: "Packaging", field: "packaging_type", sortable: true, filter: true, width: 130 },
    { headerName: "Capacity", field: "capacity", sortable: true, filter: true, width: 100 },
    {
      headerName: "Current Count",
      field: "current_count",
      sortable: true,
      filter: true,
      width: 175,
      editable: true,
      cellEditor: "agNumberCellEditor",
      cellEditorParams: { min: 0 },
      cellStyle: (params) => ({
        backgroundColor: params.data?.has_existing_entry ? '#1f2937' : '#374151',
      }),
      cellRenderer: (params: ICellRendererParams<StockEntryRow>) => {
        const row = params.data;
        const value = (params.value as number | undefined) ?? 0;
        const isAutoTracked =
          !!row?.sub_category &&
          BOX_TRACED_CATEGORIES.includes(row.sub_category);
        if (!isAutoTracked) return <span>{value}</span>;
        if (row?.needs_calibration) {
          return (
            <span className="flex h-full items-center justify-between gap-2 pr-1">
              <span className="font-medium">{value}</span>
              <span
                className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-300 ring-1 ring-amber-500/30"
                title="First time tracking this — enter your real count once. After that, it'll update on its own."
              >
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                Calibrate
              </span>
            </span>
          );
        }
        return (
          <span className="flex h-full items-center justify-between gap-2 pr-1">
            <span className="font-medium">{value}</span>
            <span
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-300 ring-1 ring-emerald-500/30"
              title="Updates on its own when you log a box. Only edit to fix it (like a damaged box)."
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Auto
            </span>
          </span>
        );
      },
    },
  ];

  const handleSignOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-white">Order Sheet</h1>
          <p className="mt-3 text-slate-400">
            Enter your current counts for items without an{" "}
            <strong className="text-emerald-300">Auto</strong> badge.
            Auto items update on their own as you log boxes in the Box
            Trace Log. Items with a{" "}
            <strong className="text-amber-300">Calibrate</strong>{" "}
            badge need a real count once — after that, they go on Auto.
            Click Finish when done.
          </p>
        </div>
        {isSignedIn && (
          <button
            type="button"
            onClick={handleSignOut}
            className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-slate-200"
          >
            Sign out
          </button>
        )}
      </div>

      {authLoading ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Loading…</p>
        </div>
      ) : !isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in with Supabase Auth first to access this page.</p>
        </div>
      ) : !isEmployee && !isStoreManager ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to Employees and Store Managers.</p>
        </div>
      ) : isEmployee && !hasAssignedStore ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>You are not assigned to a store. Please contact an administrator.</p>
        </div>
      ) : isStoreManager && !selectedStoreId ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300 space-y-3">
          <p>Pick a store to manage:</p>
          <select
            value={selectedStoreId}
            onChange={(event) => setSelectedStoreId(event.target.value)}
            className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm"
          >
            <option value="">(Select a store)</option>
            {allStores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">{store?.name || "Loading..."}</h2>
            </div>
            <div className="flex items-center gap-4">
              {isStoreManager && (
                <>
                  <label htmlFor="store" className="text-sm font-medium text-slate-300">
                    Store:
                  </label>
                  <select
                    id="store"
                    value={selectedStoreId}
                    onChange={(event) => setSelectedStoreId(event.target.value)}
                    className="px-3 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm"
                  >
                    {allStores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
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
                    {formatLocalDate(cycle.order_date)} ({cycle.status.charAt(0).toUpperCase() + cycle.status.slice(1)})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center justify-end gap-4 flex-wrap">
            {selectedCycle?.status !== "delivered" && (
              <button
                type="button"
                onClick={toggleFinished}
                disabled={finishToggling || !selectedCycleId || !effectiveStoreId}
                className={`px-4 py-2 rounded-full font-semibold text-sm disabled:opacity-50 ${
                  finishedAt
                    ? "bg-slate-700 text-slate-200 hover:bg-slate-600"
                    : "bg-emerald-500 text-slate-950 hover:bg-emerald-400"
                }`}
              >
                {finishToggling
                  ? "Saving..."
                  : finishedAt
                    ? "Finished ✓ — click to reopen"
                    : "Mark as finished"}
              </button>
            )}
          </div>

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          <div style={{ height: "calc(100vh - 300px)", minHeight: 500 }}>
            <AgGridReact
              rowData={gridData}
              columnDefs={columnDefs}
              defaultColDef={{
                resizable: true,
                sortable: true,
                filter: true,
                minWidth: 80,
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
