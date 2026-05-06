"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Profile = {
  id: string;
  role: string | null;
};

type Cycle = {
  id: string;
  name: string;
  order_date: string | null;
  created_at: string;
};

type Allocation = {
  cycle_id: string;
  qty: number;
  shortfall: number;
};

type CycleStore = { cycle_id: string };
type PurchaseOrder = { cycle_id: string };

type CycleSummary = {
  id: string;
  name: string;
  order_date: string | null;
  created_at: string;
  storeCount: number;
  allocatedTotal: number;
  shortfallTotal: number;
  poCount: number;
};

export default function CycleArchive() {
  const [session, setSession] = useState<Awaited<
    ReturnType<typeof supabase.auth.getSession>
  >["data"]["session"] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [cycleStores, setCycleStores] = useState<CycleStore[]>([]);
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(false);

  const isSignedIn = useMemo(() => !!session?.user, [session]);
  const isHQAdmin = useMemo(() => profile?.role === "hq_admin", [profile]);

  useEffect(() => {
    const loadSession = async () => {
      const { data } = await supabase.auth.getSession();
      setSession(data.session);
    };
    loadSession();
    const { data: listener } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s ?? null);
    });
    return () => listener?.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const loadProfile = async () => {
      if (!session?.user) {
        setProfile(null);
        return;
      }
      const { data } = await supabase
        .from("profiles")
        .select("id,role")
        .eq("id", session.user.id)
        .single();
      setProfile((data as Profile) ?? null);
    };
    loadProfile();
  }, [session]);

  useEffect(() => {
    if (!isHQAdmin) {
      setCycles([]);
      setAllocations([]);
      setCycleStores([]);
      setPos([]);
      return;
    }
    const load = async () => {
      setLoading(true);
      const cyclesRes = await supabase
        .from("order_cycles")
        .select("id,name,order_date,created_at")
        .eq("status", "delivered")
        .order("order_date", { ascending: false, nullsFirst: false });
      const cycleIds = (cyclesRes.data ?? []).map((c) => c.id);
      if (cycleIds.length === 0) {
        setCycles([]);
        setAllocations([]);
        setCycleStores([]);
        setPos([]);
        setLoading(false);
        return;
      }
      const [allocsRes, csRes, posRes] = await Promise.all([
        supabase
          .from("allocations")
          .select("cycle_id,qty,shortfall")
          .in("cycle_id", cycleIds),
        supabase
          .from("cycle_stores")
          .select("cycle_id")
          .in("cycle_id", cycleIds),
        supabase
          .from("purchase_orders")
          .select("cycle_id")
          .in("cycle_id", cycleIds),
      ]);
      setCycles((cyclesRes.data ?? []) as Cycle[]);
      setAllocations((allocsRes.data ?? []) as Allocation[]);
      setCycleStores((csRes.data ?? []) as CycleStore[]);
      setPos((posRes.data ?? []) as PurchaseOrder[]);
      setLoading(false);
    };
    load();
  }, [isHQAdmin]);

  const summaries: CycleSummary[] = useMemo(() => {
    const allocByCycle = new Map<string, { qty: number; shortfall: number }>();
    for (const a of allocations) {
      const e = allocByCycle.get(a.cycle_id) ?? { qty: 0, shortfall: 0 };
      e.qty += a.qty;
      e.shortfall += a.shortfall;
      allocByCycle.set(a.cycle_id, e);
    }
    const storesByCycle = new Map<string, number>();
    for (const cs of cycleStores) {
      storesByCycle.set(cs.cycle_id, (storesByCycle.get(cs.cycle_id) ?? 0) + 1);
    }
    const posByCycle = new Map<string, number>();
    for (const p of pos) {
      posByCycle.set(p.cycle_id, (posByCycle.get(p.cycle_id) ?? 0) + 1);
    }
    return cycles.map((c) => ({
      id: c.id,
      name: c.name,
      order_date: c.order_date,
      created_at: c.created_at,
      storeCount: storesByCycle.get(c.id) ?? 0,
      allocatedTotal: allocByCycle.get(c.id)?.qty ?? 0,
      shortfallTotal: allocByCycle.get(c.id)?.shortfall ?? 0,
      poCount: posByCycle.get(c.id) ?? 0,
    }));
  }, [cycles, allocations, cycleStores, pos]);

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <h1 className="text-3xl font-semibold text-white">Cycle archive</h1>
      <p className="mt-3 text-slate-400">
        Past delivered cycles. Click into one for the full read-only details,
        allocations, and factory counts.
      </p>

      {!isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in to access this page.</p>
        </div>
      ) : !isHQAdmin ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to management.</p>
        </div>
      ) : loading ? (
        <p className="mt-8 text-slate-400">Loading…</p>
      ) : summaries.length === 0 ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>No delivered cycles yet. Mark a cycle delivered to start building history.</p>
        </div>
      ) : (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {summaries.map((s) => (
            <Link
              key={s.id}
              href={`/admin/cycles?cycle=${s.id}`}
              className="rounded-3xl border border-white/10 bg-slate-900/80 p-6 transition hover:border-cyan-300"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-lg font-semibold text-white">{s.name}</h2>
                <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-300">
                  Delivered
                </span>
              </div>
              <p className="mt-2 text-sm text-slate-400">
                Order date:{" "}
                <span className="text-slate-200">
                  {s.order_date
                    ? new Date(s.order_date).toLocaleDateString()
                    : "Not set"}
                </span>
              </p>
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-slate-400">Stores</dt>
                <dd className="text-right text-slate-200">{s.storeCount}</dd>
                <dt className="text-slate-400">Allocated</dt>
                <dd className="text-right text-slate-200">{s.allocatedTotal}</dd>
                <dt className="text-slate-400">Shortfall</dt>
                <dd
                  className={`text-right ${
                    s.shortfallTotal > 0 ? "text-rose-300" : "text-emerald-300"
                  }`}
                >
                  {s.shortfallTotal}
                </dd>
                <dt className="text-slate-400">Purchase orders</dt>
                <dd className="text-right text-slate-200">{s.poCount}</dd>
              </dl>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
