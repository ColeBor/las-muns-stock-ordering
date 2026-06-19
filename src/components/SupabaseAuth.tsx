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

// Resolved labels (store / factory name) for the currently-signed-in user,
// fetched separately so we can display "Store: Bramalea" instead of the raw
// UUID. Looked up only when profile.store_id / factory_id is non-null.
type AssignmentLabels = {
  storeName: string | null;
  factoryName: string | null;
};

const ROLE_LABEL: Record<string, string> = {
  store_manager: "Store Manager",
  employee: "Employee",
  factory_worker: "Factory Worker",
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
  const [assignmentLabels, setAssignmentLabels] = useState<AssignmentLabels>({
    storeName: null,
    factoryName: null,
  });
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [factories, setFactories] = useState<Factory[]>([]);
  // Map of userId → list of store ids assigned to that user. Drives the
  // multi-store checkboxes in the admin profile editor.
  const [profileStoresByUser, setProfileStoresByUser] = useState<Record<string, string[]>>({});
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

  // Resolve store / factory names for the current user. Employees and
  // Factory Workers only see their own; Store Managers see whichever store
  // or factory they happen to have assigned (often none, since the role
  // doesn't require an assignment).
  useEffect(() => {
    let alive = true;
    const resolve = async () => {
      if (!profile?.store_id && !profile?.factory_id) {
        if (alive) setAssignmentLabels({ storeName: null, factoryName: null });
        return;
      }
      const [storeRes, factoryRes] = await Promise.all([
        profile.store_id
          ? supabase.from("stores").select("name").eq("id", profile.store_id).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        profile.factory_id
          ? supabase.from("factories").select("name").eq("id", profile.factory_id).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);
      if (!alive) return;
      setAssignmentLabels({
        storeName: (storeRes.data as { name: string } | null)?.name ?? null,
        factoryName: (factoryRes.data as { name: string } | null)?.name ?? null,
      });
    };
    resolve();
    return () => {
      alive = false;
    };
  }, [profile?.store_id, profile?.factory_id]);

  const isSignedIn = useMemo(() => !!session?.user, [session]);
  const isStoreManager = useMemo(() => profile?.role === "store_manager", [profile]);

  useEffect(() => {
    if (!isStoreManager) {
      setAllProfiles([]);
      setStores([]);
      setFactories([]);
      return;
    }

    const loadAdminData = async () => {
      const [storesRes, factoriesRes, profilesRes, psRes] = await Promise.all([
        supabase.from("stores").select("id,name").order("name"),
        supabase.from("factories").select("id,name").order("name"),
        supabase.from("profiles").select("id,email,display_name,role,store_id,factory_id"),
        supabase.from("profile_stores").select("user_id,store_id"),
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

      if (!psRes.error && psRes.data) {
        const map: Record<string, string[]> = {};
        for (const row of psRes.data as Array<{ user_id: string; store_id: string }>) {
          (map[row.user_id] ??= []).push(row.store_id);
        }
        setProfileStoresByUser(map);
      }
    };

    loadAdminData();
  }, [isStoreManager]);

  // Toggle a single store assignment for a user. If the user has no active
  // store_id yet, default it to the just-added store; if the toggled-off
  // store was their active one, swap to the first remaining (or null).
  const toggleStoreAssignment = async (
    userId: string,
    storeId: string,
    currentlyAssigned: boolean,
  ) => {
    setAdminLoading(true);
    setAdminMessage(null);

    try {
      if (currentlyAssigned) {
        const { error } = await supabase
          .from("profile_stores")
          .delete()
          .eq("user_id", userId)
          .eq("store_id", storeId);
        if (error) {
          setAdminMessage(error.message);
          return;
        }
      } else {
        const { error } = await supabase
          .from("profile_stores")
          .insert([{ user_id: userId, store_id: storeId }]);
        if (error) {
          setAdminMessage(error.message);
          return;
        }
      }

      // Keep profiles.store_id consistent with the new assignment set.
      const user = allProfiles.find((p) => p.id === userId);
      const newAssigned = currentlyAssigned
        ? (profileStoresByUser[userId] ?? []).filter((s) => s !== storeId)
        : [...(profileStoresByUser[userId] ?? []), storeId];
      let newActive: string | null = user?.store_id ?? null;
      if (newActive && !newAssigned.includes(newActive)) {
        newActive = newAssigned[0] ?? null;
      } else if (!newActive && newAssigned.length > 0) {
        newActive = newAssigned[0];
      }
      if (newActive !== (user?.store_id ?? null)) {
        await supabase
          .from("profiles")
          .update({ store_id: newActive })
          .eq("id", userId);
      }

      // Reload admin data for fresh state.
      const [profilesRes, psRes] = await Promise.all([
        supabase.from("profiles").select("id,email,display_name,role,store_id,factory_id"),
        supabase.from("profile_stores").select("user_id,store_id"),
      ]);
      if (!profilesRes.error && profilesRes.data) {
        setAllProfiles(profilesRes.data as Profile[]);
      }
      if (!psRes.error && psRes.data) {
        const map: Record<string, string[]> = {};
        for (const row of psRes.data as Array<{ user_id: string; store_id: string }>) {
          (map[row.user_id] ??= []).push(row.store_id);
        }
        setProfileStoresByUser(map);
      }

      setAdminMessage("Assignment updated.");
    } catch (err) {
      setAdminMessage(
        `Couldn't update assignment: ${err instanceof Error ? err.message : "network timeout"}. Try again.`,
      );
    } finally {
      setAdminLoading(false);
    }
  };

  const signInWithPassword = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setMessage(null);

    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setMessage(error.message);
        return;
      }

      setMessage("Signed in successfully!");
      setEmail("");
      setPassword("");
    } catch (err) {
      setMessage(
        `Couldn't sign in: ${err instanceof Error ? err.message : "network timeout"}. Try again.`,
      );
    } finally {
      setLoading(false);
    }
  };

  const signInWithOtp = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setMessage(null);

    try {
      const { error } = await supabase.auth.signInWithOtp({ email });
      if (error) {
        setMessage(error.message);
        return;
      }

      setMessage("Check your email for a magic sign-in link.");
      setEmail("");
      setPassword("");
    } catch (err) {
      setMessage(
        `Couldn't send magic link: ${err instanceof Error ? err.message : "network timeout"}. Try again.`,
      );
    } finally {
      setLoading(false);
    }
  };

  const updateProfile = async (
    profileId: string,
    patch: Partial<Pick<Profile, "display_name" | "role" | "store_id" | "factory_id">>,
  ) => {
    setAdminLoading(true);
    setAdminMessage(null);

    try {
      const { error } = await supabase
        .from("profiles")
        .update(patch)
        .eq("id", profileId);

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
    } catch (err) {
      setAdminMessage(
        `Couldn't update profile: ${err instanceof Error ? err.message : "network timeout"}. Try again.`,
      );
    } finally {
      setAdminLoading(false);
    }
  };

  const signOut = async () => {
    setLoading(true);
    try {
      await supabase.auth.signOut();
      setProfile(null);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Couldn't sign out:", err);
    } finally {
      setLoading(false);
    }
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
              {assignmentLabels.storeName ? ` · Store: ${assignmentLabels.storeName}` : ""}
              {assignmentLabels.factoryName ? ` · Factory: ${assignmentLabels.factoryName}` : ""}
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

          {isStoreManager ? (
            <section className="rounded-3xl border border-cyan-500/20 bg-slate-900/90 p-6 text-sm text-slate-300">
              <h3 className="text-lg font-semibold text-white">Role &amp; Assignment Center</h3>
              <p className="mt-2 text-slate-400">
                Assign Employees to stores and update roles for non-Store-Manager profiles.
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
                              value={userProfile.role ?? "employee"}
                              onChange={(event) =>
                                updateProfile(userProfile.id, {
                                  role: event.target.value,
                                  store_id:
                                    event.target.value === "employee"
                                      ? userProfile.store_id
                                      : null,
                                  factory_id:
                                    event.target.value === "factory_worker"
                                      ? userProfile.factory_id
                                      : null,
                                })
                              }
                              className="rounded-full border border-white/10 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none"
                            >
                              <option value="store_manager">Store Manager</option>
                              <option value="employee">Employee</option>
                              <option value="factory_worker">Factory Worker</option>
                            </select>

                            {userProfile.role === "employee" && (() => {
                              const assigned = profileStoresByUser[userProfile.id] ?? [];
                              return (
                                <>
                                  <label className="block text-xs font-medium text-slate-400">
                                    Assigned stores
                                  </label>
                                  <div className="flex flex-wrap gap-2">
                                    {stores.length === 0 ? (
                                      <span className="text-xs text-slate-500">
                                        No stores yet — create one under Directory.
                                      </span>
                                    ) : (
                                      stores.map((store) => {
                                        const selected = assigned.includes(store.id);
                                        return (
                                          <button
                                            key={store.id}
                                            type="button"
                                            disabled={adminLoading}
                                            onClick={() =>
                                              toggleStoreAssignment(
                                                userProfile.id,
                                                store.id,
                                                selected,
                                              )
                                            }
                                            className={`rounded-full px-3 py-1 text-xs font-semibold transition disabled:opacity-50 ${
                                              selected
                                                ? "bg-cyan-500 text-slate-950"
                                                : "bg-slate-800 text-slate-200 hover:bg-slate-700"
                                            }`}
                                          >
                                            {selected ? "✓ " : ""}{store.name}
                                          </button>
                                        );
                                      })
                                    )}
                                  </div>
                                  {assigned.length > 1 && (
                                    <p className="mt-1 text-xs text-slate-500">
                                      Active store: {stores.find((s) => s.id === userProfile.store_id)?.name ?? "(none)"}. The worker picks which one they're at via the Store dropdown on their nav.
                                    </p>
                                  )}
                                </>
                              );
                            })()}

                            {userProfile.role === "factory_worker" && (
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
