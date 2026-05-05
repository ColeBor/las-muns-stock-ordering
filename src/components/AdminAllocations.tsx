"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Profile = {
  id: string;
  role: string | null;
};

type OrderCycle = {
  id: string;
  name: string;
  status: string;
};

export default function AdminAllocations() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [cycles, setCycles] = useState<OrderCycle[]>([]);
  const [selectedCycleId, setSelectedCycleId] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageType, setMessageType] = useState<"success" | "error" | null>(null);

  const isSignedIn = useMemo(() => !!session?.user, [session]);
  const isHQAdmin = useMemo(() => profile?.role === "hq_admin", [profile]);

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
        .select("id,role")
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
    if (!isHQAdmin) {
      setCycles([]);
      return;
    }

    const loadCycles = async () => {
      const { data } = await supabase
        .from("order_cycles")
        .select("id,name,status")
        .order("started_at", { ascending: false })
        .limit(10);

      if (data) {
        setCycles(data as OrderCycle[]);
        if (data.length > 0 && !selectedCycleId) {
          setSelectedCycleId(data[0].id);
        }
      }
    };

    loadCycles();
  }, [isHQAdmin, selectedCycleId]);

  const runAllocations = async () => {
    if (!selectedCycleId) {
      setMessage("Please select an order cycle");
      setMessageType("error");
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const response = await fetch("/api/allocations/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cycle_id: selectedCycleId }),
      });

      const data = await response.json();

      if (!response.ok) {
        setMessage(`Error: ${data.error}`);
        setMessageType("error");
      } else {
        const parts = [
          `${data.allocations_created} allocations`,
          `${data.purchase_orders_created} purchase orders`,
          `${data.shortfalls} shortfalls`,
        ];
        setMessage(`✅ ${data.message} — ${parts.join(", ")}`);
        setMessageType("success");
      }
    } catch (error) {
      setMessage(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
      setMessageType("error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-8 text-slate-100 shadow-lg shadow-slate-950/20">
      <h1 className="text-3xl font-semibold text-white">Allocations</h1>
      <p className="mt-3 text-slate-400">
        Run the allocation algorithm to assign store orders to factories.
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
          <div>
            <label htmlFor="cycle" className="block text-sm font-medium text-slate-300">
              Select order cycle
            </label>
            <select
              id="cycle"
              value={selectedCycleId}
              onChange={(e) => setSelectedCycleId(e.target.value)}
              className="mt-2 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400"
            >
              <option value="">-- Choose a cycle --</option>
              {cycles.map((cycle) => (
                <option key={cycle.id} value={cycle.id}>
                  {cycle.name} ({cycle.status})
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={runAllocations}
            disabled={loading || !selectedCycleId}
            className="rounded-2xl bg-cyan-500 px-6 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Running..." : "Run allocations"}
          </button>

          {message && (
            <div
              className={`rounded-2xl p-4 ${
                messageType === "success"
                  ? "bg-green-950/80 text-green-200"
                  : "bg-rose-950/80 text-rose-200"
              }`}
            >
              <p className="text-sm">{message}</p>
            </div>
          )}

          <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-6">
            <h2 className="text-lg font-semibold text-white">How it works</h2>
            <ul className="mt-3 space-y-2 text-sm text-slate-300">
              <li>• Reads all store orders (stock entries) for the cycle</li>
              <li>• For each item ordered, finds assigned factories (by priority)</li>
              <li>• Allocates from each factory up to available quantity (minus 1-unit reserve)</li>
              <li>• Creates allocation records that appear in the delivery orders summary</li>
              <li>• Clears previous allocations for this cycle before running</li>
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
