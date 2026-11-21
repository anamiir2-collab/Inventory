/* =========================================================================
   sw.js — Service Worker: offline-first app shell for GitHub Pages
   - precaches every static asset (works from any sub-path: relative URLs)
   - stale-while-revalidate for same-origin assets
   - network-first with cache fallback for navigations (SPA shell)
   ========================================================================= */
'use strict';

const CACHE = 'inv-pwa-v7-redesign';

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './css/print.css',
  './js/calculations.js',
  './js/database.js',
  './js/ui.js',
  './js/transactions.js',
  './js/excel.js',
  './js/app.js',
  './js/inventory.js',
  './js/reports.js',
  './js/backup.js',
  './vendor/xlsx.full.min.js',
  './vendor/chart.umd.min.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-192.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/favicon-64.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // app has no external runtime deps

  /* navigations: network first (get updates), offline → cached shell */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  /* assets: cache first, refresh in background */
  e.respondWith(
    caches.match(req).then((cached) => {
      const refresh = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || refresh;
    })
  );
});

/* allow the page to trigger immediate activation on update */
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
