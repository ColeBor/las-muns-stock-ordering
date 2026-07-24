"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { formatLocalDate, parseLocalDate } from "@/lib/dateOnly";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import { withTimeout } from "@/lib/withTimeout";
import { setUnsaved } from "@/lib/unsavedGuard";
import { AgGridReact } from "@/lib/agGrid";
import type { ColDef, GridApi, ICellRendererParams } from "ag-grid-community";

// Items in these sub_categories are box-traced — their count is
// auto-decremented when a freezer box is logged in the Box Trace Log, so
// the worker doesn't need to manually count them end-of-week. Keep in
// sync with the Box Trace Log UI's category dropdown.
const BOX_TRACED_CATEGORIES = ["Empanada", "Dessert"];

// How long an on-device draft of un-submitted counts is kept before it's
// treated as stale and discarded.
const DRAFT_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours
const EMPTY_DRAFT: Record<string, number> = {};

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
    pack_qty: number | null;
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
  pack_qty: number | null;
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

  // --- Durable, self-healing draft of entered counts -------------------------
  // THE reliability fix. The old flow saved each count with a single upsert the
  // instant the worker left a cell; if the session had gone stale (idle tablet,
  // flaky wifi) that write failed and the code REVERTED the cell — the number
  // was gone and nothing ever retried it. Now every typed count lands here
  // first (and in localStorage) and is NEVER discarded on a failed save. A
  // background flusher keeps re-sending anything still pending — refreshing the
  // session each time — so a stale session just delays the write a few seconds
  // instead of losing it.
  const [draft, setDraft] = useState<{ key: string; values: Record<string, number> }>({
    key: "",
    values: {},
  });
  const draftKey = useMemo(
    () =>
      selectedCycleId && effectiveStoreId
        ? `lasmuns.draft.stock-entry.v1.${selectedCycleId}.${effectiveStoreId}`
        : "",
    [selectedCycleId, effectiveStoreId],
  );
  // Only trust draft.values when it belongs to the current (cycle, store).
  const draftValues = draft.key === draftKey ? draft.values : EMPTY_DRAFT;
  const pendingCount = Object.keys(draftValues).length;
  // Mirror for imperative readers (timers, cell styling) outside the render pass.
  const draftRef = useRef<Record<string, number>>(EMPTY_DRAFT);
  useEffect(() => {
    draftRef.current = draftValues;
  }, [draftValues]);
  const gridApiRef = useRef<GridApi<StockEntryRow> | null>(null);

  const setDraftValue = useCallback(
    (itemId: string, count: number | null) => {
      setDraft((prev) => {
        const base = prev.key === draftKey ? prev.values : {};
        const next = { ...base };
        if (count === null) delete next[itemId];
        else next[itemId] = count;
        return { key: draftKey, values: next };
      });
    },
    [draftKey],
  );

  // Load any saved draft when the (cycle, store) selection changes.
  useEffect(() => {
    if (!draftKey) {
      setDraft({ key: "", values: {} });
      return;
    }
    let restored: Record<string, number> = {};
    try {
      const raw = window.localStorage.getItem(draftKey);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          savedAt?: number;
          values?: Record<string, number>;
        };
        if (
          parsed.values &&
          typeof parsed.savedAt === "number" &&
          Date.now() - parsed.savedAt <= DRAFT_MAX_AGE_MS
        ) {
          restored = parsed.values;
        } else {
          window.localStorage.removeItem(draftKey);
        }
      }
    } catch {
      // Corrupt/blocked storage — start clean.
    }
    setDraft({ key: draftKey, values: restored });
  }, [draftKey]);

  // Mirror the draft to localStorage and flag the app's reload guard so
  // auto-recovery never reloads on top of un-submitted counts.
  useEffect(() => {
    if (!draftKey || draft.key !== draftKey) return;
    const has = Object.keys(draft.values).length > 0;
    setUnsaved(draftKey, has);
    try {
      if (has) {
        window.localStorage.setItem(
          draftKey,
          JSON.stringify({ savedAt: Date.now(), values: draft.values }),
        );
      } else {
        window.localStorage.removeItem(draftKey);
      }
    } catch {
      // best-effort
    }
  }, [draft, draftKey]);

  useEffect(() => () => setUnsaved(draftKey, false), [draftKey]);

  // Repaint the "not submitted" cell highlight when the pending set changes.
  useEffect(() => {
    gridApiRef.current?.refreshCells({ force: true });
  }, [draftValues]);

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
    const finishing = !finishedAt;
    const nowIso = finishing ? new Date().toISOString() : null;

    try {
      // FINISH = authoritative submit + verify. Push every count that's still
      // pending, then READ IT BACK and confirm it landed before we ever show
      // "Finished". If anything is still missing we do NOT finish and we name
      // it — nothing is lost, the worker just taps Finish again. This is what
      // makes a green "Finished" actually mean "the database has these numbers"
      // (the old sweep silently wrote nothing and went green anyway).
      if (finishing) {
        const pending = draft.key === draftKey ? draft.values : {};
        const ids = Object.keys(pending);
        if (ids.length > 0) {
          const rows = ids.map((item_id) => ({
            cycle_id: selectedCycleId,
            store_id: effectiveStoreId,
            item_id,
            current_count: pending[item_id],
            entered_by: session?.user?.email ?? session?.user?.id ?? null,
          }));
          const CHUNK = 100;
          for (let i = 0; i < rows.length; i += CHUNK) {
            const slice = rows.slice(i, i + CHUNK);
            let { error } = await withTimeout(
              supabase
                .from("stock_entries")
                .upsert(slice, { onConflict: "cycle_id,store_id,item_id" }),
              "Submitting counts",
            );
            if (error) {
              await supabase.auth.getSession();
              ({ error } = await withTimeout(
                supabase
                  .from("stock_entries")
                  .upsert(slice, { onConflict: "cycle_id,store_id,item_id" }),
                "Submitting counts",
              ));
            }
            if (error) throw new Error(error.message);
          }

          // Verify the write actually landed for every pending item.
          const { data: check, error: checkErr } = await withTimeout(
            supabase
              .from("stock_entries")
              .select("item_id,current_count")
              .eq("cycle_id", selectedCycleId)
              .eq("store_id", effectiveStoreId)
              .in("item_id", ids),
            "Verifying counts",
          );
          if (checkErr) throw new Error(checkErr.message);
          const saved = new Map(
            ((check as Array<{ item_id: string; current_count: number }>) ?? []).map(
              (r) => [r.item_id, r.current_count],
            ),
          );
          const notSaved = ids.filter((id) => saved.get(id) !== pending[id]);
          if (notSaved.length > 0) {
            const names = notSaved
              .map((id) => gridData.find((r) => r.item_id === id)?.item_name ?? id)
              .slice(0, 8);
            setMessage(
              `Couldn't submit ${notSaved.length} item(s): ${names.join(", ")}${
                notSaved.length > names.length ? "…" : ""
              }. Your entries are kept on this device — check the connection and tap Finish again.`,
            );
            return; // stay UN-finished; nothing lost
          }

          // All confirmed — clear the pending draft.
          lastLocalWriteRef.current = Date.now();
          setDraft({ key: draftKey, values: {} });
        }
      }

      const { error } = await withTimeout(
        supabase
          .from("cycle_stores")
          .update({ finished_at: nowIso })
          .eq("cycle_id", selectedCycleId)
          .eq("store_id", effectiveStoreId),
        "Updating status",
      );
      if (error) {
        setMessage(error.message);
        return;
      }
      setFinishedAt(nowIso);
      setMessage(
        finishing
          ? "Finished — all counts submitted and confirmed."
          : "Reopened for editing.",
      );
      if (finishing) void loadEntries();
    } catch (err) {
      setMessage(
        err instanceof Error
          ? `Couldn't finish: ${err.message} Your entries are safe on this device — try again.`
          : "Couldn't finish (network). Your entries are safe on this device — try again.",
      );
    } finally {
      setFinishToggling(false);
    }
  };

  useEffect(() => {
    if (!canManage || !effectiveStoreId) {
      setStore(null);
      setStoreItems([]);
      setEntries([]);
      setGridData([]);
      setPriorEntryItemIds(new Set());
      return;
    }

    const loadStoreData = async () => {
      // stock_entries is fetched lazily once the cycle is selected (see
      // separate effect below) so we don't pull every entry across every
      // cycle for the store. Cycles themselves are loaded by a separate
      // realtime-subscribed effect so a new cycle created by HQ shows up
      // in the dropdown without the worker refreshing.
      const [storeResponse, itemsResponse, priorEntriesResponse] = await Promise.all([
        supabase.from("stores").select("id,name").eq("id", effectiveStoreId).single(),
        supabase
          .from("store_items")
          .select("item_id,is_active,capacity,items(name,sub_category,packaging_type,pack_qty)")
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

  // Cycle dropdown: every active cycle plus at most the 2 most recent
  // delivered ones. Pulled separately and subscribed to realtime so HQ
  // creating a new cycle surfaces immediately for the worker — no
  // refresh needed.
  const cyclesTokenRef = useRef(0);
  const loadCycles = useCallback(async () => {
    if (!canManage) {
      setCycles([]);
      return;
    }
    const myToken = ++cyclesTokenRef.current;
    const [activeRes, deliveredRes] = await Promise.all([
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
    ]);
    if (myToken !== cyclesTokenRef.current) return;
    setCycles([
      ...((activeRes.data as OrderCycle[]) ?? []),
      ...((deliveredRes.data as OrderCycle[]) ?? []),
    ]);
  }, [canManage]);

  useEffect(() => {
    loadCycles();
  }, [loadCycles]);

  useRealtimeRefetch(
    canManage ? [{ table: "order_cycles" }, { table: "cycle_stores" }] : [],
    loadCycles,
    "store-stock-entry-cycles",
  );

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

  // Timestamp of the worker's most recent own write. Each per-cell save fires
  // a realtime event; if we refetch and rebuild gridData in response, AG Grid
  // swaps rowData mid-edit and CANCELS the cell the worker is typing in —
  // which silently drops their count (only cells that commit between rebuilds
  // ever save). Our own writes are already reflected via optimistic local
  // state, so we skip realtime-driven refetches for a few seconds after a
  // local write and only reconcile from the server once they pause.
  const lastLocalWriteRef = useRef(0);
  const reloadFromRealtime = useCallback(async () => {
    if (Date.now() - lastLocalWriteRef.current < 5000) return;
    await loadEntries();
  }, [loadEntries]);

  useRealtimeRefetch(
    selectedCycleId && effectiveStoreId
      ? [
          {
            table: "stock_entries",
            // Scope to THIS store's rows so other stores entering the same
            // cycle don't trigger refetches that rebuild our grid.
            filter: `store_id=eq.${effectiveStoreId}`,
          },
        ]
      : [],
    reloadFromRealtime,
    `store-${effectiveStoreId}-cycle-${selectedCycleId}-entries`,
  );

  // Background flusher: re-send anything still pending until it lands. Runs on a
  // short interval and whenever the tablet regains focus (right when a stale
  // session is most likely — e.g. waking from sleep). It refreshes the session
  // first, then upserts; confirmed items leave the draft, failures stay for the
  // next tick. This is what turns "stale session ate my numbers" into "the
  // numbers show up a few seconds later on their own".
  const flushingRef = useRef(false);
  const flushPending = useCallback(async () => {
    if (!selectedCycleId || !effectiveStoreId || flushingRef.current) return;
    const snapshot = { ...draftRef.current };
    const ids = Object.keys(snapshot);
    if (ids.length === 0) return;
    flushingRef.current = true;
    let anyFlushed = false;
    try {
      // A stale token is the usual reason a count didn't reach the DB — make
      // sure it's live before trying. Bounded so it can't hang.
      try {
        await withTimeout(supabase.auth.getSession(), "Session refresh", 15_000);
      } catch {
        // proceed anyway; the write below is also bounded
      }
      const rows = ids.map((item_id) => ({
        cycle_id: selectedCycleId,
        store_id: effectiveStoreId,
        item_id,
        current_count: snapshot[item_id],
        entered_by: session?.user?.email ?? session?.user?.id ?? null,
      }));
      const CHUNK = 100;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const { error } = await withTimeout(
          supabase
            .from("stock_entries")
            .upsert(slice, { onConflict: "cycle_id,store_id,item_id" }),
          "Saving counts",
        );
        if (error) continue; // leave pending; retry next tick
        anyFlushed = true;
        lastLocalWriteRef.current = Date.now();
        setDraft((prev) => {
          if (prev.key !== draftKey) return prev;
          const next = { ...prev.values };
          for (const r of slice) {
            // Only clear if the worker hasn't re-typed it since our snapshot.
            if (next[r.item_id] === snapshot[r.item_id]) delete next[r.item_id];
          }
          return { key: draftKey, values: next };
        });
      }
    } finally {
      flushingRef.current = false;
    }
    // Pull the now-saved values back so dropping the draft overlay doesn't
    // momentarily reveal the old seeded number.
    if (anyFlushed) void loadEntries();
  }, [selectedCycleId, effectiveStoreId, draftKey, session, loadEntries]);

  useEffect(() => {
    if (!draftKey) return;
    const flush = () => void flushPending();
    const timer = window.setInterval(flush, 20_000);
    window.addEventListener("focus", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [draftKey, flushPending]);

  // Auto-select the "most recent open cycle". We prefer the cycle whose
  // order_date is closest to today AND not delivered AND not more than a
  // year out (so stray test cycles with far-future dates don't trap
  // employees into entering counts on the wrong cycle).
  // If the currently-selected cycle disappears (e.g. HQ deleted a
  // draft), clear the selection so the worker can't keep typing into
  // a cycle that no longer exists (which produced the "permanently
  // saving" hang).
  useEffect(() => {
    if (selectedCycleId && !cycles.some((c) => c.id === selectedCycleId)) {
      setSelectedCycleId("");
    }
  }, [cycles, selectedCycleId]);

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
          // Overlay any un-submitted draft value so a realtime refetch or a
          // reload can't hide what the worker just typed.
          current_count:
            draftValues[storeItem.item_id] ?? existingEntry?.current_count ?? 0,
          is_active: storeItem.is_active,
          has_existing_entry: !!existingEntry,
          sub_category,
          packaging_type: storeItem.items?.packaging_type || null,
          pack_qty: storeItem.items?.pack_qty ?? null,
          needs_calibration,
        };
      });

    // Sort by sub_category for grouping
    gridRows.sort((a, b) => (a.sub_category || "").localeCompare(b.sub_category || ""));

    setGridData(gridRows);
  }, [selectedCycleId, storeItems, entries, effectiveStoreId, priorEntryItemIds, draftValues]);

  const handleCellValueChanged = async (params: any) => {
    if (!selectedCycleId || !effectiveStoreId) return;

    const { data, colDef, newValue, oldValue } = params;
    if (newValue === oldValue) return;
    if (colDef.field !== "current_count") return;

    const countValue = parseInt(newValue, 10);
    if (Number.isNaN(countValue) || countValue < 0) {
      setMessage("Please enter a valid stock count.");
      // Genuinely invalid input — this is the ONLY case we revert the cell.
      params.node.setDataValue(colDef.field, oldValue);
      return;
    }

    // 1) Record it durably BEFORE any network call. From here it cannot be lost:
    //    it's on screen, in the draft, and mirrored to localStorage, and the
    //    background flusher will keep retrying until it reaches the database.
    setDraftValue(data.item_id, countValue);
    setMessage(null);

    // 2) Best-effort immediate save — refresh the session and retry once if the
    //    first attempt fails (the classic stale-session case). On success drop
    //    it from the pending draft; on failure KEEP it (never revert) and let
    //    the flusher take over.
    setLoading(true);
    const payload = {
      cycle_id: selectedCycleId,
      store_id: effectiveStoreId,
      item_id: data.item_id,
      current_count: countValue,
      entered_by: session?.user?.email ?? session?.user?.id,
    };
    try {
      let { error } = await withTimeout(
        supabase
          .from("stock_entries")
          .upsert([payload], { onConflict: "cycle_id,store_id,item_id" }),
        "Saving count",
      );
      if (error) {
        await supabase.auth.getSession();
        ({ error } = await withTimeout(
          supabase
            .from("stock_entries")
            .upsert([payload], { onConflict: "cycle_id,store_id,item_id" }),
          "Saving count",
        ));
      }
      if (error) throw error;

      lastLocalWriteRef.current = Date.now();
      setDraftValue(data.item_id, null);
      setEntries((prev) => {
        const filtered = prev.filter(
          (e) => !(e.cycle_id === selectedCycleId && e.item_id === data.item_id),
        );
        return [
          {
            ...payload,
            entered_at: new Date().toISOString(),
            items: { name: data.item_name },
          },
          ...filtered,
        ];
      });
      setMessage("Saved.");
    } catch {
      // Didn't go through — but it's safe in the draft (shown amber). The
      // flusher keeps retrying, and Finish won't go green until it's really in.
      setMessage("Entered — waiting to sync (kept safe on this device).");
    } finally {
      setLoading(false);
    }
  };

  const columnDefs: ColDef<StockEntryRow>[] = [
    { headerName: "Category", field: "sub_category", sortable: true, filter: true, width: 120 },
    { headerName: "Item", field: "item_name", sortable: true, filter: true, flex: 2, minWidth: 150 },
    {
      headerName: "Packaging",
      colId: "packaging",
      // Combine packaging + pack qty so staff see how much a line is, e.g.
      // "Case ×24". Coke and Fanta both come in "Case" but hold different qtys.
      valueGetter: (p) => {
        const pkg = p.data?.packaging_type;
        const q = p.data?.pack_qty;
        if (pkg && q) return `${pkg} ×${q}`;
        if (pkg) return pkg;
        return q ? `×${q}` : "";
      },
      sortable: true,
      filter: true,
      width: 150,
    },
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
        backgroundColor:
          draftRef.current[params.data?.item_id ?? ""] !== undefined
            ? "#78350f" // amber-900: entered on this device, not yet confirmed saved
            : params.data?.has_existing_entry
              ? "#1f2937"
              : "#374151",
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
                  ? "Submitting…"
                  : finishedAt
                    ? "Finished ✓ — click to reopen"
                    : pendingCount > 0
                      ? `Finish & submit (${pendingCount})`
                      : "Mark as finished"}
              </button>
            )}
          </div>

          {pendingCount > 0 && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              ⚠ {pendingCount} count{pendingCount === 1 ? "" : "s"} entered but not
              yet confirmed in the system. Amber rows are saved on this device and
              are re-sending automatically — they&apos;ll clear once they land. You
              can also tap <strong>Finish &amp; submit</strong> to send them now.
            </div>
          )}

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          <div style={{ height: "calc(100vh - 300px)", minHeight: 500 }}>
            <AgGridReact
              rowData={gridData}
              columnDefs={columnDefs}
              // Match rows by item id so rebuilding rowData after a save does an
              // in-place delta update instead of resetting the grid — this keeps
              // the worker's scroll position instead of jumping to the top.
              getRowId={(p) => p.data.item_id}
              defaultColDef={{
                resizable: true,
                sortable: true,
                filter: true,
                minWidth: 80,
              }}
              onGridReady={(e) => {
                gridApiRef.current = e.api;
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
              <li>Counts save as you go — and are kept safe on this device if the connection drops, then sent automatically</li>
              <li>Amber cells are entered but not yet confirmed saved; they clear on their own once they land</li>
              <li>Only active items for your store are shown</li>
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
