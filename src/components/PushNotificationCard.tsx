"use client";

import { usePushNotifications } from "@/lib/usePushNotifications";

// "Enable notifications on this device" card for managers. Shown on the home
// admin screen. The whole point of the iOS branch is to make the one-time
// "Add to Home Screen" step impossible to miss — that single step is what
// makes iPhone push reliable. Once installed (or on Android/desktop), it's a
// single button.
export default function PushNotificationCard() {
  const { status, busy, error, ios, subscribe, unsubscribe } = usePushNotifications();

  if (status === "loading") return null;

  const shell =
    "rounded-2xl border border-white/10 bg-slate-900/60 p-5 text-slate-100";

  // iOS Safari that hasn't been installed to the home screen — push isn't
  // available yet. Walk them through it instead of showing a dead button.
  if (status === "needs-install") {
    return (
      <div className={shell}>
        <h2 className="text-lg font-semibold text-white">📲 Turn on phone notifications</h2>
        <p className="mt-1 text-sm text-slate-400">
          On iPhone/iPad, notifications only work after you add this app to your
          Home Screen. It takes 10 seconds — you only do it once:
        </p>
        <ol className="mt-3 space-y-2 text-sm text-slate-200">
          <li>
            1. Tap the <span className="font-semibold text-cyan-300">Share</span> button{" "}
            <span className="text-slate-400">(the square with an arrow, at the bottom of Safari)</span>.
          </li>
          <li>
            2. Scroll down and tap{" "}
            <span className="font-semibold text-cyan-300">Add to Home Screen</span>.
          </li>
          <li>
            3. Open <span className="font-semibold">Las Muns</span> from your Home Screen
            (not Safari), then come back here and tap{" "}
            <span className="font-semibold text-cyan-300">Enable notifications</span>.
          </li>
        </ol>
        <p className="mt-3 text-xs text-slate-500">
          Requires iOS 16.4 or newer. On Android you can enable notifications
          right away — no install needed.
        </p>
      </div>
    );
  }

  if (status === "unsupported") {
    return (
      <div className={shell}>
        <h2 className="text-lg font-semibold text-white">Phone notifications</h2>
        <p className="mt-1 text-sm text-slate-400">
          This browser doesn&apos;t support push notifications. Open the app in
          Chrome (Android) or install it to your Home Screen (iPhone) to enable
          them.
        </p>
      </div>
    );
  }

  if (status === "denied") {
    return (
      <div className={shell}>
        <h2 className="text-lg font-semibold text-white">Phone notifications are blocked</h2>
        <p className="mt-1 text-sm text-slate-400">
          You previously blocked notifications for this app. To turn them on,
          allow notifications for Las Muns in your browser/site settings, then
          reload this page.
        </p>
      </div>
    );
  }

  if (status === "subscribed") {
    // Once on, this is just residual confirmation — keep it tiny and tucked to
    // the right so it doesn't take up a whole card.
    return (
      <div className="flex items-center justify-end gap-2 text-xs text-slate-500">
        <span>🔔 Notifications on</span>
        <span aria-hidden>·</span>
        <button
          type="button"
          onClick={unsubscribe}
          disabled={busy}
          className="text-slate-400 underline-offset-2 transition hover:text-slate-200 hover:underline disabled:opacity-50"
        >
          {busy ? "…" : "Turn off"}
        </button>
        {error && <span className="ml-2 text-rose-300">{error}</span>}
      </div>
    );
  }

  // status === "default" — supported, just not subscribed yet.
  return (
    <div className={shell}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">📲 Get alerts on this device</h2>
          <p className="mt-1 text-sm text-slate-400">
            Push notifications for waste over cap, fridge alerts, new employee
            requests, and cycle completion.
            {ios && " You're all set since the app is on your Home Screen."}
          </p>
        </div>
        <button
          type="button"
          onClick={subscribe}
          disabled={busy}
          className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50"
        >
          {busy ? "Enabling…" : "Enable notifications"}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-rose-300">{error}</p>}
    </div>
  );
}
