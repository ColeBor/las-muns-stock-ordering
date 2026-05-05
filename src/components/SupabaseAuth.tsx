"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "@/lib/supabaseClient";

type Profile = {
  id: string;
  role: string | null;
  store_id: string | null;
  factory_id: string | null;
};

type Store = {
  id: string;
  name: string;
};

export default function SupabaseAuth() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [usePassword, setUsePassword] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [adminMessage, setAdminMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [adminLoading, setAdminLoading] = useState(false);

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
        .select("role, store_id, factory_id")
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

  const isSignedIn = useMemo(() => !!session?.user, [session]);
  const isHQAdmin = useMemo(() => profile?.role === "hq_admin", [profile]);

  useEffect(() => {
    if (!isHQAdmin) {
      setAllProfiles([]);
      setStores([]);
      return;
    }

    const loadAdminData = async () => {
      const [{ data: storesData, error: storesError }, { data: profilesData, error: profilesError }] = await Promise.all([
        supabase.from("stores").select("id,name").order("name"),
        supabase.from("profiles").select("id,role,store_id,factory_id"),
      ]);

      if (!storesError && storesData) {
        setStores(storesData as Store[]);
      }

      if (!profilesError && profilesData) {
        setAllProfiles(profilesData as Profile[]);
      }
    };

    loadAdminData();
  }, [isHQAdmin]);

  const signInWithPassword = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setMessage(null);

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage("Signed in successfully!");
    setEmail("");
    setPassword("");
  };

  const signInWithOtp = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setMessage(null);

    const { error } = await supabase.auth.signInWithOtp({ email });
    setLoading(false);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage("Check your email for a magic sign-in link.");
    setEmail("");
    setPassword("");
  };

  const signInWithGitHub = async () => {
    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({ provider: "github" });
    setLoading(false);
    if (error) {
      setMessage(error.message);
    }
  };

  const updateProfileAssignment = async (profileId: string, newRole: string, newStoreId: string | null) => {
    setAdminLoading(true);
    setAdminMessage(null);

    const { error } = await supabase
      .from("profiles")
      .update({ role: newRole, store_id: newRole === "store_manager" ? newStoreId : null })
      .eq("id", profileId);

    setAdminLoading(false);

    if (error) {
      setAdminMessage(error.message);
      return;
    }

    setAdminMessage("Profile assignment updated successfully.");
    const { data: profilesData } = await supabase.from("profiles").select("id,role,store_id,factory_id");

    if (profilesData) {
      setAllProfiles(profilesData as Profile[]);
    }
  };

  const signOut = async () => {
    setLoading(true);
    await supabase.auth.signOut();
    setLoading(false);
    setProfile(null);
  };

  return (
    <section className="rounded-3xl border border-white/10 bg-slate-950/90 p-6 text-sm text-slate-300 shadow-lg shadow-slate-950/20">
      <h2 className="text-xl font-semibold text-white">Authentication</h2>
      {isSignedIn ? (
        <div className="mt-4 space-y-4">
          <div className="rounded-2xl bg-slate-900/90 p-4">
            <p className="text-slate-300">Signed in as:</p>
            <p className="text-white">{session?.user?.email ?? session?.user?.id}</p>
            <p className="mt-2 text-slate-400">
              Role: {profile?.role ?? "Not assigned"}
              {profile?.store_id ? ` · Store ID: ${profile.store_id}` : ""}
              {profile?.factory_id ? ` · Factory ID: ${profile.factory_id}` : ""}
            </p>
          </div>

          <button
            type="button"
            onClick={signOut}
            className="inline-flex items-center justify-center rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-slate-200"
            disabled={loading}
          >
            Sign out
          </button>

          {isHQAdmin ? (
            <section className="rounded-3xl border border-cyan-500/20 bg-slate-900/90 p-6 text-sm text-slate-300">
              <h3 className="text-lg font-semibold text-white">HQ assignment center</h3>
              <p className="mt-2 text-slate-400">
                Assign store managers to stores and update roles for non-administrative profiles.
              </p>

              <div className="mt-4 space-y-4">
                {adminMessage ? <p className="text-sm text-cyan-300">{adminMessage}</p> : null}
                <div className="grid gap-4">
                  {allProfiles.length === 0 ? (
                    <p className="text-slate-400">No profiles found yet.</p>
                  ) : (
                    allProfiles.map((userProfile) => (
                      <div
                        key={userProfile.id}
                        className="rounded-2xl border border-white/10 bg-slate-950/80 p-4"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="text-slate-300">Profile ID: {userProfile.id}</p>
                            <p className="text-slate-400">Current role: {userProfile.role}</p>
                          </div>
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <select
                              value={userProfile.role ?? "store_manager"}
                              onChange={async (event) => {
                                const newRole = event.target.value;
                                await updateProfileAssignment(userProfile.id, newRole, userProfile.store_id);
                              }}
                              className="rounded-full border border-white/10 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none"
                            >
                              <option value="store_manager">Store manager</option>
                              <option value="factory_user">Factory user</option>
                            </select>
                            <select
                              value={userProfile.store_id ?? ""}
                              onChange={async (event) => {
                                const newStoreId = event.target.value || null;
                                await updateProfileAssignment(userProfile.id, userProfile.role ?? "store_manager", newStoreId);
                              }}
                              disabled={userProfile.role !== "store_manager"}
                              className="rounded-full border border-white/10 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <option value="">Unassigned store</option>
                              {stores.map((store) => (
                                <option key={store.id} value={store.id}>
                                  {store.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </section>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <p className="text-slate-400">Sign in with email and password, magic link, or GitHub.</p>
          
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setUsePassword(true)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                usePassword 
                  ? "bg-cyan-500 text-slate-950" 
                  : "border border-white/10 bg-slate-900 text-slate-400 hover:border-cyan-300 hover:text-cyan-300"
              }`}
            >
              Password
            </button>
            <button
              type="button"
              onClick={() => setUsePassword(false)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                !usePassword 
                  ? "bg-cyan-500 text-slate-950" 
                  : "border border-white/10 bg-slate-900 text-slate-400 hover:border-cyan-300 hover:text-cyan-300"
              }`}
            >
              Magic Link
            </button>
          </div>

          {usePassword ? (
            <form onSubmit={signInWithPassword} className="flex flex-col gap-3 sm:flex-row">
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                className="flex-1 rounded-full border border-white/10 bg-slate-900 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400"
                required
              />
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="password"
                className="flex-1 rounded-full border border-white/10 bg-slate-900 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400"
                required
              />
              <button
                type="submit"
                disabled={loading}
                className="rounded-full bg-cyan-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
              >
                Sign in
              </button>
            </form>
          ) : (
            <form onSubmit={signInWithOtp} className="flex flex-col gap-3 sm:flex-row">
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                className="flex-1 rounded-full border border-white/10 bg-slate-900 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400"
                required
              />
              <button
                type="submit"
                disabled={loading}
                className="rounded-full bg-cyan-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
              >
                Send magic link
              </button>
            </form>
          )}

          <button
            type="button"
            onClick={signInWithGitHub}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-full border border-white/10 bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:border-cyan-300 hover:text-cyan-300"
          >
            Sign in with GitHub
          </button>

          {message ? <p className="text-sm text-cyan-300">{message}</p> : null}
        </div>
      )}
    </section>
  );
}
