"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";

export type AuthProfile = {
  id: string;
  role: string | null;
  store_id: string | null;
  factory_id: string | null;
};

export type AuthGate = {
  session: Session | null;
  profile: AuthProfile | null;
  loading: boolean;
  isSignedIn: boolean;
  isStoreManager: boolean;
  isEmployee: boolean;
};

// Centralised session + profile loading. Returned `loading` covers both:
// session-not-yet-known AND session-known-but-profile-not-yet-fetched. Callers
// should render a loading state when `loading` is true and only branch on
// isSignedIn / isStoreManager after that. Solves a race where the page
// flashed "This page is only available to Store Managers" between the
// session resolving and the profile fetch completing.
export function useAuthGate(): AuthGate {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [profile, setProfile] = useState<AuthProfile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);

  useEffect(() => {
    let alive = true;

    // supabase-js v2 fires INITIAL_SESSION on subscribe, which is the
    // primary signal here. getSession() is a defensive fallback in case
    // the initial event is delayed (rare browser-storage edge cases or
    // cross-tab lock contention). The timer is a final safety net so
    // the UI doesn't sit on "Loading…" indefinitely if neither resolves.
    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) => {
      if (!alive) return;
      // Supabase emits onAuthStateChange for TOKEN_REFRESHED and tab-focus
      // pings, not just sign-in/out. Each event hands us a fresh `Session`
      // object even when the logical user hasn't changed. Without this
      // identity check every refresh would set new state, re-run the
      // profile-fetch effect, and flicker the page back to "Loading…".
      setSession((prev) => {
        const prevId = prev?.user?.id ?? null;
        const nextId = s?.user?.id ?? null;
        return prevId === nextId ? prev : s ?? null;
      });
      setSessionLoaded(true);
    });

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!alive) return;
        setSession((curr) => curr ?? data.session);
        setSessionLoaded(true);
      })
      .catch(() => {
        if (!alive) return;
        setSessionLoaded(true);
      });

    const timer = window.setTimeout(() => {
      if (!alive) return;
      setSessionLoaded(true);
    }, 4000);

    return () => {
      alive = false;
      window.clearTimeout(timer);
      listener?.subscription.unsubscribe();
    };
  }, []);

  // Profile fetch keyed off the user id (a stable string), not the
  // Session object reference. This insulates the fetch from token
  // refreshes and other onAuthStateChange events that swap the Session
  // object without changing who is signed in.
  const userId = session?.user?.id ?? null;

  useEffect(() => {
    if (!sessionLoaded) return;
    let alive = true;
    setProfileLoaded(false);

    (async () => {
      if (!userId) {
        if (!alive) return;
        setProfile(null);
        setProfileLoaded(true);
        return;
      }
      const { data } = await supabase
        .from("profiles")
        .select("id,role,store_id,factory_id")
        .eq("id", userId)
        .single();
      if (!alive) return;
      setProfile((data as AuthProfile) ?? null);
      setProfileLoaded(true);
    })();

    return () => {
      alive = false;
    };
  }, [userId, sessionLoaded]);

  return {
    session,
    profile,
    loading: !sessionLoaded || (!!session?.user && !profileLoaded),
    isSignedIn: sessionLoaded && !!session?.user,
    isStoreManager: profile?.role === "store_manager",
    isEmployee: profile?.role === "employee",
  };
}
