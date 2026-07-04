"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useFormDraft } from "@/lib/useFormDraft";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

// Recently-due orders linger this long so staff still see one they're actively
// fulfilling, rather than it vanishing the instant its time passes.
const GRACE_MS = 2 * 60 * 60 * 1000;

type OrderRow = {
  id: string;
  otter_order_id: string;
  store_id: string | null;
  display_id: string | null;
  customer_name: string | null;
  fulfillment_mode: string | null;
  status: string | null;
  scheduled_for: string | null;
  canceled_at: string | null;
  item_count: number | null;
  stores: { name: string } | { name: string }[] | null;
};

type OrderItemRow = {
  otter_order_id: string;
  name: string | null;
  quantity: number;
};

function storeNameOf(row: OrderRow): string {
  const s = Array.isArray(row.stores) ? row.stores[0] : row.stores;
  return s?.name ?? "Unmapped store";
}

export default function OtterScheduledOrders() {
  const { profile, loading: authLoading, isSignedIn, isStoreManager, isEmployee } = useAuthGate();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [items, setItems] = useState<OrderItemRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Employees are scoped to their currently-selected store; admins see all.
  const employeeStoreId = isEmployee ? profile?.store_id ?? null : null;
  const canView = isStoreManager || (isEmployee && !!employeeStoreId);

  const loadOrders = useCallback(async () => {
    if (!canView) {
      setOrders([]);
      setItems([]);
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const cutoff = new Date(Date.now() - GRACE_MS).toISOString();
      let query = supabase
        .from("otter_orders")
        .select(
          "id,otter_order_id,store_id,display_id,customer_name,fulfillment_mode,status,scheduled_for,canceled_at,item_count,stores(name)",
        )
        .eq("is_scheduled", true)
        .is("canceled_at", null)
        .gte("scheduled_for", cutoff)
        .order("scheduled_for", { ascending: true });
      if (isEmployee && employeeStoreId) query = query.eq("store_id", employeeStoreId);
      const { data, error } = await query;
      if (error) {
        setMessage(error.message);
        return;
      }
      const rows = (data as OrderRow[]) ?? [];
      setOrders(rows);

      // Pull line items for the visible orders in one shot.
      const ids = rows.map((r) => r.otter_order_id);
      if (ids.length === 0) {
        setItems([]);
        return;
      }
      const { data: itemData } = await supabase
        .from("otter_order_items")
        .select("otter_order_id,name,quantity")
        .in("otter_order_id", ids);
      setItems((itemData as OrderItemRow[]) ?? []);
    } catch (err) {
      setMessage(
        `Couldn't load orders: ${err instanceof Error ? err.message : "network timeout"}. Try again.`,
      );
    } finally {
      setLoading(false);
    }
  }, [canView, isEmployee, employeeStoreId]);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  useRealtimeRefetch(
    canView ? [{ table: "otter_orders" }, { table: "otter_order_items" }] : [],
    loadOrders,
    `otter-scheduled-${employeeStoreId ?? "all"}`,
  );

  const itemsByOrder = useMemo(() => {
    const map = new Map<string, OrderItemRow[]>();
    for (const it of items) {
      const arr = map.get(it.otter_order_id) ?? [];
      arr.push(it);
      map.set(it.otter_order_id, arr);
    }
    return map;
  }, [items]);

  // Admins see every store grouped; employees see their one store flat.
  const grouped = useMemo(() => {
    const map = new Map<string, { name: string; rows: OrderRow[] }>();
    for (const o of orders) {
      const key = o.store_id ?? "__unmapped__";
      const existing = map.get(key);
      if (existing) existing.rows.push(o);
      else map.set(key, { name: storeNameOf(o), rows: [o] });
    }
    return Array.from(map.values());
  }, [orders]);

  const formatTime = (iso: string | null) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const itemsSummary = (orderId: string): string => {
    const list = itemsByOrder.get(orderId) ?? [];
    if (list.length === 0) return "—";
    return list
      .map((it) => `${it.quantity}× ${it.name ?? "item"}`)
      .join(", ");
  };

  const renderTable = (rows: OrderRow[]) => (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
            <th className="px-3 py-2">Scheduled for</th>
            <th className="px-3 py-2">Customer</th>
            <th className="px-3 py-2">Type</th>
            <th className="px-3 py-2">Items</th>
            <th className="px-3 py-2">Order #</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {rows.map((o) => (
            <tr key={o.id} className="text-slate-200 align-top">
              <td className="px-3 py-2 whitespace-nowrap font-medium text-white">
                {formatTime(o.scheduled_for)}
              </td>
              <td className="px-3 py-2">{o.customer_name ?? "—"}</td>
              <td className="px-3 py-2 capitalize text-slate-300">
                {o.fulfillment_mode ?? "—"}
              </td>
              <td className="px-3 py-2 text-slate-300">{itemsSummary(o.otter_order_id)}</td>
              <td className="px-3 py-2 text-slate-400">{o.display_id ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <div>
        <h1 className="text-3xl font-semibold text-white">Scheduled Orders</h1>
        <p className="mt-3 text-slate-400">
          Upcoming orders customers scheduled ahead of time on Otter, soonest first.
        </p>
      </div>

      {authLoading ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Loading…</p>
        </div>
      ) : !isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in.</p>
        </div>
      ) : !isStoreManager && !isEmployee ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to Employees and Store Managers.</p>
        </div>
      ) : isEmployee && !employeeStoreId ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>You are not assigned to a store. Please contact an administrator.</p>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          {isStoreManager && <OtterStoreMapping />}

          <div className="text-sm text-slate-300">
            {loading
              ? "Loading…"
              : orders.length === 0
                ? "No upcoming scheduled orders."
                : `${orders.length} upcoming ${orders.length === 1 ? "order" : "orders"}`}
          </div>

          {message && <p className="text-sm text-rose-300">{message}</p>}

          {orders.length > 0 &&
            (isStoreManager ? (
              <div className="space-y-6">
                {grouped.map((g, i) => (
                  <div key={i} className="rounded-2xl border border-white/10 bg-slate-900/60 p-5">
                    <h2 className="text-lg font-semibold text-white">{g.name}</h2>
                    <div className="mt-3">{renderTable(g.rows)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-5">
                {renderTable(orders)}
              </div>
            ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Admin-only: map each Otter location id to one of our stores. Until a
// location is mapped, its orders still land (store_id null, raw preserved)
// but show under "Unmapped store".
// ---------------------------------------------------------------------------
type StoreOption = { id: string; name: string };
type LinkRow = { otter_store_id: string; store_id: string; label: string | null };

function OtterStoreMapping() {
  const [open, setOpen] = useState(false);
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [otterId, setOtterId] = useState("");
  const [storeId, setStoreId] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useFormDraft({
    key: "otter-store-mapping",
    values: { otterId, storeId, label },
    isDirty: (v) => v.otterId.trim() !== "" || v.label.trim() !== "",
    onRestore: (v) => {
      if (v.otterId) setOtterId(v.otterId);
      if (v.storeId) setStoreId(v.storeId);
      if (v.label) setLabel(v.label);
    },
    onRestored: () => setMessage("Restored your unsaved entry."),
  });

  const reload = useCallback(async () => {
    const [storesRes, linksRes] = await Promise.all([
      supabase.from("stores").select("id,name").order("name"),
      supabase.from("otter_store_links").select("otter_store_id,store_id,label"),
    ]);
    if (storesRes.data) setStores(storesRes.data as StoreOption[]);
    if (linksRes.data) setLinks(linksRes.data as LinkRow[]);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useRealtimeRefetch(
    [{ table: "otter_store_links" }, { table: "stores" }],
    reload,
    "otter-store-links",
  );

  const storeNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of stores) m.set(s.id, s.name);
    return m;
  }, [stores]);

  const handleAdd = async () => {
    const trimmed = otterId.trim();
    if (!trimmed || !storeId) {
      setMessage("Enter the Otter location id and pick a store.");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const { error } = await supabase
        .from("otter_store_links")
        .upsert(
          { otter_store_id: trimmed, store_id: storeId, label: label.trim() || null },
          { onConflict: "otter_store_id" },
        );
      if (error) {
        setMessage(error.message);
        return;
      }
      setOtterId("");
      setStoreId("");
      setLabel("");
      setMessage("Mapping saved.");
      reload();
    } catch (err) {
      setMessage(
        `Couldn't save mapping: ${err instanceof Error ? err.message : "network timeout"}. Try again.`,
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const { error } = await supabase.from("otter_store_links").delete().eq("otter_store_id", id);
      if (error) {
        setMessage(error.message);
        return;
      }
      reload();
    } catch (err) {
      setMessage(
        `Couldn't remove mapping: ${err instanceof Error ? err.message : "network timeout"}. Try again.`,
      );
    }
  };

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="rounded-2xl border border-white/10 bg-slate-900/60 p-5"
    >
      <summary className="cursor-pointer list-none text-lg font-semibold text-white marker:hidden">
        <span className="inline-flex items-center gap-2">
          <span className={`text-base leading-none transition ${open ? "rotate-90" : ""}`}>▸</span>
          Otter store mapping{links.length ? ` (${links.length})` : ""}
        </span>
      </summary>

      <p className="mt-3 text-sm text-slate-400">
        Link each Otter location id to a store so its orders show under the right name.
      </p>

      {links.length > 0 && (
        <table className="mt-4 min-w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
              <th className="px-3 py-2">Otter location id</th>
              <th className="px-3 py-2">Store</th>
              <th className="px-3 py-2">Label</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {links.map((l) => (
              <tr key={l.otter_store_id} className="text-slate-200">
                <td className="px-3 py-2 font-mono text-xs">{l.otter_store_id}</td>
                <td className="px-3 py-2">{storeNameById.get(l.store_id) ?? l.store_id}</td>
                <td className="px-3 py-2 text-slate-400">{l.label ?? "—"}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => handleDelete(l.otter_store_id)}
                    className="text-xs text-rose-300 hover:text-rose-200"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-400">Otter location id</label>
          <input
            type="text"
            value={otterId}
            onChange={(e) => setOtterId(e.target.value)}
            placeholder="e.g. store_abc123"
            className="mt-1 w-56 rounded-2xl border border-white/10 bg-slate-950 px-4 py-2.5 text-sm text-white outline-none focus:border-cyan-400"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400">Store</label>
          <select
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
            className="mt-1 w-48 rounded-2xl border border-white/10 bg-slate-950 px-4 py-2.5 text-sm text-white outline-none focus:border-cyan-400"
          >
            <option value="">(Select)</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400">Label (optional)</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="mt-1 w-40 rounded-2xl border border-white/10 bg-slate-950 px-4 py-2.5 text-sm text-white outline-none focus:border-cyan-400"
          />
        </div>
        <button
          type="button"
          onClick={handleAdd}
          disabled={saving}
          className="rounded-full bg-cyan-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Add mapping"}
        </button>
      </div>
      {message && <p className="mt-2 text-sm text-cyan-300">{message}</p>}
    </details>
  );
}
