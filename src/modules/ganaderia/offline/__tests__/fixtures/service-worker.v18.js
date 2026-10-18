const CACHE_VERSION = 'agrogenomax-pwa-v18-qr-api-network-first';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/logo-agrogenomax-by-crh.png',
  '/agx-report-logo-round.jpeg',
  '/agx-report-logo-white.jpeg',
  '/agx-pdf-header-footer.jpeg',
  '/agx-pdf-wordmark.jpeg',
  '/agx-pdf-wordmark-color.jpeg',
  '/agx-pdf-wordmark-color-vivid.jpeg',
  '/agx-pdf-wordmark-bw.jpeg',
  '/agx-pdf-footer-logo.jpeg',
  '/icons/agx-favicon-32-v3.png',
  '/icons/agx-favicon-48-v3.png',
  '/icons/agx-icon-180-v3.png',
  '/icons/agx-icon-192-v3.png',
  '/icons/agx-icon-512-v3.png',
  '/icons/agx-maskable-192-v3.png',
  '/icons/agx-maskable-512-v3.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);

  if (requestUrl.origin === self.location.origin && requestUrl.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  if (requestUrl.origin !== self.location.origin) return;

  if (
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'manifest'
  ) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }

          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const networkResponse = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }

          return response;
        })
        .catch(() => cachedResponse);

      return cachedResponse || networkResponse;
    })
  );
});
