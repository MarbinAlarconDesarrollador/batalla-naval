/* =====================================================
   Service Worker — Batalla Naval P2P
   Estrategia:
   - Navegación: network-first con fallback a la caché (offline).
   - app shell (html/css/js): stale-while-revalidate.
   - No se interceptan las conexiones de PeerJS (WebRTC va fuera de SW).
   ===================================================== */
const VERSION = "bn-v1";
const SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./favicon.png",
  "./icons/pwa-icon-144.png",
  "./icons/pwa-icon-192.png",
  "./icons/pwa-icon-512.png",
  "./manifest.json",
];

/* Instalación: pre-cacha el app shell */
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

/* Activación: borra cachés antiguas y toma el control */
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

/* Fetch */
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // No interceptar WebRTC/PeerJS ni nada que no sea http(s)
  if (url.origin !== self.location.origin) return;

  // Navegación (abrir/actualizar la app): red primero, caché como respaldo
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match("./index.html")),
    );
    return;
  }

  // Resto (css, js, iconos, fuentes locales): stale-while-revalidate
  e.respondWith(
    caches.match(req).then((cached) => {
      const fresh = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});