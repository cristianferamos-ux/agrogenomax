// AgroGenomaX PWA. SPRINT-3D11.3 (R1) offline-first de Ganadería:
//   * precache de TODO el build (agx-precache.json, generado por
//     vite.agx-offline.js) -> la app arranca sin red una vez preparada;
//   * navegación: red con timeout (4 s) y respaldo /index.html del caché ->
//     sin red o con "lie-fi" la app no se queda esperando;
//   * /assets/* (nombres con hash, inmutables): caché primero;
//   * /api/*: SIEMPRE red, nunca se cachea (datos y sesión);
//   * Background Sync 'agx-ganaderia-outbox': pide a las páginas abiertas
//     que sincronicen; sin páginas, ejecuta el PUSH aquí mismo
//     (agx-offline-sync.js). Solo Chromium implementa Background Sync; el
//     sistema operativo decide si despierta al SW (ver informe R1).
const CACHE_VERSION = 'agrogenomax-pwa-v20-offline-first';
const ASSETS_CACHE_PREFIX = 'agrogenomax-assets-';
const PRECACHE_MANIFEST = '/agx-precache.json';
const BACKGROUND_SYNC_TAG = 'agx-ganaderia-outbox';
const NAVIGATION_TIMEOUT_MS = 4000;
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

try {
  importScripts('/agx-offline-sync.js');
} catch (error) {
  // Sin el bundle (p. ej. build antiguo) el SW sigue sirviendo el shell; el
  // PUSH ocurre desde la página.
}

async function precacheBuild() {
  let manifest;
  try {
    const response = await fetch(PRECACHE_MANIFEST, { cache: 'no-store' });
    if (!response.ok) return { ok: false, reason: 'manifest' };
    manifest = await response.json();
  } catch (error) {
    return { ok: false, reason: 'offline' };
  }
  if (!manifest || typeof manifest.version !== 'string' || !Array.isArray(manifest.assets)) return { ok: false, reason: 'manifest' };
  const cacheName = `${ASSETS_CACHE_PREFIX}${manifest.version}`;
  const cache = await caches.open(cacheName);
  const assets = manifest.assets.filter((asset) => typeof asset === 'string' && asset.startsWith('/') && !asset.startsWith('/api/'));
  await cache.addAll(['/agx-offline-sync.js', ...assets].filter((value, index, list) => list.indexOf(value) === index));
  const shell = await caches.open(CACHE_VERSION);
  await shell.addAll(['/', '/index.html']);
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key.startsWith(ASSETS_CACHE_PREFIX) && key !== cacheName).map((key) => caches.delete(key)));
  return { ok: true, version: manifest.version, assets: assets.length };
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      // Un fallo del precache del build no impide instalar el shell; la app
      // lo reintenta con AGX_PRECACHE ("Preparar dispositivo").
      .then(() => precacheBuild().catch(() => null))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION && !key.startsWith(ASSETS_CACHE_PREFIX))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// La app (Ganadería, "Preparar dispositivo") pide precachear el build
// vigente y espera la respuesta por MessageChannel.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'AGX_PRECACHE') return;
  const port = event.ports && event.ports[0];
  event.waitUntil(
    precacheBuild()
      .catch(() => ({ ok: false, reason: 'error' }))
      .then((result) => {
        if (port) port.postMessage(result);
      })
  );
});

async function backgroundSync() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (windows.length > 0) {
    windows.forEach((client) => client.postMessage({ type: 'AGX_SYNC_REQUEST' }));
    return;
  }
  if (self.AgxOfflineSync && typeof self.AgxOfflineSync.pushDesdeServiceWorker === 'function') {
    const resultado = await self.AgxOfflineSync.pushDesdeServiceWorker();
    // OFFLINE/ERROR -> el navegador reintentará el Background Sync.
    if (resultado === 'OFFLINE' || resultado === 'ERROR') throw new Error(`AGX_SYNC_${resultado}`);
  }
}

self.addEventListener('sync', (event) => {
  if (event.tag === BACKGROUND_SYNC_TAG) event.waitUntil(backgroundSync());
});

function networkWithTimeout(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    fetch(request).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function cachedShell() {
  return (await caches.match('/index.html')) || (await caches.match('/'));
}

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
      networkWithTimeout(request, NAVIGATION_TIMEOUT_MS)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put('/index.html', copy));
          }
          return response;
        })
        .catch(() => cachedShell())
    );
    return;
  }

  if (requestUrl.origin !== self.location.origin) return;

  // Assets con hash: inmutables -> caché primero (arranque sin red y sin
  // esperar a una red lenta).
  // ignoreVary: los <script type="module" crossorigin> envían Origin y el
  // servidor puede responder con "Vary: Origin"; un asset con hash es el
  // mismo archivo para cualquier origen.
  if (requestUrl.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request, { ignoreVary: true }).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response && response.ok) {
              const copy = response.clone();
              caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
            }
            return response;
          })
      )
    );
    return;
  }

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
