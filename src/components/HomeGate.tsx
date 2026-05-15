"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import SupabaseAuth from "./SupabaseAuth";
import HomeAdminLinks from "./HomeAdminLinks";
import StorePicker from "./StorePicker";

const REQUESTS_LAST_SEEN_KEY = "lm-requests-last-seen";

function todayLocalDate(): string {
  // YYYY-MM-DD in the user's local timezone. Used to compare against
  // bake_for_date (a `date` column) without timezone-shift surprises.
  const d = new Date();
  const tzOffsetMs = d.getTimezoneOffset() * 60 * 1000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 10);
}

function startOfTodayIso(): string {
  // Local midnight as an ISO timestamp, for ranging timestamptz columns
  // ("did anything happen today" queries).
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export default function HomeGate() {
  const { session, profile, loading: authLoading } = useAuthGate();

  // Per-employee daily alerts shown as ⚠ on the home-page buttons. Each is
  // computed independently; if a query fails the flag stays false and the
  // button just renders without the icon.
  const [tempLogAlert, setTempLogAlert] = useState(false);
  const [bakeAlert, setBakeAlert] = useState(false);
  const [stockEntryAlert, setStockEntryAlert] = useState(false);
  const [requestsAlert, setRequestsAlert] = useState(false);

  useEffect(() => {
    // Alerts only apply to Employees with an assigned store. Store
    // Managers manage these features across stores and don't get nagged.
    if (profile?.role !== "employee" || !profile?.store_id) {
      setTempLogAlert(false);
      setBakeAlert(false);
      setStockEntryAlert(false);
      setRequestsAlert(false);
      return;
    }
    const storeId = profile.store_id;
    const startIso = startOfTodayIso();
    const todayDate = todayLocalDate();
    let alive = true;

    // Temperature Log: alert if any fridge for this store has no reading
    // recorded today. No fridges → no alert (nothing to check).
    (async () => {
      const [fridgesRes, readingsRes] = await Promise.all([
        supabase.from("store_fridges").select("id").eq("store_id", storeId),
        supabase
          .from("temperature_log_entries")
          .select("fridge_id")
          .eq("store_id", storeId)
          .gte("recorded_at", startIso),
      ]);
      if (!alive) return;
      const fridges = (fridgesRes.data as { id: string }[] | null) ?? [];
      if (fridges.length === 0) {
        setTempLogAlert(false);
        return;
      }
      const readToday = new Set(
        ((readingsRes.data as { fridge_id: string }[] | null) ?? []).map((r) => r.fridge_id),
      );
      setTempLogAlert(fridges.some((f) => !readToday.has(f.id)));
    })();

    // Bake Schedule: alert if the saved sheet is for today AND has any
    // line that isn't fully baked yet. A sheet for tomorrow (filled by
    // closing employee in advance) or no sheet at all doesn't alert.
    (async () => {
      const { data: sheet } = await supabase
        .from("bake_sheets")
        .select("id,bake_for_date")
        .eq("store_id", storeId)
        .maybeSingle();
      if (!alive) return;
      const sheetRow = sheet as { id: string; bake_for_date: string } | null;
      if (!sheetRow || sheetRow.bake_for_date !== todayDate) {
        setBakeAlert(false);
        return;
      }
      const { data: lines } = await supabase
        .from("bake_sheet_lines")
        .select("bake_qty,baked_qty")
        .eq("bake_sheet_id", sheetRow.id);
      if (!alive) return;
      const rows = (lines as { bake_qty: number; baked_qty: number }[] | null) ?? [];
      const incomplete = rows.some((l) => (l.bake_qty ?? 0) > (l.baked_qty ?? 0));
      setBakeAlert(incomplete);
    })();

    // Store Stock Entry: alert if any non-delivered cycle has this store
    // participating and `finished_at` is null (meaning the store hasn't
    // marked itself done for that cycle).
    (async () => {
      const { data } = await supabase
        .from("cycle_stores")
        .select("cycle_id,finished_at,order_cycles!inner(status)")
        .eq("store_id", storeId)
        .is("finished_at", null);
      if (!alive) return;
      type Row = { cycle_id: string; finished_at: string | null; order_cycles: { status: string } | { status: string }[] | null };
      const rows = (data as Row[] | null) ?? [];
      const unfinished = rows.some((r) => {
        const oc = Array.isArray(r.order_cycles) ? r.order_cycles[0] : r.order_cycles;
        return oc && oc.status !== "delivered";
      });
      setStockEntryAlert(unfinished);
    })();

    return () => {
      alive = false;
    };
  }, [profile?.role, profile?.store_id]);

  // Requests & Issues: alert if any request for this store has updated_at
  // greater than the locally-stored last-seen timestamp. `updated_at` bumps
  // on status changes and new comments via the touch_employee_request
  // trigger. When lastSeen is missing (fresh browser, never visited
  // /requests) we treat everything as unseen. Split out from the other
  // alert checks so we can subscribe to realtime changes and update the
  // badge without a page refresh when HQ replies.
  const loadRequestsAlert = useCallback(async () => {
    if (profile?.role !== "employee" || !profile?.store_id) {
      setRequestsAlert(false);
      return;
    }
    const lastSeen =
      (typeof window !== "undefined" ? localStorage.getItem(REQUESTS_LAST_SEEN_KEY) : null) ??
      "1970-01-01T00:00:00Z";
    const { data } = await supabase
      .from("employee_requests")
      .select("id")
      .eq("store_id", profile.store_id)
      .gt("updated_at", lastSeen)
      .limit(1);
    setRequestsAlert(((data as unknown[]) ?? []).length > 0);
  }, [profile?.role, profile?.store_id]);

  useEffect(() => {
    loadRequestsAlert();
  }, [loadRequestsAlert]);

  useRealtimeRefetch(
    profile?.role === "employee" && profile?.store_id
      ? [
          { table: "employee_requests" },
          { table: "employee_request_comments" },
        ]
      : [],
    loadRequestsAlert,
    "home-employee-requests-alert",
  );

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-50">
        <main className="flex min-h-screen items-center justify-center px-6">
          <p className="text-slate-400">Loading…</p>
        </main>
      </div>
    );
  }

  if (!session?.user) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-50">
        <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
          <div className="space-y-3 text-center">
            <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Las Muns
            </h1>
            <p className="text-sm text-slate-400">Sign in to continue.</p>
          </div>
          <div className="mt-8">
            <SupabaseAuth />
          </div>
        </main>
      </div>
    );
  }

  // Alert decoration applied to home-page buttons when their alert flag is
  // true: a bold rose badge icon up front + a pulsing rose ring around the
  // whole pill. Designed to be hard to miss across the room.
  const alertBadge = (
    <span
      className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-600 text-xs font-bold text-white shadow-md shadow-rose-500/50"
      aria-label="Needs attention"
    >
      !
    </span>
  );
  const alertRing =
    " ring-2 ring-rose-400 ring-offset-2 ring-offset-slate-900 animate-pulse";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      <main className="mx-auto flex min-h-screen max-w-6xl flex-col justify-center px-6 py-16 sm:px-10">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div className="rounded-3xl border border-white/10 bg-slate-900/80 p-10 shadow-2xl shadow-slate-950/40 backdrop-blur-xl">
            <div className="flex flex-col gap-6">
              <div className="space-y-3">
                <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                  Las Muns
                </h1>
                <StorePicker />
              </div>

              <div className="space-y-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Ordering</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Link
                      href="/store-stock-entry"
                      className={`inline-flex items-center justify-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-slate-200${stockEntryAlert ? alertRing : ""}`}
                    >
                      {stockEntryAlert && alertBadge}Order Sheet
                    </Link>
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Logs</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Link
                      href="/logs/temperature"
                      className={`inline-flex items-center justify-center gap-2 rounded-full bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-400${tempLogAlert ? alertRing : ""}`}
                    >
                      {tempLogAlert && alertBadge}Temperature Log
                    </Link>
                    <Link
                      href="/logs/waste"
                      className="inline-flex items-center justify-center rounded-full bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-400"
                    >
                      Waste Log
                    </Link>
                    <Link
                      href="/logs/box-trace"
                      className="inline-flex items-center justify-center rounded-full bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-400"
                    >
                      Box Trace Log
                    </Link>
                    <Link
                      href="/logs/bake-schedule"
                      className={`inline-flex items-center justify-center gap-2 rounded-full bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-400${bakeAlert ? alertRing : ""}`}
                    >
                      {bakeAlert && alertBadge}Bake Schedule
                    </Link>
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Support</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Link
                      href="/training"
                      className="inline-flex items-center justify-center rounded-full bg-purple-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-purple-400"
                    >
                      Training &amp; Documentation
                    </Link>
                    <Link
                      href="/requests"
                      className={`inline-flex items-center justify-center gap-2 rounded-full bg-purple-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-purple-400${requestsAlert ? alertRing : ""}`}
                    >
                      {requestsAlert && alertBadge}Requests &amp; Issues
                    </Link>
                  </div>
                </div>

                <HomeAdminLinks />
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <SupabaseAuth />
          </div>
        </div>
      </main>
    </div>
  );
}
