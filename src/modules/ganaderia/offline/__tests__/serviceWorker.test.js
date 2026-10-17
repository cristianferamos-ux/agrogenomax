// SPRINT-3D11.3 (R1) -- public/service-worker.js REAL ejecutado en un
// sandbox (node:vm) con Cache Storage, fetch y clients simulados:
// precache del build, shell offline, /api nunca cacheado, assets cache-first,
// timeout de navegación ("lie-fi") y Background Sync.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SW_SOURCE = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', '..', 'public', 'service-worker.js'), 'utf8');
const ORIGIN = 'https://agrogenomax.test';
const MANIFEST = { version: 'abc123', assets: ['/assets/index-A1.js', '/assets/index-B2.css', '/assets/lazy-C3.js'] };

function createCaches() {
  const stores = new Map();
  const keyOf = (input) => new URL(typeof input === 'string' ? input : input.url, ORIGIN).href;
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      async put(input, response) { store.set(keyOf(input), response); },
      async match(input) { return store.get(keyOf(input))?.clone(); },
      async addAll(inputs) {
        for (const input of inputs) {
          const response = await globalFetch(new URL(input, ORIGIN).href);
          if (!response.ok) throw new Error(`addAll ${input}`);
          store.set(keyOf(input), response);
        }
      },
    };
  };
  let globalFetch;
  return {
    stores,
    setFetch(fn) { globalFetch = fn; },
    api: {
      open,
      async keys() { return [...stores.keys()]; },
      async delete(name) { return stores.delete(name); },
      async match(input, options = {}) {
        // Simula "Vary: Origin": una petición con Origin (script crossorigin)
        // no coincide con lo precacheado salvo con ignoreVary.
        if (input?.headers?.origin && !options.ignoreVary) return undefined;
        for (const store of stores.values()) {
          const hit = store.get(keyOf(input));
          if (hit) return hit.clone();
        }
        return undefined;
      },
    },
  };
}

function loadServiceWorker({ network, clients = [], withSyncBundle = true }) {
  const listeners = new Map();
  const caches = createCaches();
  const red = { modo: 'online', ...network };
  const fetchImpl = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN);
    if (red.modo === 'offline') throw new TypeError('Failed to fetch');
    if (red.modo === 'lie-fi') return new Promise(() => {});
    if (url.pathname === '/agx-precache.json') return new Response(JSON.stringify(MANIFEST), { status: 200 });
    if (url.pathname.startsWith('/api/')) return new Response('{"ok":true}', { status: 200 });
    return new Response(`contenido ${url.pathname}`, { status: 200 });
  };
  caches.setFetch(fetchImpl);
  const pushes = [];
  const self = {
    location: new URL(`${ORIGIN}/service-worker.js`),
    addEventListener: (type, handler) => listeners.set(type, handler),
    skipWaiting: async () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => clients,
    },
    navigator: { onLine: true },
  };
  const context = vm.createContext({
    self,
    caches: caches.api,
    fetch: fetchImpl,
    Response,
    Request,
    URL,
    console,
    // Timeout de navegación acelerado x1000 para la prueba.
    setTimeout: (fn, ms) => setTimeout(fn, Math.ceil(ms / 1000)),
    clearTimeout,
    importScripts: () => {
      if (withSyncBundle) self.AgxOfflineSync = { pushDesdeServiceWorker: async () => { pushes.push('push'); return 'OK'; } };
    },
  });
  vm.runInContext(SW_SOURCE, context);

  async function dispatch(type, init) {
    const waits = [];
    let responsePromise = null;
    const event = {
      ...init,
      waitUntil: (promise) => waits.push(promise),
      respondWith: (promise) => { responsePromise = promise; },
    };
    listeners.get(type)?.(event);
    await Promise.all(waits);
    return responsePromise ? await responsePromise : null;
  }

  return { dispatch, caches, red, pushes, listeners };
}

function navigateRequest(pathname) {
  // Request de Node no permite mode 'navigate': se simula la forma que lee el SW.
  return { url: `${ORIGIN}${pathname}`, method: 'GET', mode: 'navigate', destination: 'document' };
}

async function navegar(sw, pathname) {
  return sw.dispatch('fetch', { request: navigateRequest(pathname) });
}

test('17. install: precachea shell + TODO el build (agx-precache.json) y el bundle de sync', async () => {
  const sw = loadServiceWorker({});
  await sw.dispatch('install', {});
  const assetsCache = sw.caches.stores.get('agrogenomax-assets-abc123');
  assert.ok(assetsCache, 'caché versionado del build');
  for (const asset of [...MANIFEST.assets, '/agx-offline-sync.js']) assert.ok(assetsCache.has(`${ORIGIN}${asset}`), asset);
  assert.ok([...sw.caches.stores.values()].some((store) => store.has(`${ORIGIN}/index.html`)));
});

test('17. sin red: la navegación a cualquier ruta de Ganadería sirve el shell cacheado', async () => {
  const sw = loadServiceWorker({});
  await sw.dispatch('install', {});
  sw.red.modo = 'offline';
  for (const ruta of ['/ganaderia/animales', '/ganaderia/escanear-qr', '/ganaderia/animales/nuevo?chapeta=AGX-7KM4-P2XZ-R', '/qr/AGX-000003']) {
    const response = await navegar(sw, ruta);
    assert.ok(response, ruta);
    assert.equal(await response.text(), 'contenido /index.html', ruta);
  }
});

test('17. "lie-fi" (red que no responde): la navegación no se queda esperando -- timeout y shell', async () => {
  const sw = loadServiceWorker({});
  await sw.dispatch('install', {});
  sw.red.modo = 'lie-fi';
  const inicio = Date.now();
  const response = await navegar(sw, '/ganaderia/animales');
  assert.equal(await response.text(), 'contenido /index.html');
  assert.ok(Date.now() - inicio < 1000);
});

test('17. assets con hash: caché primero (JS/CSS de la app sin red), también <script type="module" crossorigin> con Vary: Origin', async () => {
  const sw = loadServiceWorker({});
  await sw.dispatch('install', {});
  sw.red.modo = 'offline';
  const response = await sw.dispatch('fetch', { request: { url: `${ORIGIN}/assets/lazy-C3.js`, method: 'GET', mode: 'no-cors', destination: 'script' } });
  assert.equal(await response.text(), 'contenido /assets/lazy-C3.js');
  const moduleScript = await sw.dispatch('fetch', {
    request: { url: `${ORIGIN}/assets/index-A1.js`, method: 'GET', mode: 'cors', destination: 'script', headers: { origin: ORIGIN } },
  });
  assert.equal(await moduleScript.text(), 'contenido /assets/index-A1.js');
});

test('/api/* nunca se cachea (datos y sesión siempre de la red)', async () => {
  const sw = loadServiceWorker({});
  await sw.dispatch('install', {});
  await sw.dispatch('fetch', { request: { url: `${ORIGIN}/api/ganaderia/sync/pull`, method: 'GET', mode: 'cors', destination: '' } });
  for (const store of sw.caches.stores.values()) {
    for (const key of store.keys()) assert.ok(!key.includes('/api/'), key);
  }
  assert.match(SW_SOURCE, /pathname\.startsWith\('\/api\/'\)\) \{\s*event\.respondWith\(fetch\(request\)\);/);
});

test('Background Sync: con la app abierta pide a la página sincronizar; cerrada, ejecuta el PUSH en el SW', async () => {
  const mensajes = [];
  const abierta = loadServiceWorker({ clients: [{ postMessage: (m) => mensajes.push(m) }] });
  await abierta.dispatch('sync', { tag: 'agx-ganaderia-outbox' });
  assert.equal(JSON.stringify(mensajes), JSON.stringify([{ type: 'AGX_SYNC_REQUEST' }]));
  assert.deepEqual(abierta.pushes, []);

  const cerrada = loadServiceWorker({ clients: [] });
  await cerrada.dispatch('sync', { tag: 'agx-ganaderia-outbox' });
  assert.deepEqual(cerrada.pushes, ['push']);

  const otraEtiqueta = loadServiceWorker({ clients: [] });
  await otraEtiqueta.dispatch('sync', { tag: 'otra' });
  assert.deepEqual(otraEtiqueta.pushes, []);
});

test('AGX_PRECACHE: "Preparar dispositivo" obtiene confirmación del precache por MessageChannel', async () => {
  const sw = loadServiceWorker({});
  let respuesta = null;
  await sw.dispatch('message', { data: { type: 'AGX_PRECACHE' }, ports: [{ postMessage: (m) => { respuesta = m; } }] });
  assert.equal(JSON.stringify(respuesta), JSON.stringify({ ok: true, version: 'abc123', assets: 3 }));
});
