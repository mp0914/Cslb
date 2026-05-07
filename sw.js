const CACHE = 'cslb-v1';
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
  '/pwa.js'
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
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
