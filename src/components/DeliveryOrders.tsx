"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { AgGridReact } from "@/lib/agGrid";
import type { ColDef, ValueFormatterParams, CellClassParams } from "ag-grid-community";

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
};

type Allocation = {
  cycle_id: string;
  store_id: string;
  item_id: string;
  qty: number;
  factory_id: string;
  stores?: {
    name: string;
  };
  items?: {
    name: string;
    type: string;
    sub_category: string | null;
  };
};

type DeliveryRow = {
  type: string;
  sub_category: string;
  item_name: string;
  total: number;
  [storeName: string]: string | number;
};

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function DeliveryOrders() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [cycles, setCycles] = useState<OrderCycle[]>([]);
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [selectedCycleId, setSelectedCycleId] = useState("");
  const [loading, setLoading] = useState(false);
  const [supabaseReady, setSupabaseReady] = useState(true);
  const [marking, setMarking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const isSignedIn = useMemo(() => !!session?.user, [session]);
  const isHQAdmin = useMemo(() => profile?.role === "hq_admin", [profile]);
  const canView = isHQAdmin;

  useEffect(() => {
    if (!supabase.auth || typeof supabase.auth.getSession !== "function") {
      setSupabaseReady(false);
      setSession(null);
      return;
    }

    const loadSession = async () => {
      const { data } = await supabase.auth.getSession();
      setSession(data.session);
    };

    loadSession();

    const { data: listener } = supabase.auth.onAuthStateChange?.((_event, sessionData) => {
      setSession(sessionData ?? null);
    }) || { data: null };

    return () => {
      listener?.subscription?.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!supabaseReady) {
      setProfile(null);
      return;
    }

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
    if (!supabaseReady || !canView) {
      setCycles([]);
      setAllocations([]);
      return;
    }

    const loadDeliveryData = async () => {
      setLoading(true);
      const [cycleResponse, allocationsResponse] = await Promise.all([
        supabase.from("order_cycles").select("id,status,order_date").order("created_at", { ascending: false }).limit(5),
        supabase
          .from("allocations")
          .select("cycle_id,store_id,item_id,qty,factory_id,stores(name),items(name,type,sub_category)")
          .order("cycle_id,store_id,item_id"),
      ]);

      if (cycleResponse.data) {
        setCycles(cycleResponse.data as OrderCycle[]);
      }

      if (allocationsResponse.data) {
        setAllocations(allocationsResponse.data as unknown as Allocation[]);
      }

      setLoading(false);
    };

    loadDeliveryData();
  }, [canView]);

  useEffect(() => {
    if (cycles.length > 0 && !selectedCycleId) {
      setSelectedCycleId(cycles[0].id);
    }
  }, [cycles, selectedCycleId]);

  const { storeNames, deliveryRows } = useMemo(() => {
    const cycleAllocations = allocations.filter(
      (a) => a.cycle_id === selectedCycleId && a.qty > 0,
    );

    const stores = new Set<string>();
    type ItemAcc = {
      type: string;
      sub_category: string;
      item_name: string;
      perStore: Map<string, number>;
    };
    const items = new Map<string, ItemAcc>();

    cycleAllocations.forEach((a) => {
      const storeName = a.stores?.name ?? a.store_id;
      const itemName = a.items?.name ?? a.item_id;
      const type = titleCase(a.items?.type ?? "uncategorized");
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

    const sortedStores = Array.from(stores).sort((a, b) => a.localeCompare(b));
    const sortedItems = Array.from(items.values()).sort((a, b) => {
      const t = a.type.localeCompare(b.type);
      if (t !== 0) return t;
      const s = a.sub_category.localeCompare(b.sub_category);
      if (s !== 0) return s;
      return a.item_name.localeCompare(b.item_name);
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
  }, [allocations, selectedCycleId]);

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

  const selectedCycle = useMemo(
    () => cycles.find((c) => c.id === selectedCycleId),
    [cycles, selectedCycleId],
  );
  const cycleDateLabel = selectedCycle?.order_date
    ? new Date(selectedCycle.order_date).toLocaleDateString()
    : "Not set";
  const isAllocated = selectedCycle?.status === "allocated";
  const isDelivered = selectedCycle?.status === "delivered";
  const hasOrderDate = !!selectedCycle?.order_date;
  const canMarkDelivered = isAllocated && hasOrderDate && !isDelivered;
  const markDeliveredTitle = isDelivered
    ? "Already delivered"
    : !isAllocated
      ? "Run allocations first — Mark delivered is only available once the cycle is in 'allocated' status"
      : !hasOrderDate
        ? "Set the cycle's order date before marking delivered"
        : undefined;

  const markDelivered = async () => {
    if (!selectedCycleId || !canMarkDelivered) return;
    if (
      !confirm(
        `Mark the ${cycleDateLabel} cycle as delivered? This flips the cycle status to 'delivered' and locks it from further changes.`,
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
        body: JSON.stringify({ cycle_id: selectedCycleId }),
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(`Error: ${data.error}`);
      } else {
        setMessage(`✅ ${data.message}`);
        setCycles((prev) =>
          prev.map((c) => (c.id === selectedCycleId ? { ...c, status: "delivered" } : c)),
        );
      }
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally {
      setMarking(false);
    }
  };

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <h1 className="text-3xl font-semibold text-white">Delivery orders</h1>
      <p className="mt-3 text-slate-400">
        Total quantity to load for the selected cycle, with each store's share alongside.
      </p>

      {!supabaseReady ? (
        <div className="mt-8 rounded-2xl bg-rose-950/80 p-6 text-rose-200">
          <p className="font-semibold text-rose-100">Supabase is not configured.</p>
          <p className="mt-2 text-sm text-rose-200">
            Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in your local environment and restart the app.
          </p>
        </div>
      ) : !isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in with Supabase Auth first to access this page.</p>
        </div>
      ) : !isHQAdmin ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to HQ administrators.</p>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-[16rem]">
              <label htmlFor="cycle" className="block text-sm font-medium text-slate-300">
                Order cycle
              </label>
              <select
                id="cycle"
                value={selectedCycleId}
                onChange={(event) => setSelectedCycleId(event.target.value)}
                className="mt-2 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400"
              >
                {cycles.map((cycleOption) => (
                  <option key={cycleOption.id} value={cycleOption.id}>
                    {new Date(cycleOption.order_date).toLocaleDateString()} ({titleCase(cycleOption.status)})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-300">
                Delivery: <span className="text-white">{cycleDateLabel}</span>
              </span>
              <span className="rounded-full bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-300">
                Total units: <span className="text-white">{totalUnits}</span>
              </span>
              <span className="rounded-full bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-300">
                Stores: <span className="text-white">{storeCount}</span>
              </span>
              <button
                onClick={markDelivered}
                disabled={marking || !canMarkDelivered}
                title={markDeliveredTitle}
                className="rounded-full bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
              >
                {marking
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

          <div className="rounded-3xl border border-white/10 bg-slate-900/80 p-5">
            {loading ? (
              <p className="text-slate-400">Loading...</p>
            ) : deliveryRows.length === 0 ? (
              <p className="text-slate-400">No allocations found for this cycle.</p>
            ) : (
              <div style={{ height: 600 }}>
                <AgGridReact
                  rowData={deliveryRows}
                  columnDefs={columnDefs}
                  defaultColDef={{ resizable: true, sortable: true, filter: true, minWidth: 80 }}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
