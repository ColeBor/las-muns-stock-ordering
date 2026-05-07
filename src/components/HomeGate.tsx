"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import SupabaseAuth from "./SupabaseAuth";
import HomeAdminLinks from "./HomeAdminLinks";

type ProfileRow = { role: string | null };

export default function HomeGate() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [role, setRole] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setSession(data.session);
      setSessionLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) => {
      if (!alive) return;
      setSession(s ?? null);
      setSessionLoading(false);
    });
    return () => {
      alive = false;
      listener?.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    if (!session?.user) {
      setRole(undefined);
      return;
    }
    supabase
      .from("profiles")
      .select("role")
      .eq("id", session.user.id)
      .single()
      .then(({ data, error }) => {
        if (!alive) return;
        if (error || !data) {
          setRole(null);
          return;
        }
        setRole((data as ProfileRow).role);
      });
    return () => {
      alive = false;
    };
  }, [session]);

  useEffect(() => {
    if (role === "store_manager") {
      router.replace("/store-stock-entry");
    }
  }, [role, router]);

  if (sessionLoading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-50">
        <main className="flex min-h-screen items-center justify-center px-6">
          <p className="text-slate-400">Loading…</p>
        </main>
      </div>
    );
  }

  if (!session?.user) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-50">
        <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
          <div className="space-y-3 text-center">
            <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Las Muns Order
            </h1>
            <p className="text-sm text-slate-400">Sign in to continue.</p>
          </div>
          <div className="mt-8">
            <SupabaseAuth />
          </div>
        </main>
      </div>
    );
  }

  if (role === "store_manager") {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-50">
        <main className="flex min-h-screen items-center justify-center px-6">
          <p className="text-slate-400">Redirecting to your store…</p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      <main className="mx-auto flex min-h-screen max-w-6xl flex-col justify-center px-6 py-16 sm:px-10">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div className="rounded-3xl border border-white/10 bg-slate-900/80 p-10 shadow-2xl shadow-slate-950/40 backdrop-blur-xl">
            <div className="flex flex-col gap-6">
              <div className="space-y-3">
                <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                  Las Muns Order
                </h1>
              </div>

              <div className="space-y-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Daily workflow</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Link
                      href="/store-stock-entry"
                      className="inline-flex items-center justify-center rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-slate-200"
                    >
                      Store Stock Entry
                    </Link>
                  </div>
                </div>

                <HomeAdminLinks />
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <SupabaseAuth />
          </div>
        </div>
      </main>
    </div>
  );
}
