"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "@/lib/supabaseClient";
import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";

type Profile = {
  id: string;
  role: string | null;
};

type OrderCycle = { id: string; name: string; status: string };
type Store = { id: string; name: string };
type Item = { id: string; name: string; sku: string };

type Override = {
  cycle_id: string;
  store_id: string;
  item_id: string;
  qty: number;
  reason: string | null;
  set_by: string | null;
  set_at: string;
};

type OverrideRow = Override & {
  cycle_name: string;
  store_name: string;
  item_name: string;
  item_sku: string;
};

export default function AdminAllocationOverrides() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [cycles, setCycles] = useState<OrderCycle[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [cycleId, setCycleId] = useState("");
  const [storeId, setStoreId] = useState("");
  const [itemId, setItemId] = useState("");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isSignedIn = useMemo(() => !!session?.user, [session]);
  const isHQAdmin = useMemo(() => profile?.role === "hq_admin", [profile]);

  useEffect(() => {
    const loadSession = async () => {
      const { data } = await supabase.auth.getSession();
      setSession(data.session);
    };
    loadSession();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, sessionData) => {
      setSession(sessionData ?? null);
    });
    return () => {
      listener?.subscription.unsubscribe();
    };
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

  const reload = async () => {
    const [cycleRes, storeRes, itemRes, overrideRes] = await Promise.all([
      supabase.from("order_cycles").select("id,name,status").order("started_at", { ascending: false }),
      supabase.from("stores").select("id,name").order("name"),
      supabase.from("items").select("id,name,sku").order("name"),
      supabase
        .from("allocation_overrides")
        .select("cycle_id,store_id,item_id,qty,reason,set_by,set_at")
        .order("set_at", { ascending: false }),
    ]);
    if (cycleRes.data) setCycles(cycleRes.data as OrderCycle[]);
    if (storeRes.data) setStores(storeRes.data as Store[]);
    if (itemRes.data) setItems(itemRes.data as Item[]);
    if (overrideRes.data) setOverrides(overrideRes.data as Override[]);
  };

  useEffect(() => {
    if (!isHQAdmin) {
      setCycles([]);
      setStores([]);
      setItems([]);
      setOverrides([]);
      return;
    }
    reload();
  }, [isHQAdmin]);

  const cycleNameById = useMemo(
    () => new Map(cycles.map((c) => [c.id, c.name])),
    [cycles],
  );
  const storeNameById = useMemo(
    () => new Map(stores.map((s) => [s.id, s.name])),
    [stores],
  );
  const itemById = useMemo(
    () => new Map(items.map((i) => [i.id, i])),
    [items],
  );

  const rows: OverrideRow[] = useMemo(
    () =>
      overrides.map((o) => ({
        ...o,
        cycle_name: cycleNameById.get(o.cycle_id) ?? o.cycle_id,
        store_name: storeNameById.get(o.store_id) ?? o.store_id,
        item_name: itemById.get(o.item_id)?.name ?? o.item_id,
        item_sku: itemById.get(o.item_id)?.sku ?? "",
      })),
    [overrides, cycleNameById, storeNameById, itemById],
  );

  const resetForm = () => {
    setEditingKey(null);
    setCycleId("");
    setStoreId("");
    setItemId("");
    setQty("");
    setReason("");
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isHQAdmin) return;

    const qtyNum = parseInt(qty, 10);
    if (!cycleId || !storeId || !itemId) {
      setMessage("Cycle, store, and item are required.");
      return;
    }
    if (Number.isNaN(qtyNum) || qtyNum < 0) {
      setMessage("Qty must be a non-negative integer.");
      return;
    }

    setLoading(true);
    setMessage(null);

    const payload = {
      cycle_id: cycleId,
      store_id: storeId,
      item_id: itemId,
      qty: qtyNum,
      reason: reason.trim() || null,
      set_by: session?.user?.email ?? session?.user?.id ?? null,
    };

    const { error } = await supabase
      .from("allocation_overrides")
      .upsert([payload], { onConflict: "cycle_id,store_id,item_id" });

    setLoading(false);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage(editingKey ? "Override updated." : "Override created.");
    setShowForm(false);
    resetForm();
    await reload();
  };

  const handleEdit = (row: OverrideRow) => {
    setEditingKey(`${row.cycle_id}|${row.store_id}|${row.item_id}`);
    setCycleId(row.cycle_id);
    setStoreId(row.store_id);
    setItemId(row.item_id);
    setQty(String(row.qty));
    setReason(row.reason ?? "");
    setShowForm(true);
  };

  const handleDelete = async (row: OverrideRow) => {
    if (!confirm(`Delete override for ${row.store_name} / ${row.item_name}?`)) return;

    const { error } = await supabase
      .from("allocation_overrides")
      .delete()
      .eq("cycle_id", row.cycle_id)
      .eq("store_id", row.store_id)
      .eq("item_id", row.item_id);

    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage("Override deleted.");
    setOverrides((prev) =>
      prev.filter(
        (o) =>
          !(
            o.cycle_id === row.cycle_id &&
            o.store_id === row.store_id &&
            o.item_id === row.item_id
          ),
      ),
    );
  };

  const columnDefs: ColDef<OverrideRow>[] = [
    { headerName: "Cycle", field: "cycle_name", sortable: true, filter: true, width: 180 },
    { headerName: "Store", field: "store_name", sortable: true, filter: true, width: 180 },
    { headerName: "SKU", field: "item_sku", sortable: true, filter: true, width: 120 },
    { headerName: "Item", field: "item_name", sortable: true, filter: true, width: 200 },
    { headerName: "Qty", field: "qty", sortable: true, filter: true, width: 100 },
    { headerName: "Reason", field: "reason", sortable: true, filter: true, flex: 1 },
    { headerName: "Set by", field: "set_by", sortable: true, filter: true, width: 200 },
    {
      headerName: "Actions",
      width: 160,
      cellRenderer: (params: { data: OverrideRow }) => (
        <div className="flex gap-2">
          <button
            onClick={() => handleEdit(params.data)}
            className="px-2 py-1 text-xs bg-blue-500 text-white rounded"
          >
            Edit
          </button>
          <button
            onClick={() => handleDelete(params.data)}
            className="px-2 py-1 text-xs bg-red-500 text-white rounded"
          >
            Delete
          </button>
        </div>
      ),
    },
  ];

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <h1 className="text-3xl font-semibold text-white">Allocation Overrides</h1>
      <p className="mt-3 text-slate-400">
        Force a specific allocation qty for a (cycle, store, item) tuple. Replaces the store's stock-entry qty
        on the next allocation run; manufactured items still pull from factories using the override qty.
      </p>

      {!isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in with Supabase Auth first to access this page.</p>
        </div>
      ) : !isHQAdmin ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to HQ administrators.</p>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-semibold text-white">Overrides</h2>
            <button
              onClick={() => {
                resetForm();
                setShowForm(true);
              }}
              className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
            >
              Add Override
            </button>
          </div>

          {showForm && (
            <form onSubmit={handleSubmit} className="rounded-2xl bg-slate-900/80 p-6 space-y-4">
              <h3 className="text-lg font-semibold text-white">
                {editingKey ? "Edit Override" : "Add Override"}
              </h3>

              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <label htmlFor="cycle" className="block text-sm font-medium text-slate-300">Cycle</label>
                  <select
                    id="cycle"
                    value={cycleId}
                    onChange={(e) => setCycleId(e.target.value)}
                    disabled={!!editingKey}
                    className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400 disabled:opacity-60"
                    required
                  >
                    <option value="">-- select --</option>
                    {cycles.map((c) => (
                      <option key={c.id} value={c.id}>{c.name} ({c.status})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="store" className="block text-sm font-medium text-slate-300">Store</label>
                  <select
                    id="store"
                    value={storeId}
                    onChange={(e) => setStoreId(e.target.value)}
                    disabled={!!editingKey}
                    className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400 disabled:opacity-60"
                    required
                  >
                    <option value="">-- select --</option>
                    {stores.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="item" className="block text-sm font-medium text-slate-300">Item</label>
                  <select
                    id="item"
                    value={itemId}
                    onChange={(e) => setItemId(e.target.value)}
                    disabled={!!editingKey}
                    className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400 disabled:opacity-60"
                    required
                  >
                    <option value="">-- select --</option>
                    {items.map((i) => (
                      <option key={i.id} value={i.id}>{i.sku} — {i.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="qty" className="block text-sm font-medium text-slate-300">Qty</label>
                  <input
                    id="qty"
                    type="number"
                    min="0"
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                    className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="reason" className="block text-sm font-medium text-slate-300">Reason</label>
                  <input
                    id="reason"
                    type="text"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400"
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
                >
                  {loading ? "Saving..." : editingKey ? "Update" : "Create"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowForm(false);
                    resetForm();
                  }}
                  className="px-4 py-2 bg-slate-600 text-white rounded-full"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          <div className="ag-theme-alpine-dark" style={{ height: 500 }}>
            <AgGridReact
              rowData={rows}
              columnDefs={columnDefs}
              defaultColDef={{ resizable: true, sortable: true, filter: true }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
