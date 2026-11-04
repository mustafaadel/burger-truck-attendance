// Caches the app so it opens with no internet. API calls always go to the network.
const CACHE = 'clockin-v2';
const SHELL = ['/', '/index.html', '/app.js', '/style.css', '/manifest.webmanifest', '/icon.svg', '/vendor/jsQR.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) return;
  const key = e.request.mode === 'navigate' ? '/index.html' : e.request;
  // Cache first (works offline), refresh in the background when online.
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(key, { ignoreSearch: true });
    const fresh = fetch(e.request).then((res) => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
