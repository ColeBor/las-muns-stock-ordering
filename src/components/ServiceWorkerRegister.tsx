"use client";

import { useEffect } from "react";

// Registers the Web Push service worker once, app-wide. Mounted from the root
// layout so the worker is installed and `ready` well before a manager taps
// "Enable notifications" (the opt-in hook in usePushNotifications then just
// subscribes against the already-registered worker).
//
// Renders nothing. Safe on every device: browsers without serviceWorker /
// Push support simply skip it, and the opt-in UI hides itself there too.
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    // Register after load so it never competes with first paint.
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        // eslint-disable-next-line no-console
        console.error("Service worker registration failed:", err);
      });
    };
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
