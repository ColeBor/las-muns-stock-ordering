"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Profile = {
  id: string;
  role: string | null;
  store_id: string | null;
  factory_id: string | null;
};

type OrderCycle = {
  id: string;
  name: string;
  status: string;
  order_date: string | null;
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
    sku: string;
    meta_category: string | null;
    sub_category: string | null;
  };
};

type StoreSummary = {
  store_id: string;
  store_name: string;
  order_date: string | null;
  items: { item_id: string; item_name: string; sku: string; qty: number }[];
};

export default function DeliveryOrders() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [cycles, setCycles] = useState<OrderCycle[]>([]);
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [selectedCycleId, setSelectedCycleId] = useState("");
  const [loading, setLoading] = useState(false);
  const [supabaseReady, setSupabaseReady] = useState(true);

  const isSignedIn = useMemo(() => !!session?.user, [session]);
  const isHQAdmin = useMemo(() => profile?.role === "hq_admin", [profile]);
  const canView = isHQAdmin; // Only HQ can view delivery orders

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
        supabase.from("order_cycles").select("id,name,status,order_date").order("started_at", { ascending: false }).limit(5),
        supabase
          .from("allocations")
          .select("cycle_id,store_id,item_id,qty,factory_id,stores(name),items(name,sku,meta_category,sub_category)")
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

  type TotalOrderItem = {
    item_id: string;
    item_name: string;
    sku: string;
    qty: number;
  };

  const totalOrders = useMemo(() => {
    const cycleAllocations = allocations.filter((a) => a.cycle_id === selectedCycleId);
    const metaGroups: Record<string, Record<string, { totalQty: number; items: Record<string, TotalOrderItem> }>> = {};

    cycleAllocations.forEach((allocation) => {
      if (allocation.qty === 0) return;

      const metaCategory = allocation.items?.meta_category ?? "Uncategorized";
      const subCategory = allocation.items?.sub_category ?? "Uncategorized";
      const itemId = allocation.item_id;
      const itemName = allocation.items?.name ?? itemId;
      const itemSku = allocation.items?.sku ?? "";

      metaGroups[metaCategory] ??= {};
      metaGroups[metaCategory][subCategory] ??= { totalQty: 0, items: {} };

      metaGroups[metaCategory][subCategory].totalQty += allocation.qty;
      metaGroups[metaCategory][subCategory].items[itemId] ??= {
        item_id: itemId,
        item_name: itemName,
        sku: itemSku,
        qty: 0,
      };
      metaGroups[metaCategory][subCategory].items[itemId].qty += allocation.qty;
    });

    return Object.entries(metaGroups).map(([metaCategory, subCats]) => ({
      meta_category: metaCategory,
      totalQty: Object.values(subCats).reduce((sum, sub) => sum + sub.totalQty, 0),
      sub_categories: Object.entries(subCats)
        .map(([subCategory, data]) => ({
          sub_category: subCategory,
          totalQty: data.totalQty,
          items: Object.values(data.items),
        }))
        .sort((a, b) => a.sub_category.localeCompare(b.sub_category)),
    }))
      .sort((a, b) => a.meta_category.localeCompare(b.meta_category));
  }, [allocations, selectedCycleId]);

  const storeSummaries = useMemo(() => {
    const cycleAllocations = allocations.filter((a) => a.cycle_id === selectedCycleId);
    const storeMap: { [storeId: string]: StoreSummary } = {};

    // One delivery date per cycle, applied to every store in that cycle.
    const cycleOrderDate =
      cycles.find((c) => c.id === selectedCycleId)?.order_date ?? null;

    cycleAllocations.forEach((allocation) => {
      if (!storeMap[allocation.store_id]) {
        storeMap[allocation.store_id] = {
          store_id: allocation.store_id,
          store_name: allocation.stores?.name ?? allocation.store_id,
          order_date: cycleOrderDate,
          items: [],
        };
      }

      const existingItem = storeMap[allocation.store_id].items.find((i) => i.item_id === allocation.item_id);
      if (existingItem) {
        existingItem.qty += allocation.qty;
      } else {
        storeMap[allocation.store_id].items.push({
          item_id: allocation.item_id,
          item_name: allocation.items?.name ?? allocation.item_id,
          sku: allocation.items?.sku ?? "",
          qty: allocation.qty,
        });
      }
    });

    // Filter out items with 0 quantity and remove empty stores
    const result = Object.values(storeMap).map(store => ({
      ...store,
      items: store.items.filter(item => item.qty > 0),
    })).filter(store => store.items.length > 0);

    return result;
  }, [allocations, cycles, selectedCycleId]);

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <h1 className="text-3xl font-semibold text-white">Delivery orders</h1>
      <p className="mt-3 text-slate-400">
        Total orders summed across all stores, and per-store breakdowns for delivery.
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
        <div className="mt-8 space-y-8">
          <div>
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
                  {cycleOption.name} ({cycleOption.status})
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-8 lg:grid-cols-2">
            <div className="rounded-3xl border border-white/10 bg-slate-900/80 p-6">
              <h2 className="text-xl font-semibold text-white">Total orders to load</h2>
              <p className="mt-1 text-sm text-slate-400">
                Order date:{" "}
                <span className="text-slate-200">
                  {cycles.find((c) => c.id === selectedCycleId)?.order_date
                    ? new Date(cycles.find((c) => c.id === selectedCycleId)!.order_date!).toLocaleDateString()
                    : "Not set"}
                </span>
              </p>
              <div className="mt-4 space-y-3">
                {loading ? (
                  <p className="text-slate-400">Loading...</p>
                ) : totalOrders.length === 0 ? (
                  <p className="text-slate-400">No allocations found for this cycle.</p>
                ) : (
                  totalOrders.map((metaGroup) => (
                    <div key={metaGroup.meta_category} className="space-y-4 rounded-2xl bg-slate-950/80 p-4">
                      <div className="border-b border-slate-800 pb-3">
                        <h3 className="text-lg font-semibold text-white">{metaGroup.meta_category}</h3>
                        <p className="text-sm text-slate-400">Total: {metaGroup.totalQty}</p>
                      </div>
                      <div className="space-y-4">
                        {metaGroup.sub_categories.map((subGroup) => (
                          <div key={subGroup.sub_category} className="rounded-2xl bg-slate-900/80 p-4">
                            <div className="flex items-center justify-between gap-4 border-b border-slate-800 pb-3">
                              <h4 className="text-sm font-semibold text-cyan-300">{subGroup.sub_category}</h4>
                              <p className="text-sm text-slate-400">{subGroup.totalQty}</p>
                            </div>
                            <div className="mt-3 space-y-2">
                              {subGroup.items.map((item) => (
                                <div key={item.item_id} className="flex items-center justify-between gap-4">
                                  <div>
                                    <p className="text-sm text-slate-300">{item.item_name}</p>
                                    <p className="text-xs text-slate-500">{item.sku}</p>
                                  </div>
                                  <p className="text-sm font-semibold text-white">{item.qty}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-3xl border border-white/10 bg-slate-900/80 p-6">
              <h2 className="text-xl font-semibold text-white">Per-store breakdown</h2>
              <div className="mt-4 space-y-4">
                {loading ? (
                  <p className="text-slate-400">Loading...</p>
                ) : storeSummaries.length === 0 ? (
                  <p className="text-slate-400">No store allocations found for this cycle.</p>
                ) : (
                  storeSummaries.map((store) => (
                    <div key={store.store_id} className="rounded-2xl bg-slate-950/80 p-4">
                      <div className="flex items-center justify-between gap-4">
                        <h3 className="text-lg font-semibold text-white">{store.store_name}</h3>
                        <p className="text-sm text-slate-400">
                          Order date: {store.order_date ? new Date(store.order_date).toLocaleDateString() : "Not set"}
                        </p>
                      </div>
                      <div className="mt-3 space-y-2">
                        {store.items.map((item) => (
                          <div key={item.item_id} className="flex items-center justify-between gap-4">
                            <div>
                              <p className="text-sm text-slate-400">{item.item_name}</p>
                              <p className="text-xs text-slate-500">{item.sku}</p>
                            </div>
                            <p className="text-sm font-semibold text-white">{item.qty}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
