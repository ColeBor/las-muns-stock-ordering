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
  store_id: string | null;
  factory_id: string | null;
};

type OrderCycle = {
  id: string;
  name: string;
  started_at: string;
  status: string;
  created_by: string | null;
  created_at: string;
  cycle_stores?: { stores: { id: string; name: string } }[];
};

type Store = {
  id: string;
  name: string;
  is_high_volume: boolean;
};

export default function AdminCycles() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [cycles, setCycles] = useState<OrderCycle[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingCycle, setEditingCycle] = useState<OrderCycle | null>(null);
  const [name, setName] = useState("");
  const [status, setStatus] = useState<"draft" | "active" | "allocated" | "finalized">("draft");
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isSignedIn = useMemo(() => !!session?.user, [session]);
  const isHQAdmin = useMemo(() => profile?.role === "hq_admin", [profile]);
  const canManage = isHQAdmin;

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
    if (!canManage) {
      setCycles([]);
      setStores([]);
      return;
    }

    const loadCycles = async () => {
      const { data, error } = await supabase
        .from("order_cycles")
        .select(`
          *,
          cycle_stores (
            stores (
              id,
              name
            )
          )
        `)
        .order("started_at", { ascending: false });

      if (error) {
        setMessage(error.message);
        return;
      }

      setCycles(data as OrderCycle[]);
    };

    const loadStores = async () => {
      const { data, error } = await supabase
        .from("stores")
        .select("id, name, is_high_volume")
        .order("name");

      if (error) {
        setMessage(error.message);
        return;
      }

      setStores(data as Store[]);
    };

    loadCycles();
    loadStores();
  }, [canManage]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage) return;

    setLoading(true);
    setMessage(null);

    const cycleData = {
      name: name.trim(),
      status,
      created_by: session?.user?.email || null,
    };

    let cycleId: string;
    if (editingCycle) {
      const { error } = await supabase
        .from("order_cycles")
        .update(cycleData)
        .eq("id", editingCycle.id);

      if (error) {
        setMessage(error.message);
        setLoading(false);
        return;
      }
      cycleId = editingCycle.id;
    } else {
      const { data, error } = await supabase
        .from("order_cycles")
        .insert([cycleData])
        .select()
        .single();

      if (error) {
        setMessage(error.message);
        setLoading(false);
        return;
      }
      cycleId = data.id;
    }

    // Update participating stores
    if (editingCycle) {
      // Delete existing store assignments
      await supabase
        .from("cycle_stores")
        .delete()
        .eq("cycle_id", cycleId);
    }

    // Insert new store assignments
    if (selectedStoreIds.length > 0) {
      const storeAssignments = selectedStoreIds.map(storeId => ({
        cycle_id: cycleId,
        store_id: storeId,
      }));

      const { error: storeError } = await supabase
        .from("cycle_stores")
        .insert(storeAssignments);

      if (storeError) {
        setMessage(storeError.message);
        setLoading(false);
        return;
      }
    }

    setLoading(false);
    setMessage(editingCycle ? "Cycle updated successfully." : "Cycle created successfully.");
    setShowForm(false);
    setEditingCycle(null);
    setName("");
    setStatus("draft");
    setSelectedStoreIds([]);

    // Reload cycles
    const { data } = await supabase
      .from("order_cycles")
      .select(`
        *,
        cycle_stores (
          stores (
            id,
            name
          )
        )
      `)
      .order("started_at", { ascending: false });

    if (data) {
      setCycles(data as OrderCycle[]);
    }
  };

  const handleEdit = (cycle: OrderCycle) => {
    setEditingCycle(cycle);
    setName(cycle.name);
    setStatus(cycle.status as "draft" | "active" | "allocated" | "finalized");
    setSelectedStoreIds(cycle.cycle_stores?.map(cs => cs.stores.id) || []);
    setShowForm(true);
  };

  const handleDelete = async (cycle: OrderCycle) => {
    if (cycle.status !== "draft") {
      setMessage("Only draft cycles can be deleted.");
      return;
    }

    if (!confirm(`Delete cycle "${cycle.name}"? This action cannot be undone.`)) return;

    const { error } = await supabase
      .from("order_cycles")
      .delete()
      .eq("id", cycle.id);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage("Cycle deleted successfully.");
    setCycles(cycles.filter((c) => c.id !== cycle.id));
  };

  const handleStatusChange = async (cycle: OrderCycle, newStatus: string) => {
    const { error } = await supabase
      .from("order_cycles")
      .update({ status: newStatus })
      .eq("id", cycle.id);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage(`Cycle status updated to ${newStatus}.`);
    setCycles(cycles.map(c => c.id === cycle.id ? { ...c, status: newStatus } : c));
  };

  const columnDefs: ColDef<OrderCycle>[] = [
    { headerName: "Name", field: "name", sortable: true, filter: true },
    { headerName: "Status", field: "status", sortable: true, filter: true },
    {
      headerName: "Started At",
      field: "started_at",
      sortable: true,
      filter: true,
      valueFormatter: (params) => new Date(params.value).toLocaleDateString(),
    },
    {
      headerName: "Stores",
      valueGetter: (params) => params.data?.cycle_stores?.map(cs => cs.stores.name).join(", ") || "",
      sortable: false,
      filter: false,
    },
    {
      headerName: "Actions",
      cellRenderer: (params: any) => (
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
            disabled={params.data.status !== "draft"}
          >
            Delete
          </button>
          {params.data.status === "draft" && (
            <button
              onClick={() => handleStatusChange(params.data, "active")}
              className="px-2 py-1 text-xs bg-green-500 text-white rounded"
            >
              Activate
            </button>
          )}
          {params.data.status === "active" && (
            <button
              onClick={() => handleStatusChange(params.data, "allocated")}
              className="px-2 py-1 text-xs bg-purple-500 text-white rounded"
            >
              Allocate
            </button>
          )}
          {params.data.status === "allocated" && (
            <button
              onClick={() => handleStatusChange(params.data, "finalized")}
              className="px-2 py-1 text-xs bg-orange-500 text-white rounded"
            >
              Finalize
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <h1 className="text-3xl font-semibold text-white">Admin: Manage Order Cycles</h1>
      <p className="mt-3 text-slate-400">
        HQ administrators can create, edit, and manage order cycles and their participating stores.
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
            <h2 className="text-xl font-semibold text-white">Order Cycles</h2>
            <button
              onClick={() => {
                setEditingCycle(null);
                setName("");
                setStatus("draft");
                setSelectedStoreIds([]);
                setShowForm(true);
              }}
              className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
            >
              Create Cycle
            </button>
          </div>

          {showForm && (
            <form onSubmit={handleSubmit} className="rounded-2xl bg-slate-900/80 p-6 space-y-4">
              <h3 className="text-lg font-semibold text-white">
                {editingCycle ? "Edit Cycle" : "Create New Cycle"}
              </h3>

              <div>
                <label htmlFor="name" className="block text-sm font-medium text-slate-300">
                  Cycle Name
                </label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400"
                  required
                />
              </div>

              <div>
                <label htmlFor="status" className="block text-sm font-medium text-slate-300">
                  Status
                </label>
                <select
                  id="status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as "draft" | "active" | "allocated" | "finalized")}
                  className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400"
                  required
                >
                  <option value="draft">Draft</option>
                  <option value="active">Active</option>
                  <option value="allocated">Allocated</option>
                  <option value="finalized">Finalized</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Participating Stores
                </label>
                <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto border border-white/10 rounded-2xl p-4 bg-slate-950">
                  {stores.map((store) => (
                    <label key={store.id} className="flex items-center">
                      <input
                        type="checkbox"
                        checked={selectedStoreIds.includes(store.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedStoreIds([...selectedStoreIds, store.id]);
                          } else {
                            setSelectedStoreIds(selectedStoreIds.filter(id => id !== store.id));
                          }
                        }}
                        className="mr-2"
                      />
                      <span className="text-sm text-slate-300">
                        {store.name} {store.is_high_volume ? "(High Volume)" : ""}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
                >
                  {loading ? "Saving..." : editingCycle ? "Update" : "Create"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
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
              rowData={cycles}
              columnDefs={columnDefs}
              defaultColDef={{
                resizable: true,
                sortable: true,
                filter: true,
              }}
            />
          </div>
        </div>
      )}
    </section>
  );
}