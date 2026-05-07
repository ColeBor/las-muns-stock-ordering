"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "@/lib/supabaseClient";

type Profile = {
  id: string;
  email: string | null;
  display_name: string | null;
  role: string | null;
  store_id: string | null;
  factory_id: string | null;
};

const ROLE_LABEL: Record<string, string> = {
  hq_admin: "Store Manager",
  store_manager: "Employee",
  factory_user: "Factory Worker",
};
const formatRole = (role: string | null | undefined) =>
  role ? (ROLE_LABEL[role] ?? role) : "Not assigned";

type Store = {
  id: string;
  name: string;
};

type Factory = {
  id: string;
  name: string;
};

export default function SupabaseAuth() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"] | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [factories, setFactories] = useState<Factory[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [usePassword, setUsePassword] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [adminMessage, setAdminMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [adminLoading, setAdminLoading] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [displayNameDraft, setDisplayNameDraft] = useState<string>("");

  useEffect(() => {
    const loadSession = async () => {
      const { data } = await supabase.auth.getSession();
      setSession(data.session);
      setSessionLoading(false);
    };

    loadSession();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, sessionData) => {
      setSession(sessionData ?? null);
      setSessionLoading(false);
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
      setFactories([]);
      return;
    }

    const loadAdminData = async () => {
      const [storesRes, factoriesRes, profilesRes] = await Promise.all([
        supabase.from("stores").select("id,name").order("name"),
        supabase.from("factories").select("id,name").order("name"),
        supabase.from("profiles").select("id,email,display_name,role,store_id,factory_id"),
      ]);

      if (!storesRes.error && storesRes.data) {
        setStores(storesRes.data as Store[]);
      }

      if (!factoriesRes.error && factoriesRes.data) {
        setFactories(factoriesRes.data as Factory[]);
      }

      if (!profilesRes.error && profilesRes.data) {
        setAllProfiles(profilesRes.data as Profile[]);
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

  const updateProfile = async (
    profileId: string,
    patch: Partial<Pick<Profile, "display_name" | "role" | "store_id" | "factory_id">>,
  ) => {
    setAdminLoading(true);
    setAdminMessage(null);

    const { error } = await supabase
      .from("profiles")
      .update(patch)
      .eq("id", profileId);

    setAdminLoading(false);

    if (error) {
      setAdminMessage(error.message);
      return;
    }

    setAdminMessage("Profile updated.");
    const { data: profilesData } = await supabase
      .from("profiles")
      .select("id,email,display_name,role,store_id,factory_id");

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
      {sessionLoading ? (
        <div className="mt-4 rounded-2xl bg-slate-900/90 p-4 text-slate-400">Loading…</div>
      ) : isSignedIn ? (
        <div className="mt-4 space-y-4">
          <div className="rounded-2xl bg-slate-900/90 p-4">
            <p className="text-slate-300">Signed in as:</p>
            <p className="text-white">{session?.user?.email ?? session?.user?.id}</p>
            <p className="mt-2 text-slate-400">
              Role: {formatRole(profile?.role)}
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
                {allProfiles.length === 0 ? (
                  <p className="text-slate-400">No profiles found yet.</p>
                ) : (
                  <>
                    <select
                      value={selectedProfileId}
                      onChange={(e) => {
                        setSelectedProfileId(e.target.value);
                        const picked = allProfiles.find((p) => p.id === e.target.value);
                        setDisplayNameDraft(picked?.display_name ?? "");
                      }}
                      className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-2 text-sm text-white outline-none focus:border-cyan-400"
                    >
                      <option value="">(Pick an account to manage)</option>
                      {allProfiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.display_name?.trim() ||
                            p.email ||
                            p.id.slice(0, 8)}
                          {" — "}
                          {formatRole(p.role)}
                        </option>
                      ))}
                    </select>

                    {(() => {
                      const userProfile = allProfiles.find(
                        (p) => p.id === selectedProfileId,
                      );
                      if (!userProfile) return null;
                      return (
                        <div className="rounded-2xl border border-white/10 bg-slate-950/80 p-4 space-y-3">
                          <div>
                            <p className="text-xs text-slate-500 break-all">
                              {userProfile.email ?? userProfile.id}
                            </p>
                            <p className="text-slate-400">
                              Current role: {formatRole(userProfile.role)}
                            </p>
                          </div>

                          <div>
                            <label className="block text-xs font-medium text-slate-400 mb-1">
                              Display name
                            </label>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={displayNameDraft}
                                onChange={(e) =>
                                  setDisplayNameDraft(e.target.value)
                                }
                                placeholder="e.g. Store A iPad"
                                className="flex-1 rounded-full border border-white/10 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400"
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  updateProfile(userProfile.id, {
                                    display_name:
                                      displayNameDraft.trim() || null,
                                  })
                                }
                                disabled={
                                  adminLoading ||
                                  (displayNameDraft.trim() ===
                                    (userProfile.display_name ?? ""))
                                }
                                className="rounded-full bg-cyan-500 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-50"
                              >
                                Save
                              </button>
                            </div>
                          </div>

                          <div className="flex flex-col gap-2">
                            <label className="block text-xs font-medium text-slate-400">
                              Role
                            </label>
                            <select
                              value={userProfile.role ?? "store_manager"}
                              onChange={(event) =>
                                updateProfile(userProfile.id, {
                                  role: event.target.value,
                                  store_id:
                                    event.target.value === "store_manager"
                                      ? userProfile.store_id
                                      : null,
                                  factory_id:
                                    event.target.value === "factory_user"
                                      ? userProfile.factory_id
                                      : null,
                                })
                              }
                              className="rounded-full border border-white/10 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none"
                            >
                              <option value="hq_admin">Store Manager</option>
                              <option value="store_manager">Employee</option>
                              <option value="factory_user">Factory Worker</option>
                            </select>

                            {userProfile.role === "store_manager" && (
                              <>
                                <label className="block text-xs font-medium text-slate-400">
                                  Assigned store
                                </label>
                                <select
                                  value={userProfile.store_id ?? ""}
                                  onChange={(event) =>
                                    updateProfile(userProfile.id, {
                                      store_id: event.target.value || null,
                                    })
                                  }
                                  className="rounded-full border border-white/10 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none"
                                >
                                  <option value="">Unassigned store</option>
                                  {stores.map((store) => (
                                    <option key={store.id} value={store.id}>
                                      {store.name}
                                    </option>
                                  ))}
                                </select>
                              </>
                            )}

                            {userProfile.role === "factory_user" && (
                              <>
                                <label className="block text-xs font-medium text-slate-400">
                                  Assigned factory
                                </label>
                                <select
                                  value={userProfile.factory_id ?? ""}
                                  onChange={(event) =>
                                    updateProfile(userProfile.id, {
                                      factory_id: event.target.value || null,
                                    })
                                  }
                                  className="rounded-full border border-white/10 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none"
                                >
                                  <option value="">Unassigned factory</option>
                                  {factories.map((factory) => (
                                    <option key={factory.id} value={factory.id}>
                                      {factory.name}
                                    </option>
                                  ))}
                                </select>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>
            </section>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <p className="text-slate-400">Sign in with email and password or magic link.</p>
          
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
            <form onSubmit={signInWithPassword} className="flex flex-col gap-3">
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-full border border-white/10 bg-slate-900 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400"
                required
              />
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="password"
                className="w-full rounded-full border border-white/10 bg-slate-900 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400"
                required
              />
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-full bg-cyan-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
              >
                Sign in
              </button>
            </form>
          ) : (
            <form onSubmit={signInWithOtp} className="flex flex-col gap-3">
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-full border border-white/10 bg-slate-900 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400"
                required
              />
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-full bg-cyan-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
              >
                Send magic link
              </button>
            </form>
          )}

          {message ? <p className="text-sm text-cyan-300">{message}</p> : null}
        </div>
      )}
    </section>
  );
}
