"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

// Cache key bumped to v2 after the role-vocabulary rename — old localStorage
// values like "hq_admin" / "store_manager" (worker) no longer map to the new
// enum values, so we throw the old cache away and re-fetch.
const ROLE_CACHE_KEY = "lm-cached-role-v2";
// Mirrors the EmployeeRequests "last seen" key but scoped to the Store
// Manager's view of /admin/requests. Bumped on mount + unmount of that page.
const ADMIN_REQUESTS_LAST_SEEN_KEY = "lm-admin-requests-last-seen";

export default function HomeAdminLinks() {
  const [isStoreManager, setIsStoreManager] = useState(false);
  const [alertCount, setAlertCount] = useState(0);
  const [requestsAlertCount, setRequestsAlertCount] = useState(0);

  useEffect(() => {
    const cached = localStorage.getItem(ROLE_CACHE_KEY);
    if (cached === "store_manager") setIsStoreManager(true);

    let active = true;

    const refresh = async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData.session?.user?.id;
      if (!userId) {
        if (active) setIsStoreManager(false);
        localStorage.removeItem(ROLE_CACHE_KEY);
        return;
      }
      const { data } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", userId)
        .single();
      const role = data?.role ?? "";
      if (active) setIsStoreManager(role === "store_manager");
      if (role) localStorage.setItem(ROLE_CACHE_KEY, role);
      else localStorage.removeItem(ROLE_CACHE_KEY);
    };

    refresh();

    const { data: listener } = supabase.auth.onAuthStateChange(() => {
      refresh();
    });

    return () => {
      active = false;
      listener?.subscription.unsubscribe();
    };
  }, []);

  const loadAlertCount = useCallback(async () => {
    if (!isStoreManager) {
      setAlertCount(0);
      return;
    }
    // is_active_alert handles the drift/spike thresholds AND the resolution
    // status in one boolean — see migration 20260512170000_fridge_alert_resolution.sql.
    const { count, error } = await supabase
      .from("fridge_alerts")
      .select("fridge_id", { count: "exact", head: true })
      .eq("is_active_alert", true);
    if (error) {
      setAlertCount(0);
      return;
    }
    setAlertCount(count ?? 0);
  }, [isStoreManager]);

  useEffect(() => {
    loadAlertCount();
  }, [loadAlertCount]);

  // Refresh the badge whenever a reading or fridge config changes anywhere —
  // matches the admin dashboard's realtime behaviour so the dot updates
  // without a page reload.
  useRealtimeRefetch(
    isStoreManager
      ? [
          { table: "temperature_log_entries" },
          { table: "store_fridges" },
        ]
      : [],
    loadAlertCount,
    `home-temp-alert-badge`,
  );

  // Employee Requests alert: counts every request whose updated_at has
  // moved past the timestamp this Store Manager last "saw" the requests
  // page. updated_at bumps on new submissions, status changes, and new
  // comments via the touch_employee_request trigger. When lastSeen is
  // missing (fresh browser, never visited /admin/requests) we treat
  // everything as unseen so the badge still shows up.
  const loadRequestsAlertCount = useCallback(async () => {
    if (!isStoreManager) {
      setRequestsAlertCount(0);
      return;
    }
    const lastSeen =
      (typeof window !== "undefined"
        ? localStorage.getItem(ADMIN_REQUESTS_LAST_SEEN_KEY)
        : null) ?? "1970-01-01T00:00:00Z";
    const { count, error } = await supabase
      .from("employee_requests")
      .select("id", { count: "exact", head: true })
      .gt("updated_at", lastSeen);
    if (error) {
      setRequestsAlertCount(0);
      return;
    }
    setRequestsAlertCount(count ?? 0);
  }, [isStoreManager]);

  useEffect(() => {
    loadRequestsAlertCount();
  }, [loadRequestsAlertCount]);

  useRealtimeRefetch(
    isStoreManager
      ? [
          { table: "employee_requests" },
          { table: "employee_request_comments" },
        ]
      : [],
    loadRequestsAlertCount,
    `home-requests-alert-badge`,
  );

  if (!isStoreManager) return null;

  return (
    <>
      <AdminSection title="Daily Reviews">
        <AdminLink
          href="/admin/temperature-alerts"
          alert={alertCount > 0}
          alertBadge={
            alertCount > 0 ? (
              <>
                <span aria-label={`${alertCount} alert${alertCount === 1 ? "" : "s"}`}>⚠</span>
                <span className="ml-1 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-slate-950/30 px-1.5 text-xs font-bold">
                  {alertCount}
                </span>
              </>
            ) : null
          }
        >
          Temperature Alerts
        </AdminLink>
        <AdminLink
          href="/admin/requests"
          alert={requestsAlertCount > 0}
          alertBadge={
            requestsAlertCount > 0 ? (
              <>
                <span aria-label={`${requestsAlertCount} new`}>⚠</span>
                <span className="ml-1 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-slate-950/30 px-1.5 text-xs font-bold">
                  {requestsAlertCount}
                </span>
              </>
            ) : null
          }
        >
          Employee Requests
        </AdminLink>
        <AdminLink href="/admin/waste-analytics">Waste Analytics</AdminLink>
      </AdminSection>

      <AdminSection title="Order Cycle">
        <AdminLink href="/admin/cycles">Cycles</AdminLink>
        <AdminLink href="/factory-stock">Factory Stock</AdminLink>
      </AdminSection>

      <AdminSection title="Configuration">
        <AdminLink href="/admin/directory">Directory</AdminLink>
        <AdminLink href="/admin/items">Items</AdminLink>
        <AdminLink href="/admin/packaging">Packaging</AdminLink>
        <AdminLink href="/admin/bake-expected">Bake Count</AdminLink>
        <AdminLink href="/admin/training">Training Resources</AdminLink>
      </AdminSection>
    </>
  );
}

function AdminSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">{title}</p>
      <div className="mt-2 flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function AdminLink({
  href,
  children,
  alert = false,
  alertBadge = null,
}: {
  href: string;
  children: React.ReactNode;
  alert?: boolean;
  alertBadge?: React.ReactNode;
}) {
  // Unified palette: calm slate for everything by default. Active alert
  // state (Temperature Alerts when fridges are flagged) uses rose with a
  // pulsing ring so it visually breaks the line. No more rainbow.
  return (
    <Link
      href={href}
      className={
        alert
          ? "inline-flex items-center justify-center gap-1.5 rounded-full bg-rose-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-rose-400 ring-2 ring-rose-300 animate-pulse"
          : "inline-flex items-center justify-center rounded-full border border-white/10 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-100 transition hover:border-cyan-300/40 hover:bg-slate-700 hover:text-cyan-200"
      }
    >
      {alertBadge}
      <span className={alertBadge ? "ml-1" : ""}>{children}</span>
    </Link>
  );
}
