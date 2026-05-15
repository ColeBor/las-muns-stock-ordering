"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";
import { AgGridReact } from "@/lib/agGrid";
import type { ColDef } from "ag-grid-community";

type Supplier = {
  id: string;
  name: string;
  contact_info: string | null;
  created_at: string;
};

export default function AdminSuppliers({
  viewSelector,
}: {
  viewSelector?: React.ReactNode;
} = {}) {
  const { loading: authLoading, isSignedIn, isStoreManager } = useAuthGate();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [name, setName] = useState("");
  const [contactInfo, setContactInfo] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const canManage = isStoreManager;

  // Drop stale responses so a racing realtime event can't clobber the
  // grid with an outdated snapshot.
  const suppliersTokenRef = useRef(0);
  const loadSuppliers = useCallback(async () => {
    if (!canManage) {
      setSuppliers([]);
      return;
    }
    const myToken = ++suppliersTokenRef.current;
    const { data, error } = await supabase
      .from("suppliers")
      .select("*")
      .order("created_at", { ascending: false });
    if (myToken !== suppliersTokenRef.current) return;
    if (error) {
      setMessage(error.message);
      return;
    }
    setSuppliers(data as Supplier[]);
  }, [canManage]);

  useEffect(() => {
    loadSuppliers();
  }, [loadSuppliers]);

  useRealtimeRefetch(
    canManage ? [{ table: "suppliers" }] : [],
    loadSuppliers,
    "admin-suppliers",
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage) return;

    setLoading(true);
    setMessage(null);

    const payload = {
      name: name.trim(),
      contact_info: contactInfo.trim() || null,
    };

    let error;
    if (editingSupplier) {
      ({ error } = await supabase
        .from("suppliers")
        .update(payload)
        .eq("id", editingSupplier.id));
    } else {
      ({ error } = await supabase
        .from("suppliers")
        .insert([payload]));
    }

    setLoading(false);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage(editingSupplier ? "Supplier updated successfully." : "Supplier created successfully.");
    setShowForm(false);
    setEditingSupplier(null);
    setName("");
    setContactInfo("");
    await loadSuppliers();
  };

  const handleEdit = (supplier: Supplier) => {
    setEditingSupplier(supplier);
    setName(supplier.name);
    setContactInfo(supplier.contact_info || "");
    setShowForm(true);
  };

  const handleDelete = async (supplier: Supplier) => {
    if (!confirm(`Delete supplier "${supplier.name}"? This action cannot be undone.`)) return;

    const { error } = await supabase
      .from("suppliers")
      .delete()
      .eq("id", supplier.id);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage("Supplier deleted successfully.");
    setSuppliers(suppliers.filter((s) => s.id !== supplier.id));
  };

  const columnDefs: ColDef<Supplier>[] = [
    { headerName: "Name", field: "name", sortable: true, filter: true, flex: 2, minWidth: 150 },
    { headerName: "Contact Info", field: "contact_info", sortable: true, filter: true, flex: 2, minWidth: 130 },
    {
      headerName: "Actions",
      width: 160,
      cellRenderer: (params: any) => (
        <div className="flex h-full items-center justify-center gap-2">
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
      {!viewSelector && (
        <>
          <h1 className="text-3xl font-semibold text-white">Admin: Manage Suppliers</h1>
          <p className="mt-3 text-slate-400">
            Add, edit, or remove suppliers.
          </p>
        </>
      )}

      {authLoading ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Loading…</p>
        </div>
      ) : !isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in with Supabase Auth first to access this page.</p>
        </div>
      ) : !isStoreManager ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to Store Managers.</p>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          <div className="flex flex-wrap justify-between items-center gap-3">
            {viewSelector ?? (
              <h2 className="text-xl font-semibold text-white">Suppliers</h2>
            )}
            <button
              onClick={() => {
                setEditingSupplier(null);
                setName("");
                setContactInfo("");
                setShowForm(true);
              }}
              className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
            >
              Add Supplier
            </button>
          </div>

          {showForm && (
            <form onSubmit={handleSubmit} className="rounded-2xl bg-slate-900/80 p-6 space-y-4">
              <h3 className="text-lg font-semibold text-white">
                {editingSupplier ? "Edit Supplier" : "Add New Supplier"}
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
                <label htmlFor="contactInfo" className="block text-sm font-medium text-slate-300">
                  Contact Info
                </label>
                <input
                  id="contactInfo"
                  type="text"
                  value={contactInfo}
                  onChange={(e) => setContactInfo(e.target.value)}
                  className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400"
                />
              </div>

              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
                >
                  {loading ? "Saving..." : editingSupplier ? "Update" : "Create"}
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

          <div style={{ height: 400 }}>
            <AgGridReact
              rowData={suppliers}
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