"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "@/lib/supabaseClient";
import { AgGridReact } from "@/lib/agGrid";
import type { ColDef } from "ag-grid-community";

type Profile = {
  id: string;
  role: string | null;
  store_id: string | null;
  factory_id: string | null;
};

type Supplier = {
  id: string;
  name: string;
};

type Item = {
  id: string;
  name: string;
  type: "manufactured" | "purchased";
  supplier_id: string | null;
  sub_category: string | null;
  packaging_type: string | null;
  created_at: string;
  suppliers?: { name: string };
};

const SUB_CATEGORIES = ["Empanada", "Dessert", "Drink", "Cleaning Supplies", "General Supplies", "Sauce"];
const PACKAGING_TYPES = ["Single", "Stack", "Box", "Case", "Dozen", "Crate", "Bundle", "Bulk"];

export default function AdminItems() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<"manufactured" | "purchased">("manufactured");
  const [supplierId, setSupplierId] = useState("");
  const [subCategory, setSubCategory] = useState("");
  const [packagingType, setPackagingType] = useState("");
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
      const { data } = await supabase
        .from("profiles")
        .select("id,role,store_id,factory_id")
        .eq("id", session.user.id)
        .single();
      setProfile((data as Profile) ?? null);
    };
    loadProfile();
  }, [session]);

  const reload = async () => {
    const [itemsRes, suppliersRes] = await Promise.all([
      supabase
        .from("items")
        .select("*, suppliers(name)")
        .order("created_at", { ascending: false }),
      supabase.from("suppliers").select("id, name").order("name"),
    ]);
    if (itemsRes.data) setItems(itemsRes.data as Item[]);
    if (suppliersRes.data) setSuppliers(suppliersRes.data as Supplier[]);
  };

  useEffect(() => {
    if (!canManage) {
      setItems([]);
      setSuppliers([]);
      return;
    }
    reload();
  }, [canManage]);

  const resetForm = () => {
    setEditingItem(null);
    setName("");
    setType("manufactured");
    setSupplierId("");
    setSubCategory("");
    setPackagingType("");
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage) return;
    setLoading(true);
    setMessage(null);

    const payload = {
      name: name.trim(),
      type,
      supplier_id: supplierId || null,
      sub_category: subCategory || null,
      packaging_type: packagingType || null,
    };

    const { error } = editingItem
      ? await supabase.from("items").update(payload).eq("id", editingItem.id)
      : await supabase.from("items").insert([payload]);

    setLoading(false);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage(editingItem ? "Item updated." : "Item created.");
    setShowForm(false);
    resetForm();
    await reload();
  };

  const handleEdit = (item: Item) => {
    setEditingItem(item);
    setName(item.name);
    setType(item.type);
    setSupplierId(item.supplier_id || "");
    setSubCategory(item.sub_category || "");
    setPackagingType(item.packaging_type || "");
    setShowForm(true);
  };

  const handleDelete = async (item: Item) => {
    if (!confirm(`Delete item "${item.name}"? This cannot be undone.`)) return;
    const { error } = await supabase.from("items").delete().eq("id", item.id);
    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage("Item deleted.");
    setItems(items.filter((i) => i.id !== item.id));
  };

  const [activateAtItem, setActivateAtItem] = useState<Item | null>(null);
  const [activateRows, setActivateRows] = useState<
    Array<{ store_id: string; store_name: string; active: boolean; original_active: boolean }>
  >([]);
  const [activateLoading, setActivateLoading] = useState(false);
  const [activateSaving, setActivateSaving] = useState(false);

  const openActivateAt = async (item: Item) => {
    setActivateAtItem(item);
    setActivateRows([]);
    setActivateLoading(true);
    const [storesRes, storeItemsRes] = await Promise.all([
      supabase.from("stores").select("id,name").order("name"),
      supabase
        .from("store_items")
        .select("store_id,is_active")
        .eq("item_id", item.id),
    ]);
    setActivateLoading(false);
    if (storesRes.error || !storesRes.data) {
      setMessage(storesRes.error?.message ?? "Failed to load stores");
      setActivateAtItem(null);
      return;
    }
    const activeMap = new Map<string, boolean>();
    (storeItemsRes.data ?? []).forEach((si) => {
      activeMap.set(si.store_id as string, !!si.is_active);
    });
    setActivateRows(
      storesRes.data.map((s) => {
        const active = activeMap.get(s.id) ?? false;
        return {
          store_id: s.id,
          store_name: s.name,
          active,
          original_active: active,
        };
      }),
    );
  };

  const closeActivateAt = () => {
    setActivateAtItem(null);
    setActivateRows([]);
  };

  const toggleActivateRow = (storeId: string) => {
    setActivateRows((prev) =>
      prev.map((r) => (r.store_id === storeId ? { ...r, active: !r.active } : r)),
    );
  };

  const setAllActivateRows = (active: boolean) => {
    setActivateRows((prev) => prev.map((r) => ({ ...r, active })));
  };

  const saveActivateAt = async () => {
    if (!activateAtItem) return;
    const toActivate = activateRows.filter((r) => r.active && !r.original_active);
    const toDeactivate = activateRows.filter((r) => !r.active && r.original_active);
    if (toActivate.length === 0 && toDeactivate.length === 0) {
      closeActivateAt();
      return;
    }
    setActivateSaving(true);
    const now = new Date().toISOString();
    const errors: string[] = [];

    if (toActivate.length > 0) {
      const { error } = await supabase.from("store_items").upsert(
        toActivate.map((r) => ({
          store_id: r.store_id,
          item_id: activateAtItem.id,
          is_active: true,
          capacity: 0,
          activated_at: now,
        })),
        { onConflict: "store_id,item_id" },
      );
      if (error) errors.push(error.message);
    }

    if (toDeactivate.length > 0) {
      const { error } = await supabase
        .from("store_items")
        .update({ is_active: false, deactivated_at: now })
        .in(
          "store_id",
          toDeactivate.map((r) => r.store_id),
        )
        .eq("item_id", activateAtItem.id);
      if (error) errors.push(error.message);
    }

    setActivateSaving(false);

    if (errors.length > 0) {
      setMessage(`Errors: ${errors.join("; ")}`);
      return;
    }

    const parts: string[] = [];
    if (toActivate.length > 0) parts.push(`activated at ${toActivate.length}`);
    if (toDeactivate.length > 0) parts.push(`deactivated at ${toDeactivate.length}`);
    setMessage(`"${activateAtItem.name}" ${parts.join(", ")} store${
      toActivate.length + toDeactivate.length === 1 ? "" : "s"
    }.`);
    closeActivateAt();
  };

  // Inline edit on the grid for the three category fields.
  const handleCellValueChanged = async (params: {
    data: Item;
    colDef: { field?: string };
    newValue: unknown;
    oldValue: unknown;
    node: { setDataValue: (field: string, value: unknown) => void };
  }) => {
    if (params.newValue === params.oldValue) return;
    const field = params.colDef.field;
    if (!field || !["sub_category", "packaging_type"].includes(field)) return;

    const { error } = await supabase
      .from("items")
      .update({ [field]: params.newValue || null })
      .eq("id", params.data.id);

    if (error) {
      setMessage(error.message);
      params.node.setDataValue(field, params.oldValue);
      return;
    }
    setMessage(`Updated ${field}.`);
    setItems((prev) =>
      prev.map((i) => (i.id === params.data.id ? { ...i, [field]: params.newValue as string | null } : i)),
    );
  };

  const columnDefs: ColDef<Item>[] = [
    { headerName: "Name", field: "name", sortable: true, filter: true, flex: 2, minWidth: 150 },
    {
      headerName: "Type",
      field: "type",
      sortable: true,
      filter: true,
      width: 130,
      valueFormatter: (p) => {
        const v = (p.value as string | undefined) ?? "";
        return v ? v.charAt(0).toUpperCase() + v.slice(1) : "";
      },
    },
    {
      headerName: "Supplier",
      valueGetter: (params) => params.data?.suppliers?.name || "",
      sortable: true,
      filter: true,
      flex: 1,
      minWidth: 130,
    },
    {
      headerName: "Sub-Category",
      field: "sub_category",
      sortable: true,
      filter: true,
      flex: 1,
      minWidth: 140,
      editable: true,
      cellEditor: "agSelectCellEditor",
      cellEditorParams: { values: ["", ...SUB_CATEGORIES] },
    },
    {
      headerName: "Packaging",
      field: "packaging_type",
      sortable: true,
      filter: true,
      flex: 1,
      minWidth: 130,
      editable: true,
      cellEditor: "agSelectCellEditor",
      cellEditorParams: { values: ["", ...PACKAGING_TYPES] },
    },
    {
      headerName: "Actions",
      width: 240,
      cellRenderer: (params: { data: Item }) => (
        <div className="flex h-full items-center justify-center gap-2">
          <button
            onClick={() => handleEdit(params.data)}
            className="px-2 py-1 text-xs bg-blue-500 text-white rounded"
          >
            Edit
          </button>
          <button
            onClick={() => openActivateAt(params.data)}
            className="px-2 py-1 text-xs bg-emerald-500 text-slate-950 rounded font-semibold"
            title="Choose which stores carry this item"
          >
            Activate At
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
      <h1 className="text-3xl font-semibold text-white">Admin: Items</h1>
      <p className="mt-3 text-slate-400">
        Manage items including type, supplier, and category metadata. The
        category and packaging columns are editable inline in the grid.
      </p>

      {!isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in to access this page.</p>
        </div>
      ) : !isHQAdmin ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to HQ administrators.</p>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-semibold text-white">Items</h2>
            <button
              onClick={() => {
                resetForm();
                setShowForm(true);
              }}
              className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
            >
              Add Item
            </button>
          </div>

          {showForm && (
            <form onSubmit={handleSubmit} className="rounded-2xl bg-slate-900/80 p-6 space-y-4">
              <h3 className="text-lg font-semibold text-white">
                {editingItem ? "Edit Item" : "Add New Item"}
              </h3>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="name" className="block text-sm font-medium text-slate-300">Name</label>
                  <input
                    id="name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="type" className="block text-sm font-medium text-slate-300">Type</label>
                  <select
                    id="type"
                    value={type}
                    onChange={(e) => setType(e.target.value as "manufactured" | "purchased")}
                    className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                    required
                  >
                    <option value="manufactured">Manufactured</option>
                    <option value="purchased">Purchased</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="supplier" className="block text-sm font-medium text-slate-300">Supplier</label>
                  <select
                    id="supplier"
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}
                    className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                  >
                    <option value="">None</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="sub" className="block text-sm font-medium text-slate-300">Sub Category</label>
                  <select
                    id="sub"
                    value={subCategory}
                    onChange={(e) => setSubCategory(e.target.value)}
                    className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                  >
                    <option value="">None</option>
                    {SUB_CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="pkg" className="block text-sm font-medium text-slate-300">Packaging</label>
                  <select
                    id="pkg"
                    value={packagingType}
                    onChange={(e) => setPackagingType(e.target.value)}
                    className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                  >
                    <option value="">None</option>
                    {PACKAGING_TYPES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-2 bg-cyan-500 text-slate-950 rounded-full font-semibold"
                >
                  {loading ? "Saving..." : editingItem ? "Update" : "Create"}
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

          <div style={{ height: 500 }}>
            <AgGridReact
              rowData={items}
              columnDefs={columnDefs}
              defaultColDef={{ resizable: true, sortable: true, filter: true }}
              onCellValueChanged={handleCellValueChanged}
              stopEditingWhenCellsLoseFocus
            />
          </div>
        </div>
      )}

      {activateAtItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
          onClick={closeActivateAt}
        >
          <div
            className="w-full max-w-md rounded-3xl border border-white/10 bg-slate-900 p-6 text-slate-100 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-white">Activate at stores</h2>
                <p className="mt-1 text-sm text-slate-400">{activateAtItem.name}</p>
              </div>
              <button
                onClick={closeActivateAt}
                className="text-slate-400 hover:text-white"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {activateLoading ? (
              <p className="text-sm text-slate-400">Loading stores...</p>
            ) : activateRows.length === 0 ? (
              <p className="text-sm text-slate-400">No stores exist yet.</p>
            ) : (
              <>
                <div className="mb-3 flex gap-2">
                  <button
                    onClick={() => setAllActivateRows(true)}
                    className="rounded-full bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950"
                  >
                    Activate all
                  </button>
                  <button
                    onClick={() => setAllActivateRows(false)}
                    className="rounded-full bg-slate-700 px-3 py-1.5 text-xs font-semibold text-white"
                  >
                    Deactivate all
                  </button>
                </div>
                <div className="max-h-72 overflow-y-auto rounded-2xl bg-slate-950/60 p-2">
                  {activateRows.map((r) => (
                    <label
                      key={r.store_id}
                      className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 hover:bg-slate-900"
                    >
                      <input
                        type="checkbox"
                        checked={r.active}
                        onChange={() => toggleActivateRow(r.store_id)}
                      />
                      <span className="text-sm text-slate-200">{r.store_name}</span>
                    </label>
                  ))}
                </div>
              </>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={closeActivateAt}
                disabled={activateSaving}
                className="rounded-full bg-slate-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={saveActivateAt}
                disabled={activateLoading || activateSaving || activateRows.length === 0}
                className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
              >
                {activateSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
