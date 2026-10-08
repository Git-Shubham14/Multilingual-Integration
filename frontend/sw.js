/* =========================================================
   Service Worker — Marathi-English Speech Translator PWA
   Caches app shell for offline use
   ========================================================= */

const CACHE_NAME = "marathi-translator-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
];

// ── Install: cache app shell ──────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[SW] Caching app shell");
      return cache.addAll(APP_SHELL);
    })
  );
  self.skipWaiting();
});

// ── Activate: clean old caches ────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => {
            console.log("[SW] Deleting old cache:", key);
            return caches.delete(key);
          })
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: network-first, fallback to cache ───────────────
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip API calls — always go to network
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful GET responses
        if (event.request.method === "GET" && response.status === 200) {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
        }
        return response;
      })
      .catch(() => {
        // Fallback to cache
        return caches.match(event.request).then(
          (cached) => cached || caches.match("./index.html")
        );
      })
  );
});
