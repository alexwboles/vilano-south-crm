// GR CRM service worker — app-shell caching, read-only API cache, and the
// offline mutation outbox (replayed via Background Sync).
// Bump CACHE when the shell changes.
const CACHE = "grcrm-v2";
const API_CACHE = "grcrm-api-v2";
const SHELL = [
  "/index.html",
  "/app.js",
  "/styles.css",
  "/login.html",
  "/login.js",
  "/phone.html",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/favicon.ico",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(async (cache) => {
        // Only cache successful responses: /app.js and /index.html 302 when
        // not signed in, and caching a redirect would break offline boot.
        for (const url of SHELL) {
          try {
            const res = await fetch(url, { credentials: "same-origin" });
            if (res && res.ok) await cache.put(url, res);
          } catch { /* offline during install — skip */ }
        }
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE && k !== API_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ---- offline outbox (IndexedDB, shared with the page) ----
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("grcrm-outbox", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("queue", { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function outboxAll() {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("queue", "readonly");
    const req = tx.objectStore("queue").getAll();
    const keys = tx.objectStore("queue").getAllKeys();
    req.onsuccess = () => keys.onsuccess = () => resolve(
      req.result.map((v, i) => ({ key: keys.result[i], ...v }))
    );
    req.onerror = () => reject(req.error);
  });
}
async function outboxDelete(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("queue", "readwrite");
    tx.objectStore("queue").delete(key);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
async function notifyClients() {
  const db = await idb();
  const n = await new Promise((resolve) => {
    const tx = db.transaction("queue", "readonly");
    const q = tx.objectStore("queue").count();
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => resolve(0);
  });
  const clients = await self.clients.matchAll();
  for (const c of clients) c.postMessage({ type: "outbox", count: n });
}
async function replayOutbox() {
  const items = await outboxAll().catch(() => []);
  for (const item of items) {
    try {
      const res = await fetch(item.path, {
        method: item.method,
        headers: {
          "Content-Type": "application/json",
          ...(item.csrf ? { "X-CSRF-Token": item.csrf } : {}),
        },
        body: item.body,
        credentials: "same-origin",
      });
      // 2xx/4xx: the server answered — drop it. 5xx/network: keep for later.
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        await outboxDelete(item.key).catch(() => {});
      }
    } catch {
      break; // still offline — stop, try again on the next sync
    }
  }
  notifyClients().catch(() => {});
}
self.addEventListener("sync", (event) => {
  if (event.tag === "grcrm-outbox") event.waitUntil(replayOutbox());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // GET /api/*: stale-while-revalidate. Serves the last good response when
  // offline so read-only views keep working away from Wi-Fi.
  if (url.pathname.startsWith("/api/")) {
    // Never cache the backup download or QR images.
    if (url.pathname === "/api/admin/backup" || url.pathname.startsWith("/api/phone-qr")) return;
    event.respondWith((async () => {
      const cache = await caches.open(API_CACHE);
      try {
        const res = await fetch(request);
        if (res && res.ok) {
          const copy = res.clone();
          // Don't let the API cache grow forever.
          cache.put(request, copy).then(() => trimCache(cache, 200)).catch(() => {});
        }
        return res;
      } catch {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw new Error("offline");
      }
    })());
    return;
  }

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
      if (request.mode === "navigate") {
        return (await caches.match("/index.html")) || (await caches.match("/login.html"));
      }
      throw new Error("offline");
    }
  })());
});

async function trimCache(cache, max) {
  const keys = await cache.keys();
  if (keys.length > max) {
    for (const k of keys.slice(0, keys.length - max)) await cache.delete(k);
  }
}
