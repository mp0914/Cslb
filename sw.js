// Bump CACHE whenever the shell changes. The fetch handler below serves the
// cached copy first and refreshes it in the background, so a new version lands
// on the next load instead of waiting for a cache name change.
const CACHE = 'cslb-v8';
const ASSETS = [
  '/',
  '/index.html',
  '/c33-trade-study-guide.html',
  '/c33-trade-test.html',
  '/law-and-business-study-guide.html',
  '/law-and-business-test.html',
  '/manifest.json',
  '/icon-192.svg',
  '/icon-512.svg',
  '/pwa.js',
  '/progress.js',
  '/theme.css'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;

  // Let everything else go straight to the network: the sync API is a POST to
  // another origin and must never be served from, or written to, this cache.
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);

    const network = fetch(req).then(res => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    });

    if (cached) {
      // Stale-while-revalidate: instant load now, fresh copy next time.
      e.waitUntil(network.catch(() => {}));
      return cached;
    }
    return network;
  })());
});
