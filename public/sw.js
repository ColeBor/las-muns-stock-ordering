/* Las Muns service worker — Web Push receiver.
 *
 * Kept deliberately tiny: this app's offline story is "show a notification and
 * open the right page", nothing more. We do NOT cache app shell / assets here
 * — the app is online-only and a stale cache would be worse than a network
 * round-trip. The sole jobs are:
 *   1. `push`            — render the notification the dispatcher sent.
 *   2. `notificationclick` — focus an existing tab or open the deep link.
 *
 * The notification payload is produced by /api/push/dispatch and looks like:
 *   { title, body, url, tag }
 */

self.addEventListener("install", () => {
  // Activate this worker immediately rather than waiting for all old tabs to
  // close — there's no cached state to migrate, so it's always safe.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Take control of already-open clients so the first push after enabling
  // notifications doesn't need a reload.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // A push with a non-JSON / empty body still deserves a generic nudge
    // rather than being silently dropped.
    payload = {};
  }

  const title = payload.title || "Las Muns";
  const options = {
    body: payload.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // `tag` collapses repeat alerts for the same thing (e.g. a store-day that
    // keeps breaching) into one notification instead of stacking duplicates.
    tag: payload.tag || undefined,
    renotify: Boolean(payload.tag),
    data: { url: payload.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Reuse an open Las Muns tab if there is one — navigate it to the deep
      // link and focus it — rather than spawning yet another tab.
      for (const client of allClients) {
        if ("focus" in client) {
          try {
            await client.navigate(targetUrl);
          } catch {
            // Cross-origin / detached client — fall through to openWindow.
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })(),
  );
});
