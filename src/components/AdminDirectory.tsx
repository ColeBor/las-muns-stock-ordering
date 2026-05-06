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

  const selector = (
    <div className="flex items-center gap-2">
      <span className="text-sm text-slate-400">View:</span>
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value as DirectoryKind)}
        className="rounded-full border border-white/10 bg-slate-900 px-3 py-1.5 text-xl font-semibold text-white outline-none focus:border-cyan-400"
      >
        {(Object.keys(LABELS) as DirectoryKind[]).map((k) => (
          <option key={k} value={k}>
            {LABELS[k]}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-semibold text-white">Directory</h1>
      {kind === "stores" && <AdminStores viewSelector={selector} />}
      {kind === "factories" && <AdminFactories viewSelector={selector} />}
      {kind === "suppliers" && <AdminSuppliers viewSelector={selector} />}
    </div>
  );
}
