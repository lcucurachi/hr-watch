'use strict';

/* =========================================================================
   Service worker: makes HR Watch installable and lets it open offline.

   - The version comes from the registration URL (sw.js?v=APP_VERSION, set at
     the top of index.html), so bumping APP_VERSION also updates this worker
     and its stored files. There is still only one place to change.
   - The page itself is fetched from the network first when online, so a new
     release shows up right away; the stored copy is only used offline.
   - Other projects on the same github.io site share the browser's file
     storage, so every store is named "hrwatch-…" and cleanup only ever
     touches stores with that prefix.
   ========================================================================= */

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const PREFIX = 'hrwatch-';
const CACHE = `${PREFIX}${VERSION}`;

// everything the app needs to start offline (scripts/CSS use the same ?v= as index.html)
const FILES = [
  './',
  `style.css?v=${VERSION}`,
  ...['storage.js', 'app.js', 'explore.js', 'tooltip.js', 'help.js'].map((f) => `${f}?v=${VERSION}`),
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

// download this version's files
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

// remove older HR Watch versions (never another app's stores)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(PREFIX) && key !== CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // only our own files, inside this app's folder
  if (req.method !== 'GET' || url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;

  if (req.mode === 'navigate') {
    // the page: newest from the network (bypassing the browser's HTTP cache), stored copy when offline
    event.respondWith(
      fetch(req.url, { cache: 'no-cache' })
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put('./', copy));
          }
          return res;
        })
        .catch(() => caches.match('./', { cacheName: CACHE })),
    );
    return;
  }

  // scripts, styles, icons: their URLs carry the version, so the stored copy is always the right one
  event.respondWith(
    caches.match(req, { cacheName: CACHE }).then((hit) => hit || fetch(req)),
  );
});
