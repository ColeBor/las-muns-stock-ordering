"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

// Opt-in / opt-out of Web Push on THIS device. The service worker is already
// registered app-wide (ServiceWorkerRegister); this hook only handles the
// per-device subscription + writing it to push_subscriptions.
//
// Status the UI branches on:
//   unsupported   — browser has no Push API and it isn't an installable iOS
//                   case either (e.g. a desktop browser without push).
//   needs-install — iOS Safari NOT launched from the home screen. iOS only
//                   exposes Push to installed PWAs, so the user must "Add to
//                   Home Screen" first. The UI shows the walkthrough.
//   default       — supported, permission not yet asked / not subscribed.
//   denied        — the user blocked notifications in the browser.
//   subscribed    — an active subscription exists and is saved.

export type PushStatus =
  | "loading"
  | "unsupported"
  | "needs-install"
  | "default"
  | "denied"
  | "subscribed";

const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

// VAPID public key arrives base64url-encoded; the Push API wants raw bytes.
// Return an ArrayBuffer (a valid BufferSource) rather than a Uint8Array — the
// DOM applicationServerKey type rejects the Uint8Array<ArrayBufferLike> union.
function urlBase64ToBytes(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) view[i] = raw.charCodeAt(i);
  return buffer;
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ reports as "Macintosh"; the touch-point check disambiguates it
  // from a real Mac (which can't install a PWA the iOS way).
  return (
    /iphone|ipad|ipod/i.test(ua) ||
    (/Macintosh/.test(ua) && typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // iOS exposes navigator.standalone; everyone else uses the display-mode MQ.
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function usePushNotifications() {
  const [status, setStatus] = useState<PushStatus>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ios, setIos] = useState(false);

  const computeStatus = useCallback(async () => {
    const onIos = isIos();
    setIos(onIos);

    const hasPush =
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;

    if (!hasPush) {
      // On iOS, a non-installed Safari tab genuinely lacks the Push API — that
      // isn't "unsupported", it's "install first".
      setStatus(onIos && !isStandalone() ? "needs-install" : "unsupported");
      return;
    }

    if (Notification.permission === "denied") {
      setStatus("denied");
      return;
    }

    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    setStatus(existing ? "subscribed" : "default");
  }, []);

  useEffect(() => {
    computeStatus();
  }, [computeStatus]);

  const subscribe = useCallback(async () => {
    setError(null);
    if (!vapidPublicKey) {
      setError("Notifications aren't configured on the server yet.");
      return;
    }
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "denied" : "default");
        return;
      }

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBytes(vapidPublicKey),
      });

      const json = sub.toJSON();
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData.session?.user?.id;
      if (!userId) {
        setError("You need to be signed in to enable notifications.");
        return;
      }

      const { error: upsertErr } = await supabase.from("push_subscriptions").upsert(
        {
          user_id: userId,
          endpoint: json.endpoint,
          p256dh: json.keys?.p256dh,
          auth: json.keys?.auth,
          user_agent: navigator.userAgent,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: "endpoint" },
      );
      if (upsertErr) {
        setError(upsertErr.message);
        return;
      }
      setStatus("subscribed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't enable notifications.");
    } finally {
      setBusy(false);
    }
  }, []);

  const unsubscribe = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
      }
      setStatus("default");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't turn off notifications.");
    } finally {
      setBusy(false);
    }
  }, []);

  return { status, busy, error, ios, subscribe, unsubscribe, refresh: computeStatus };
}
