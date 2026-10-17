// AgroGenomaX PWA.
//
// Comportamiento BASE (todo el sitio, incluido CatastroX): idéntico al
// service worker v18 -- shell en caché, navegación red-primero con respaldo
// /index.html, scripts/estilos red-primero, demás recursos caché-con-
// revalidación, /api/* siempre red, recursos de otros orígenes sin tocar.
//
// SPRINT-3D11.3 (R1) offline-first, LIMITADO A GANADERÍA:
//   * el build completo solo se precachea cuando Ganadería lo pide
//     ("Preparar dispositivo" -> mensaje AGX_PRECACHE); nunca en la
//     instalación -> un visitante de CatastroX no descarga nada extra;
//   * los recursos de ese precache se sirven desde caché (solo existen si se
//     preparó Ganadería; son archivos con hash, idénticos a los de la red);
//   * la navegación a /ganaderia/* y /qr/* usa un timeout de 4 s antes del
//     respaldo (sin red o con "lie-fi" la app no se queda esperando); el
//     resto del sitio espera a la red como en v18;
//   * Background Sync 'agx-ganaderia-outbox' (solo Chromium; el sistema
//     operativo decide si despierta al SW).
const CACHE_VERSION = 'agrogenomax-pwa-v20-offline-first';
const ASSETS_CACHE_PREFIX = 'agrogenomax-assets-';
const PRECACHE_MANIFEST = '/agx-precache.json';
const BACKGROUND_SYNC_TAG = 'agx-ganaderia-outbox';
const GANADERIA_NAVIGATION_TIMEOUT_MS = 4000;
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
  // Sin el bundle el SW sigue sirviendo el sitio; Ganadería sincroniza
  // desde la página.
}

function isGanaderiaPath(pathname) {
  return pathname === '/ganaderia' || pathname.startsWith('/ganaderia/') || pathname.startsWith('/qr/');
}

// ---------------------------------------------------------------------
// Ciclo de vida (igual que v18)
// ---------------------------------------------------------------------

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
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION && !key.startsWith(ASSETS_CACHE_PREFIX))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------------
// Ganadería: precache bajo demanda + Background Sync
// ---------------------------------------------------------------------

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

/** Solo el precache de Ganadería (existe únicamente si se preparó el dispositivo). */
async function matchPrecache(request) {
  const keys = await caches.keys();
  for (const key of keys) {
    if (!key.startsWith(ASSETS_CACHE_PREFIX)) continue;
    // ignoreVary: los <script type="module" crossorigin> envían Origin y el
    // servidor puede responder con "Vary: Origin"; un archivo con hash es el
    // mismo para cualquier origen.
    const hit = await (await caches.open(key)).match(request, { ignoreVary: true });
    if (hit) return hit;
  }
  return undefined;
}

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

// ---------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------

function navigationResponse(request, requestUrl) {
  const network = isGanaderiaPath(requestUrl.pathname)
    ? networkWithTimeout(request, GANADERIA_NAVIGATION_TIMEOUT_MS)
    : fetch(request);
  return network
    .then((response) => {
      const copy = response.clone();
      caches.open(CACHE_VERSION).then((cache) => cache.put('/index.html', copy));
      return response;
    })
    .catch(() => caches.match('/index.html'));
}

function baseResponse(request) {
  if (
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'manifest'
  ) {
    return fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }

        return response;
      })
      .catch(() => caches.match(request));
  }

  return caches.match(request).then((cachedResponse) => {
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
  });
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
    event.respondWith(navigationResponse(request, requestUrl));
    return;
  }

  if (requestUrl.origin !== self.location.origin) return;

  // Recursos del build precacheados por Ganadería: caché primero; si no
  // están (nunca se preparó Ganadería), estrategia base v18.
  event.respondWith(matchPrecache(request).then((hit) => hit || baseResponse(request)));
});
