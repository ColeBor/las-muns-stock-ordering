"use client";

import { useState } from "react";
import AdminItemsList from "./AdminItemsList";
import AdminPackagingTypes from "./AdminPackagingTypes";
import StoreItemMatrix from "./StoreItemMatrix";
import StoreCapacityMatrix from "./StoreCapacityMatrix";

type ItemsKind = "items" | "availability" | "capacity" | "packaging";

const LABELS: Record<ItemsKind, string> = {
  items: "Item List",
  availability: "Store Availability",
  capacity: "Store Capacity",
  packaging: "Packaging Types",
};

export default function AdminItems() {
  const [kind, setKind] = useState<ItemsKind>("items");

  const selector = (
    <div className="flex items-center gap-2">
      <span className="text-sm text-slate-400">View:</span>
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value as ItemsKind)}
        className="rounded-full border border-white/10 bg-slate-900 px-3 py-1.5 text-xl font-semibold text-white outline-none focus:border-cyan-400"
      >
        {(Object.keys(LABELS) as ItemsKind[]).map((k) => (
          <option key={k} value={k}>
            {LABELS[k]}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-semibold text-white">Items</h1>
      {kind === "items" && <AdminItemsList viewSelector={selector} />}
      {kind === "availability" && <StoreItemMatrix viewSelector={selector} />}
      {kind === "capacity" && <StoreCapacityMatrix viewSelector={selector} />}
      {kind === "packaging" && <AdminPackagingTypes viewSelector={selector} />}
    </div>
  );
}
