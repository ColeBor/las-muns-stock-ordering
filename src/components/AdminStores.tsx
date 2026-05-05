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

type Store = {
  id: string;
  name: string;
  is_high_volume: boolean;
  location: string | null;
  created_at: string;
};

export default function AdminStores() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingStore, setEditingStore] = useState<Store | null>(null);
  const [name, setName] = useState("");
  const [isHighVolume, setIsHighVolume] = useState(false);
  const [location, setLocation] = useState("");
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
      setStores([]);
      return;
    }

    const loadStores = async () => {
      const { data, error } = await supabase
        .from("stores")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) {
        setMessage(error.message);
        return;
      }

      setStores(data as Store[]);
    };

    loadStores();
  }, [canManage]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage) return;

    setLoading(true);
    setMessage(null);

    const payload = {
      name: name.trim(),
      is_high_volume: isHighVolume,
      location: location.trim() || null,
    };

    let error;
    if (editingStore) {
      ({ error } = await supabase
        .from("stores")
        .update(payload)
        .eq("id", editingStore.id));
    } else {
      ({ error } = await supabase
        .from("stores")
        .insert([payload]));
    }

    setLoading(false);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage(editingStore ? "Store updated successfully." : "Store created successfully.");
    setShowForm(false);
    setEditingStore(null);
    setName("");
    setIsHighVolume(false);
    setLocation("");

    // Reload stores
    const { data } = await supabase
      .from("stores")
      .select("*")
      .order("created_at", { ascending: false });

    if (data) {
      setStores(data as Store[]);
    }
  };

  const handleEdit = (store: Store) => {
    setEditingStore(store);
    setName(store.name);
    setIsHighVolume(store.is_high_volume);
    setLocation(store.location || "");
    setShowForm(true);
  };

  const handleDelete = async (store: Store) => {
    if (!confirm(`Delete store "${store.name}"? This action cannot be undone.`)) return;

    const { error } = await supabase
      .from("stores")
      .delete()
      .eq("id", store.id);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage("Store deleted successfully.");
    setStores(stores.filter((s) => s.id !== store.id));
  };

  const columnDefs: ColDef<Store>[] = [
    { headerName: "Name", field: "name", sortable: true, filter: true },
    { headerName: "High Volume", field: "is_high_volume", sortable: true, filter: true },
    { headerName: "Location", field: "location", sortable: true, filter: true },
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
          >
            Delete
          </button>
        </div>
      ),
    },
  ];

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <h1 className="text-3xl font-semibold text-white">Admin: Manage Stores</h1>
      <p className="mt-3 text-slate-400">
        HQ administrators can create, edit, and delete stores.
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
            <h2 className="text-xl font-semibold text-white">Stores</h2>
            <button
              onClick={() => {
                setEditingStore(null);
                setName("");
                setIsHighVolume(false);
                setLocation("");
                setShowForm(true);
              }}
              className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
            >
              Add Store
            </button>
          </div>

          {showForm && (
            <form onSubmit={handleSubmit} className="rounded-2xl bg-slate-900/80 p-6 space-y-4">
              <h3 className="text-lg font-semibold text-white">
                {editingStore ? "Edit Store" : "Add New Store"}
              </h3>

              <div>
                <label htmlFor="name" className="block text-sm font-medium text-slate-300">
                  Name
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
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={isHighVolume}
                    onChange={(e) => setIsHighVolume(e.target.checked)}
                    className="mr-2"
                  />
                  <span className="text-sm font-medium text-slate-300">High Volume Store</span>
                </label>
              </div>

              <div>
                <label htmlFor="location" className="block text-sm font-medium text-slate-300">
                  Location
                </label>
                <input
                  id="location"
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400"
                />
              </div>

              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
                >
                  {loading ? "Saving..." : editingStore ? "Update" : "Create"}
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

          <div className="ag-theme-alpine-dark" style={{ height: 400 }}>
            <AgGridReact
              rowData={stores}
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
