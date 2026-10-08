const CACHE = 'codex-status-v2';
const token = new URL(self.location.href).searchParams.get('token') || '';
const withToken = (asset) => asset + (asset.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
const APP_SHELL = [withToken('./'), withToken('./manifest.webmanifest'), withToken('./icon.svg')];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.pathname.includes('/api/')) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
