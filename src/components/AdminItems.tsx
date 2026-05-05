"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "@/lib/supabaseClient";
import { AgGridReact } from "@/lib/agGrid";
import type { ColDef } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";

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
  sku: string;
  name: string;
  type: "manufactured" | "purchased";
  supplier_id: string | null;
  unit: string | null;
  meta_category: string | null;
  sub_category: string | null;
  packaging_type: string | null;
  created_at: string;
  suppliers?: { name: string };
};

const META_CATEGORIES = ["Manufactured", "Purchased"];
const SUB_CATEGORIES = ["Empanada", "Dessert", "Drink", "Cleaning Supplies", "General Supplies", "Sauce"];
const PACKAGING_TYPES = ["Single", "Stack", "Box", "Case", "Dozen", "Crate", "Bundle", "Bulk"];

export default function AdminItems() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<"manufactured" | "purchased">("manufactured");
  const [supplierId, setSupplierId] = useState("");
  const [unit, setUnit] = useState("");
  const [metaCategory, setMetaCategory] = useState("");
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
    setSku("");
    setName("");
    setType("manufactured");
    setSupplierId("");
    setUnit("");
    setMetaCategory("");
    setSubCategory("");
    setPackagingType("");
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage) return;
    setLoading(true);
    setMessage(null);

    const payload = {
      sku: sku.trim(),
      name: name.trim(),
      type,
      supplier_id: supplierId || null,
      unit: unit.trim() || null,
      meta_category: metaCategory || null,
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
    setSku(item.sku);
    setName(item.name);
    setType(item.type);
    setSupplierId(item.supplier_id || "");
    setUnit(item.unit || "");
    setMetaCategory(item.meta_category || "");
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
    if (!field || !["meta_category", "sub_category", "packaging_type"].includes(field)) return;

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
    { headerName: "SKU", field: "sku", sortable: true, filter: true, width: 120 },
    { headerName: "Name", field: "name", sortable: true, filter: true, width: 200 },
    { headerName: "Type", field: "type", sortable: true, filter: true, width: 120 },
    {
      headerName: "Supplier",
      valueGetter: (params) => params.data?.suppliers?.name || "",
      sortable: true,
      filter: true,
      width: 150,
    },
    { headerName: "Unit", field: "unit", sortable: true, filter: true, width: 100 },
    {
      headerName: "Meta Category",
      field: "meta_category",
      sortable: true,
      filter: true,
      width: 150,
      editable: true,
      cellEditor: "agSelectCellEditor",
      cellEditorParams: { values: ["", ...META_CATEGORIES] },
    },
    {
      headerName: "Sub Category",
      field: "sub_category",
      sortable: true,
      filter: true,
      width: 160,
      editable: true,
      cellEditor: "agSelectCellEditor",
      cellEditorParams: { values: ["", ...SUB_CATEGORIES] },
    },
    {
      headerName: "Packaging",
      field: "packaging_type",
      sortable: true,
      filter: true,
      width: 130,
      editable: true,
      cellEditor: "agSelectCellEditor",
      cellEditorParams: { values: ["", ...PACKAGING_TYPES] },
    },
    {
      headerName: "Actions",
      width: 160,
      cellRenderer: (params: { data: Item }) => (
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
      <h1 className="text-3xl font-semibold text-white">Admin: Items</h1>
      <p className="mt-3 text-slate-400">
        Manage items including type, supplier, unit, and category metadata. The
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
                  <label htmlFor="sku" className="block text-sm font-medium text-slate-300">SKU</label>
                  <input
                    id="sku"
                    type="text"
                    value={sku}
                    onChange={(e) => setSku(e.target.value)}
                    className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                    required
                  />
                </div>
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
                  <label htmlFor="unit" className="block text-sm font-medium text-slate-300">Unit</label>
                  <input
                    id="unit"
                    type="text"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                    className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                  />
                </div>
                <div>
                  <label htmlFor="meta" className="block text-sm font-medium text-slate-300">Meta Category</label>
                  <select
                    id="meta"
                    value={metaCategory}
                    onChange={(e) => setMetaCategory(e.target.value)}
                    className="mt-1 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-cyan-400"
                  >
                    <option value="">None</option>
                    {META_CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
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

          <div className="ag-theme-alpine-dark" style={{ height: 500 }}>
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
    </section>
  );
}
