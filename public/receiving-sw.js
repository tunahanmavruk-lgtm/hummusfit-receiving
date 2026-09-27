const CACHE_NAME = "hf-receiving-shell-v1";
const STATIC_ASSETS = [
  "/receiving-policy.js",
  "/assets/logo.png",
  "/assets/receiving-icon-192.png",
  "/assets/receiving-icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  // Receiving orders and reports must always be current. Never cache an API
  // response or a signed store receiving page.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/receiving/")) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
