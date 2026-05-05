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

type Factory = {
  id: string;
  name: string;
  location: string | null;
  created_at: string;
};

export default function AdminFactories() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [factories, setFactories] = useState<Factory[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingFactory, setEditingFactory] = useState<Factory | null>(null);
  const [name, setName] = useState("");
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
      setFactories([]);
      return;
    }

    const loadFactories = async () => {
      const { data, error } = await supabase
        .from("factories")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) {
        setMessage(error.message);
        return;
      }

      setFactories(data as Factory[]);
    };

    loadFactories();
  }, [canManage]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage) return;

    setLoading(true);
    setMessage(null);

    const payload = {
      name: name.trim(),
      location: location.trim() || null,
    };

    let error;
    if (editingFactory) {
      ({ error } = await supabase
        .from("factories")
        .update(payload)
        .eq("id", editingFactory.id));
    } else {
      ({ error } = await supabase
        .from("factories")
        .insert([payload]));
    }

    setLoading(false);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage(editingFactory ? "Factory updated successfully." : "Factory created successfully.");
    setShowForm(false);
    setEditingFactory(null);
    setName("");
    setLocation("");

    // Reload factories
    const { data } = await supabase
      .from("factories")
      .select("*")
      .order("created_at", { ascending: false });

    if (data) {
      setFactories(data as Factory[]);
    }
  };

  const handleEdit = (factory: Factory) => {
    setEditingFactory(factory);
    setName(factory.name);
    setLocation(factory.location || "");
    setShowForm(true);
  };

  const handleDelete = async (factory: Factory) => {
    if (!confirm(`Delete factory "${factory.name}"? This action cannot be undone.`)) return;

    const { error } = await supabase
      .from("factories")
      .delete()
      .eq("id", factory.id);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage("Factory deleted successfully.");
    setFactories(factories.filter((f) => f.id !== factory.id));
  };

  const columnDefs: ColDef<Factory>[] = [
    { headerName: "Name", field: "name", sortable: true, filter: true },
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
      <h1 className="text-3xl font-semibold text-white">Admin: Manage Factories</h1>
      <p className="mt-3 text-slate-400">
        HQ administrators can create, edit, and delete factories.
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
            <h2 className="text-xl font-semibold text-white">Factories</h2>
            <button
              onClick={() => {
                setEditingFactory(null);
                setName("");
                setLocation("");
                setShowForm(true);
              }}
              className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
            >
              Add Factory
            </button>
          </div>

          {showForm && (
            <form onSubmit={handleSubmit} className="rounded-2xl bg-slate-900/80 p-6 space-y-4">
              <h3 className="text-lg font-semibold text-white">
                {editingFactory ? "Edit Factory" : "Add New Factory"}
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
                  {loading ? "Saving..." : editingFactory ? "Update" : "Create"}
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
              rowData={factories}
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
