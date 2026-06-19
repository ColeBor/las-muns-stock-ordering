"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import { AgGridReact } from "@/lib/agGrid";
import type { ColDef, ICellRendererParams } from "ag-grid-community";

type PackagingType = {
  id: string;
  name: string;
  created_at: string;
};

export default function AdminPackagingTypes({
  viewSelector,
}: {
  viewSelector?: React.ReactNode;
} = {}) {
  const { loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
  const [packagingTypes, setPackagingTypes] = useState<PackagingType[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<PackagingType | null>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const canManage = isStoreManager;

  // Drop stale responses + subscribe to realtime so the AdminItems
  // dropdown (which reads this same list) stays in sync across tabs.
  const reloadTokenRef = useRef(0);
  const reload = useCallback(async () => {
    if (!canManage) {
      setPackagingTypes([]);
      return;
    }
    const myToken = ++reloadTokenRef.current;
    const { data, error } = await supabase
      .from("packaging_types")
      .select("*")
      .order("name");
    if (myToken !== reloadTokenRef.current) return;
    if (error) {
      setMessage(error.message);
      return;
    }
    setPackagingTypes((data as PackagingType[]) ?? []);
  }, [canManage]);

  useEffect(() => {
    reload();
  }, [reload]);

  useRealtimeRefetch(
    canManage ? [{ table: "packaging_types" }] : [],
    reload,
    "admin-packaging-types",
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage) return;

    const trimmed = name.trim();
    if (!trimmed) {
      setMessage("Name is required.");
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      let error;
      if (editing) {
        ({ error } = await supabase
          .from("packaging_types")
          .update({ name: trimmed })
          .eq("id", editing.id));
      } else {
        ({ error } = await supabase
          .from("packaging_types")
          .insert([{ name: trimmed }]));
      }

      if (error) {
        setMessage(error.message);
        return;
      }

      setMessage(editing ? "Packaging type updated." : "Packaging type created.");
      setShowForm(false);
      setEditing(null);
      setName("");
      await reload();
    } catch (err) {
      setMessage(
        `Couldn't save packaging type: ${err instanceof Error ? err.message : "network timeout"}. Try again.`,
      );
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (pkg: PackagingType) => {
    setEditing(pkg);
    setName(pkg.name);
    setShowForm(true);
  };

  // Note: items.packaging_type has no FK to this table — items hold the
  // packaging name as plain text. Deleting a type here doesn't cascade to
  // items, so existing items keep their value but the dropdown won't offer
  // it anymore. Warn the user before deleting.
  const handleDelete = async (pkg: PackagingType) => {
    if (
      !confirm(
        `Delete packaging type "${pkg.name}"? Existing items already using it will keep the value, but it won't appear in the dropdown anymore.`,
      )
    )
      return;
    try {
      const { error } = await supabase
        .from("packaging_types")
        .delete()
        .eq("id", pkg.id);
      if (error) {
        setMessage(error.message);
        return;
      }
      setMessage("Packaging type deleted.");
      setPackagingTypes((prev) => prev.filter((p) => p.id !== pkg.id));
    } catch (err) {
      setMessage(
        `Couldn't delete packaging type: ${err instanceof Error ? err.message : "network timeout"}. Try again.`,
      );
    }
  };

  const columnDefs: ColDef<PackagingType>[] = [
    {
      headerName: "Name",
      field: "name",
      sortable: true,
      filter: true,
      flex: 2,
      minWidth: 150,
    },
    {
      headerName: "Actions",
      width: 160,
      cellRenderer: (params: ICellRendererParams<PackagingType>) =>
        params.data ? (
          <div className="flex h-full items-center justify-center gap-2">
            <button
              onClick={() => handleEdit(params.data!)}
              className="px-2 py-1 text-xs bg-blue-500 text-white rounded"
            >
              Edit
            </button>
            <button
              onClick={() => handleDelete(params.data!)}
              className="px-2 py-1 text-xs bg-red-500 text-white rounded"
            >
              Delete
            </button>
          </div>
        ) : null,
    },
  ];

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      {!viewSelector && (
        <>
          <h1 className="text-3xl font-semibold text-white">Admin: Packaging Types</h1>
          <p className="mt-3 text-slate-400">
            Manage the packaging types available when creating or editing items.
          </p>
        </>
      )}

      {authLoading ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Loading…</p>
        </div>
      ) : !isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in to access this page.</p>
        </div>
      ) : !isStoreManager ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to Store Managers.</p>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          <div className="flex flex-wrap justify-between items-center gap-3">
            {viewSelector ?? (
              <h2 className="text-xl font-semibold text-white">Packaging Types</h2>
            )}
            <button
              onClick={() => {
                setEditing(null);
                setName("");
                setShowForm(true);
              }}
              className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
            >
              Add Packaging Type
            </button>
          </div>

          {showForm && (
            <form
              onSubmit={handleSubmit}
              className="rounded-2xl bg-slate-900/80 p-6 space-y-4"
            >
              <h3 className="text-lg font-semibold text-white">
                {editing ? "Edit Packaging Type" : "Add New Packaging Type"}
              </h3>

              <div>
                <label
                  htmlFor="name"
                  className="block text-sm font-medium text-slate-300"
                >
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

              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
                >
                  {loading ? "Saving..." : editing ? "Update" : "Create"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowForm(false);
                    setEditing(null);
                  }}
                  className="px-4 py-2 bg-slate-600 text-white rounded-full"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {message && <p className="text-sm text-cyan-300">{message}</p>}

          <div style={{ height: 400 }}>
            <AgGridReact
              rowData={packagingTypes}
              columnDefs={columnDefs}
              defaultColDef={{
                resizable: true,
                sortable: true,
                filter: true,
                minWidth: 80,
              }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
