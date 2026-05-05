"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

const ROLE_CACHE_KEY = "lm-cached-role";

export default function HomeAdminLinks() {
  const [isHQAdmin, setIsHQAdmin] = useState(false);

  useEffect(() => {
    const cached = localStorage.getItem(ROLE_CACHE_KEY);
    if (cached === "hq_admin") setIsHQAdmin(true);

    let active = true;

    const refresh = async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData.session?.user?.id;
      if (!userId) {
        if (active) setIsHQAdmin(false);
        localStorage.removeItem(ROLE_CACHE_KEY);
        return;
      }
      const { data } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", userId)
        .single();
      const role = data?.role ?? "";
      if (active) setIsHQAdmin(role === "hq_admin");
      if (role) localStorage.setItem(ROLE_CACHE_KEY, role);
      else localStorage.removeItem(ROLE_CACHE_KEY);
    };

    refresh();

    const { data: listener } = supabase.auth.onAuthStateChange(() => {
      refresh();
    });

    return () => {
      active = false;
      listener?.subscription.unsubscribe();
    };
  }, []);

  if (!isHQAdmin) return null;

  return (
    <>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Admin workflow</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Link
            href="/factory-stock"
            className="inline-flex items-center justify-center rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
          >
            Factory stock
          </Link>
          <Link
            href="/delivery-orders"
            className="inline-flex items-center justify-center rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
          >
            Delivery orders
          </Link>
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">HQ admin</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Link
            href="/admin/stores"
            className="inline-flex items-center justify-center rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-slate-200"
          >
            Stores
          </Link>
          <Link
            href="/admin/factories"
            className="inline-flex items-center justify-center rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
          >
            Factories
          </Link>
          <Link
            href="/admin/suppliers"
            className="inline-flex items-center justify-center rounded-full bg-green-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-green-400"
          >
            Suppliers
          </Link>
          <Link
            href="/admin/items"
            className="inline-flex items-center justify-center rounded-full bg-purple-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-purple-400"
          >
            Items
          </Link>
          <Link
            href="/admin/cycles"
            className="inline-flex items-center justify-center rounded-full bg-yellow-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-yellow-400"
          >
            Cycles
          </Link>
        </div>
      </div>
    </>
  );
}
