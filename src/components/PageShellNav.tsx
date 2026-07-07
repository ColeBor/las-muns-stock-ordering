"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import BackButton from "./BackButton";
import StorePicker from "./StorePicker";

// Cached role key shared with HomeAdminLinks so we don't double-fetch the
// profile across the layout. See migration 20260513140000_role_terminology_rename.
const ROLE_CACHE_KEY = "lm-cached-role-v2";
const ADMIN_REQUESTS_LAST_SEEN_KEY = "lm-admin-requests-last-seen";
const REQUESTS_LAST_SEEN_KEY = "lm-requests-last-seen";

function todayLocalDate(): string {
  const d = new Date();
  const tzOffsetMs = d.getTimezoneOffset() * 60 * 1000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 10);
}

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

const PILL_CLASS =
  "inline-flex items-center gap-2 rounded-full border border-white/10 bg-slate-900/60 px-4 py-2 text-sm font-medium text-slate-300 transition hover:border-cyan-300 hover:text-cyan-300";

const EMPLOYEE_LINKS: Array<{ href: string; label: string }> = [
  { href: "/store-stock-entry", label: "Order Sheet" },
  { href: "/scheduled-orders", label: "Scheduled Orders" },
  { href: "/logs/temperature", label: "Temperature Log" },
  { href: "/logs/waste", label: "Waste Log" },
  { href: "/logs/box-trace", label: "Box Trace Log" },
  { href: "/logs/bake-schedule", label: "Bake Schedule" },
  { href: "/requests", label: "Requests & Issues" },
  { href: "/training", label: "Training" },
];
// /scheduled-orders intentionally omitted — the Otter-backed feature is inert.

// Mirrors the home-page admin sections so jumping between admin pages
// doesn't require going Home first. Order matches HomeAdminLinks:
// Daily Reviews → Order Cycle → Configuration.
const ADMIN_LINKS: Array<{ href: string; label: string }> = [
  { href: "/admin/temperature-alerts", label: "Temperature Alerts" },
  { href: "/admin/requests", label: "Employee Requests" },
  { href: "/admin/waste-alerts", label: "Waste Alerts" },
  { href: "/admin/waste-analytics", label: "Waste Analytics" },
  { href: "/admin/cycles", label: "Cycles" },
  { href: "/factory-stock", label: "Factory Stock" },
  { href: "/freezer-trace", label: "Freezer Trace" },
  { href: "/admin/directory", label: "Directory" },
  { href: "/admin/items", label: "Items" },
  { href: "/admin/bake-expected", label: "Bake Count" },
  { href: "/admin/training", label: "Training Resources" },
  { href: "/admin/announcements", label: "Announcements" },
];

// Factory Workers' link set.
const FACTORY_LINKS: Array<{ href: string; label: string }> = [
  { href: "/factory-stock", label: "Factory Stock" },
  { href: "/freezer-trace", label: "Freezer Trace" },
  { href: "/factory-bake", label: "Bake Schedule" },
  { href: "/ingredients", label: "Ingredients" },
  { href: "/recipes", label: "Recipes" },
];

export default function PageShellNav() {
  // Hydrate from localStorage so the right link set appears immediately
  // without a profile fetch round-trip; the live fetch below corrects it
  // if the cache is stale.
  const [isStoreManager, setIsStoreManager] = useState<boolean | null>(null);
  const [isFactoryWorker, setIsFactoryWorker] = useState(false);
  const [storeId, setStoreId] = useState<string | null>(null);
  // Admin alerts (counts)
  const [tempAlertCount, setTempAlertCount] = useState(0);
  const [requestsAlertCount, setRequestsAlertCount] = useState(0);
  const [wasteAlertCount, setWasteAlertCount] = useState(0);
  // Employee alerts (flags — mirrors HomeGate)
  const [empStockEntryAlert, setEmpStockEntryAlert] = useState(false);
  const [empTempLogAlert, setEmpTempLogAlert] = useState(false);
  const [empBakeAlert, setEmpBakeAlert] = useState(false);
  const [empRequestsAlert, setEmpRequestsAlert] = useState(false);

  useEffect(() => {
    const cached = typeof window !== "undefined" ? localStorage.getItem(ROLE_CACHE_KEY) : null;
    if (cached === "store_manager") setIsStoreManager(true);
    else if (cached) setIsStoreManager(false);
    setIsFactoryWorker(cached === "factory_worker");

    let alive = true;
    const refresh = async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData.session?.user?.id;
      if (!userId) {
        if (alive) {
          setIsStoreManager(false);
          setIsFactoryWorker(false);
        }
        return;
      }
      const { data } = await supabase
        .from("profiles")
        .select("role,store_id")
        .eq("id", userId)
        .single();
      const role = (data?.role ?? "") as string;
      const sid = (data?.store_id ?? null) as string | null;
      if (alive) {
        setIsStoreManager(role === "store_manager");
        setIsFactoryWorker(role === "factory_worker");
        setStoreId(sid);
      }
      if (role) localStorage.setItem(ROLE_CACHE_KEY, role);
    };
    refresh();
    const { data: listener } = supabase.auth.onAuthStateChange(() => refresh());
    return () => {
      alive = false;
      listener?.subscription.unsubscribe();
    };
  }, []);

  // Alert counts shared with HomeAdminLinks. Same logic, duplicated here so
  // the nav stays informative on every admin page (not just home).
  const loadTempAlertCount = useCallback(async () => {
    if (!isStoreManager) {
      setTempAlertCount(0);
      return;
    }
    const { count, error } = await supabase
      .from("fridge_alerts")
      .select("fridge_id", { count: "exact", head: true })
      .eq("is_active_alert", true);
    if (error) {
      setTempAlertCount(0);
      return;
    }
    setTempAlertCount(count ?? 0);
  }, [isStoreManager]);

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

  const loadWasteAlertCount = useCallback(async () => {
    if (!isStoreManager) {
      setWasteAlertCount(0);
      return;
    }
    const { count, error } = await supabase
      .from("waste_cap_alerts")
      .select("store_id", { count: "exact", head: true })
      .eq("is_active_alert", true);
    if (error) {
      setWasteAlertCount(0);
      return;
    }
    setWasteAlertCount(count ?? 0);
  }, [isStoreManager]);

  useEffect(() => {
    loadTempAlertCount();
  }, [loadTempAlertCount]);
  useEffect(() => {
    loadRequestsAlertCount();
  }, [loadRequestsAlertCount]);
  useEffect(() => {
    loadWasteAlertCount();
  }, [loadWasteAlertCount]);

  useRealtimeRefetch(
    isStoreManager
      ? [
          { table: "temperature_log_entries" },
          { table: "store_fridges" },
        ]
      : [],
    loadTempAlertCount,
    "pageshell-temp-alert-badge",
  );
  useRealtimeRefetch(
    isStoreManager
      ? [
          { table: "employee_requests" },
          { table: "employee_request_comments" },
        ]
      : [],
    loadRequestsAlertCount,
    "pageshell-requests-alert-badge",
  );
  useRealtimeRefetch(
    isStoreManager
      ? [
          { table: "waste_log_entries" },
          { table: "waste_cap_resolutions" },
          { table: "stores" },
          { table: "app_config" },
        ]
      : [],
    loadWasteAlertCount,
    "pageshell-waste-alert-badge",
  );

  // Employee alerts: mirror the four checks from HomeGate so badges show
  // up in the nav strip just like they do on the home page.
  const loadEmployeeAlerts = useCallback(async () => {
    if (isStoreManager !== false || !storeId) {
      setEmpStockEntryAlert(false);
      setEmpTempLogAlert(false);
      setEmpBakeAlert(false);
      setEmpRequestsAlert(false);
      return;
    }
    const startIso = startOfTodayIso();
    const todayDate = todayLocalDate();

    // Temperature Log: any fridge with no reading today.
    (async () => {
      const [fridgesRes, readingsRes] = await Promise.all([
        supabase.from("store_fridges").select("id").eq("store_id", storeId),
        supabase
          .from("temperature_log_entries")
          .select("fridge_id")
          .eq("store_id", storeId)
          .gte("recorded_at", startIso),
      ]);
      const fridges = (fridgesRes.data as { id: string }[] | null) ?? [];
      if (fridges.length === 0) {
        setEmpTempLogAlert(false);
        return;
      }
      const readToday = new Set(
        ((readingsRes.data as { fridge_id: string }[] | null) ?? []).map((r) => r.fridge_id),
      );
      setEmpTempLogAlert(fridges.some((f) => !readToday.has(f.id)));
    })();

    // Bake Schedule: sheet for today exists and has incomplete lines.
    (async () => {
      const { data: sheet } = await supabase
        .from("bake_sheets")
        .select("id,bake_for_date")
        .eq("store_id", storeId)
        .maybeSingle();
      const sheetRow = sheet as { id: string; bake_for_date: string } | null;
      if (!sheetRow || sheetRow.bake_for_date !== todayDate) {
        setEmpBakeAlert(false);
        return;
      }
      const { data: lines } = await supabase
        .from("bake_sheet_lines")
        .select("bake_qty,baked_qty")
        .eq("bake_sheet_id", sheetRow.id);
      const rows = (lines as { bake_qty: number; baked_qty: number }[] | null) ?? [];
      setEmpBakeAlert(rows.some((l) => (l.bake_qty ?? 0) > (l.baked_qty ?? 0)));
    })();

    // Order Sheet: any non-delivered cycle this store hasn't finished.
    (async () => {
      const { data } = await supabase
        .from("cycle_stores")
        .select("cycle_id,finished_at,order_cycles!inner(status)")
        .eq("store_id", storeId)
        .is("finished_at", null);
      type Row = {
        cycle_id: string;
        finished_at: string | null;
        order_cycles: { status: string } | { status: string }[] | null;
      };
      const rows = (data as Row[] | null) ?? [];
      setEmpStockEntryAlert(
        rows.some((r) => {
          const oc = Array.isArray(r.order_cycles) ? r.order_cycles[0] : r.order_cycles;
          return oc && oc.status !== "delivered";
        }),
      );
    })();

    // Requests & Issues: anything updated since the employee last visited.
    // No lastSeen yet (fresh browser) → treat everything as unseen.
    (async () => {
      const lastSeen =
        (typeof window !== "undefined" ? localStorage.getItem(REQUESTS_LAST_SEEN_KEY) : null) ??
        "1970-01-01T00:00:00Z";
      const { data } = await supabase
        .from("employee_requests")
        .select("id")
        .eq("store_id", storeId)
        .gt("updated_at", lastSeen)
        .limit(1);
      setEmpRequestsAlert(((data as unknown[]) ?? []).length > 0);
    })();
  }, [isStoreManager, storeId]);

  useEffect(() => {
    loadEmployeeAlerts();
  }, [loadEmployeeAlerts]);

  useRealtimeRefetch(
    isStoreManager === false && storeId
      ? [
          { table: "temperature_log_entries", filter: `store_id=eq.${storeId}` },
          { table: "store_fridges", filter: `store_id=eq.${storeId}` },
          { table: "bake_sheets", filter: `store_id=eq.${storeId}` },
          { table: "bake_sheet_lines" },
          { table: "cycle_stores", filter: `store_id=eq.${storeId}` },
          { table: "order_cycles" },
          { table: "employee_requests", filter: `store_id=eq.${storeId}` },
          { table: "employee_request_comments" },
        ]
      : [],
    loadEmployeeAlerts,
    `pageshell-employee-alerts-${storeId ?? "none"}`,
  );

  // While role is still resolving, show the employee set as a sensible
  // default — admins will see a brief flash that resolves to the admin set.
  // Also hide the link for the current page so the nav only shows places
  // you can jump TO.
  const pathname = usePathname();
  const links = (
    isFactoryWorker ? FACTORY_LINKS : isStoreManager ? ADMIN_LINKS : EMPLOYEE_LINKS
  ).filter((l) => l.href !== pathname);

  // For admin pages we have a numeric count; for employee pages we only
  // know "needs attention" as a boolean. The render uses `count` when known
  // and falls back to a count-less ⚠ pill when only the flag is set.
  const alertFor = (href: string): { show: boolean; count: number | null } => {
    if (isStoreManager) {
      if (href === "/admin/temperature-alerts")
        return { show: tempAlertCount > 0, count: tempAlertCount };
      if (href === "/admin/requests")
        return { show: requestsAlertCount > 0, count: requestsAlertCount };
      if (href === "/admin/waste-alerts")
        return { show: wasteAlertCount > 0, count: wasteAlertCount };
      return { show: false, count: null };
    }
    if (href === "/store-stock-entry") return { show: empStockEntryAlert, count: null };
    if (href === "/logs/temperature") return { show: empTempLogAlert, count: null };
    if (href === "/logs/bake-schedule") return { show: empBakeAlert, count: null };
    if (href === "/requests") return { show: empRequestsAlert, count: null };
    return { show: false, count: null };
  };

  return (
    <nav className="mb-6 flex flex-wrap items-center gap-2">
      <BackButton />
      <Link href="/" className={PILL_CLASS}>
        <span aria-hidden>⌂</span> Home
      </Link>
      {!isFactoryWorker && <StorePicker />}

      {links.map((l) => {
        const alert = alertFor(l.href);
        if (alert.show) {
          return (
            <Link
              key={l.href}
              href={l.href}
              className="inline-flex items-center gap-1.5 rounded-full bg-rose-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-rose-400 ring-2 ring-rose-300 animate-pulse"
            >
              <span aria-label="Needs attention">⚠</span>
              {alert.count != null && alert.count > 0 && (
                <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-slate-950/30 px-1.5 text-xs font-bold">
                  {alert.count}
                </span>
              )}
              <span>{l.label}</span>
            </Link>
          );
        }
        return (
          <Link key={l.href} href={l.href} className={PILL_CLASS}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
