"use client";

import { useState } from "react";
import AdminStores from "./AdminStores";
import AdminFactories from "./AdminFactories";
import AdminSuppliers from "./AdminSuppliers";

type DirectoryKind = "stores" | "factories" | "suppliers";

const LABELS: Record<DirectoryKind, string> = {
  stores: "Stores",
  factories: "Factories",
  suppliers: "Suppliers",
};

export default function AdminDirectory() {
  const [kind, setKind] = useState<DirectoryKind>("stores");

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <label htmlFor="directory-kind" className="text-sm text-slate-300">
          View:
        </label>
        <select
          id="directory-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as DirectoryKind)}
          className="rounded-2xl border border-white/10 bg-slate-950 px-4 py-2 text-sm text-white outline-none focus:border-cyan-400"
        >
          {(Object.keys(LABELS) as DirectoryKind[]).map((k) => (
            <option key={k} value={k}>
              {LABELS[k]}
            </option>
          ))}
        </select>
      </div>

      {kind === "stores" && <AdminStores />}
      {kind === "factories" && <AdminFactories />}
      {kind === "suppliers" && <AdminSuppliers />}
    </div>
  );
}
