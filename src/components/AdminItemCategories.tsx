"use client";

import { useEffect, useMemo, useState } from "react";
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

type Item = {
  id: string;
  sku: string;
  name: string;
  type: string;
  unit: string | null;
  meta_category: string | null;
  sub_category: string | null;
  packaging_type: string | null;
  supplier_id: string | null;
};

type ItemRow = {
  id: string;
  sku: string;
  name: string;
  type: string;
  unit: string | null;
  meta_category: string | null;
  sub_category: string | null;
  packaging_type: string | null;
};

const META_CATEGORIES = ["Manufactured", "Purchased"];
const SUB_CATEGORIES = ["Empanada", "Dessert", "Drink", "Cleaning Supplies", "General Supplies", "Sauce"];
const PACKAGING_TYPES = ["Single", "Stack", "Box", "Case", "Dozen", "Crate", "Bundle", "Bulk"];

export default function AdminItemCategories() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [gridData, setGridData] = useState<ItemRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isSignedIn = useMemo(() => !!session?.user, [session]);
  const isHqAdmin = useMemo(() => profile?.role === "hq_admin", [profile]);

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
    if (!isHqAdmin) {
      setItems([]);
      setGridData([]);
      return;
    }

    const loadItems = async () => {
      const { data, error } = await supabase
        .from("items")
        .select("id,sku,name,type,unit,meta_category,sub_category,packaging_type,supplier_id")
        .order("sku");

      if (error || !data) {
        setItems([]);
        setGridData([]);
        return;
      }

      setItems(data as Item[]);

      const gridRows: ItemRow[] = data.map(item => ({
        id: item.id,
        sku: item.sku,
        name: item.name,
        type: item.type,
        unit: item.unit,
        meta_category: item.meta_category,
        sub_category: item.sub_category,
        packaging_type: item.packaging_type,
      }));

      setGridData(gridRows);
    };

    loadItems();
  }, [isHqAdmin]);

  const handleCellValueChanged = async (params: any) => {
    const { data, colDef, newValue, oldValue } = params;

    if (newValue === oldValue) return;

    setLoading(true);
    setMessage(null);

    try {
      if (!["meta_category", "sub_category", "packaging_type"].includes(colDef.field)) {
        return;
      }

      const payload = {
        meta_category: colDef.field === "meta_category" ? newValue : data.meta_category,
        sub_category: colDef.field === "sub_category" ? newValue : data.sub_category,
        packaging_type: colDef.field === "packaging_type" ? newValue : data.packaging_type,
      };

      const { error } = await supabase
        .from("items")
        .update(payload)
        .eq("id", data.id);

      if (error) throw error;

      setMessage(`Item "${data.name}" updated successfully.`);

      // Update local items state
      setItems(prev =>
        prev.map(item =>
          item.id === data.id ? { ...item, ...payload } : item
        )
      );
    } catch (error: any) {
      setMessage(error.message);
      params.node.setDataValue(colDef.field, oldValue);
    } finally {
      setLoading(false);
    }
  };

  const columnDefs: ColDef<ItemRow>[] = [
    { headerName: "SKU", field: "sku", sortable: true, filter: true, width: 120 },
    { headerName: "Item Name", field: "name", sortable: true, filter: true, width: 200 },
    { headerName: "Type", field: "type", sortable: true, filter: true, width: 120 },
    { headerName: "Unit", field: "unit", sortable: true, filter: true, width: 80 },
    {
      headerName: "Meta Category",
      field: "meta_category",
      sortable: true,
      filter: true,
      width: 150,
      editable: true,
      cellEditor: "agSelectCellEditor",
      cellEditorParams: {
        values: META_CATEGORIES,
      },
      cellStyle: (params) => ({
        backgroundColor: params.data?.meta_category ? "#1f2937" : "#374151",
      }),
    },
    {
      headerName: "Sub Category",
      field: "sub_category",
      sortable: true,
      filter: true,
      width: 150,
      editable: true,
      cellEditor: "agSelectCellEditor",
      cellEditorParams: {
        values: SUB_CATEGORIES,
      },
      cellStyle: (params) => ({
        backgroundColor: params.data?.sub_category ? "#1f2937" : "#374151",
      }),
    },
    {
      headerName: "Packaging Type",
      field: "packaging_type",
      sortable: true,
      filter: true,
      width: 150,
      editable: true,
      cellEditor: "agSelectCellEditor",
      cellEditorParams: {
        values: PACKAGING_TYPES,
      },
      cellStyle: (params) => ({
        backgroundColor: params.data?.packaging_type ? "#1f2937" : "#374151",
      }),
    },
  ];

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <h1 className="text-3xl font-semibold text-white">Item Categories & Packaging</h1>
      <p className="mt-3 text-slate-400">
        Assign meta-categories, sub-categories, and packaging types to all items in the system.
      </p>

      {!isSignedIn ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>Please sign in with Supabase Auth first to access this page.</p>
        </div>
      ) : !isHqAdmin ? (
        <div className="mt-8 rounded-2xl bg-slate-900/80 p-6 text-slate-300">
          <p>This page is only available to HQ administrators.</p>
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          {message && (
            <div className="rounded-2xl bg-slate-900/80 p-4">
              <p className="text-sm text-cyan-300">{message}</p>
            </div>
          )}

          <div className="ag-theme-alpine-dark" style={{ height: "calc(100vh - 300px)", minHeight: 500 }}>
            <AgGridReact
              rowData={gridData}
              columnDefs={columnDefs}
              defaultColDef={{
                resizable: true,
                sortable: true,
                filter: true,
              }}
              onCellValueChanged={handleCellValueChanged}
              stopEditingWhenCellsLoseFocus={true}
            />
          </div>

          <div className="text-sm text-slate-400">
            <p><strong>Instructions:</strong></p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li>Click on "Meta Category", "Sub Category", or "Packaging Type" cells to select from dropdown lists</li>
              <li>Changes are saved automatically when you finish editing a cell</li>
              <li>Meta Categories: Manufactured, Purchased</li>
              <li>Sub Categories: Empanada, Dessert, Drink, Cleaning Supplies, General Supplies, Sauce</li>
              <li>Packaging Types: Single, Stack, Box, Case, Dozen, Crate, Bundle, Bulk</li>
              <li>Cells with darker backgrounds already have assigned values</li>
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
