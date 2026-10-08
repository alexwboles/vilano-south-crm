// GR CRM service worker — app-shell caching for installability and flaky networks.
// CRM data (/api/*) is never cached: always live. Bump CACHE when the shell changes.
const CACHE = "grcrm-v1";
const SHELL = [
  "/styles.css",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/favicon.ico",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith((async () => {
    const cached = await caches.match(request);
    try {
      const res = await fetch(request);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return res;
    } catch {
      if (cached) return cached;
      if (request.mode === "navigate") return caches.match("/login.html");
      throw new Error("offline");
    }
  })());
});
