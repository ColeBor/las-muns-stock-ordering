"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuthGate } from "@/lib/useAuthGate";
import { useRealtimeRefetch } from "@/lib/useRealtimeRefetch";

// Dropdown shown to employees with 2+ assigned stores. Picks which store
// they're currently working at by writing to profiles.store_id. The
// profiles_self_update_guard trigger validates that the chosen store is in
// the user's profile_stores set. A full page reload after the update is
// the simplest way to make every component using useAuthGate pick up the
// new active store — refactoring to a shared context comes later.
export default function StorePicker() {
  const { profile, isEmployee } = useAuthGate();
  const [stores, setStores] = useState<Array<{ id: string; name: string }>>([]);
  const [switching, setSwitching] = useState(false);

  // Drop stale responses so the dropdown reflects the freshest mapping
  // even if HQ assigns the worker to another store mid-session.
  const loadTokenRef = useRef(0);
  const loadAssigned = useCallback(async () => {
    if (!isEmployee || !profile?.id) {
      setStores([]);
      return;
    }
    const myToken = ++loadTokenRef.current;
    const { data } = await supabase
      .from("profile_stores")
      .select("store_id,stores(id,name)")
      .eq("user_id", profile.id);
    if (myToken !== loadTokenRef.current) return;
    type Row = { store_id: string; stores: { id: string; name: string } | null };
    const rows = (data as Row[] | null) ?? [];
    setStores(
      rows
        .map((r) => r.stores)
        .filter((s): s is { id: string; name: string } => !!s)
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }, [isEmployee, profile?.id]);

  useEffect(() => {
    loadAssigned();
  }, [loadAssigned]);

  // Live-update if HQ adds/removes a store assignment while the worker
  // has the page open. Subscribing to `stores` too covers the unusual
  // case where a store is renamed.
  useRealtimeRefetch(
    isEmployee && profile?.id
      ? [{ table: "profile_stores" }, { table: "stores" }]
      : [],
    loadAssigned,
    `store-picker-${profile?.id ?? "anon"}`,
  );

  if (!isEmployee || stores.length < 2) return null;

  const handleChange = async (newStoreId: string) => {
    if (!profile?.id || newStoreId === profile.store_id) return;
    setSwitching(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ store_id: newStoreId })
        .eq("id", profile.id);
      if (error) {
        alert(`Couldn't switch store: ${error.message}`);
        return;
      }
      // Reload so every component re-reads the new active store via useAuthGate.
      window.location.reload();
    } catch (err) {
      alert(`Couldn't switch store: ${err instanceof Error ? err.message : "network timeout"}. Try again.`);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">
        Store:
      </span>
      <select
        value={profile?.store_id ?? ""}
        onChange={(e) => handleChange(e.target.value)}
        disabled={switching}
        className="rounded-full border border-white/10 bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white outline-none focus:border-cyan-400 disabled:opacity-50"
      >
        {stores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </div>
  );
}
