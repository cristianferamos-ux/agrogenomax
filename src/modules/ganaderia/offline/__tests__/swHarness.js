// SPRINT-3D11.3 (R1) -- arnés para ejecutar un service worker REAL (texto
// fuente) en node:vm con Cache Storage, fetch y clients simulados. Lo usan
// serviceWorker.test.js y serviceWorkerCatastroxRegression.test.js.
import vm from 'node:vm';

export const ORIGIN = 'https://agrogenomax.test';
export const MANIFEST = { version: 'abc123', assets: ['/assets/index-A1.js', '/assets/index-B2.css', '/assets/lazy-C3.js'] };

// Cloudflare Pages responde /index.html con 308 -> '/': fetch (redirect
// 'follow') entrega la respuesta de '/' marcada redirected, y Cache Storage
// la guarda (y la devuelve) con esa marca.
function marcarRedirigida(response, url) {
  Object.defineProperty(response, 'redirected', { value: true });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function clonar(response) {
  const copia = response.clone();
  return response.redirected ? marcarRedirigida(copia, response.url) : copia;
}

function createCaches(getFetch) {
  const stores = new Map();
  const keyOf = (input) => new URL(typeof input === 'string' ? input : input.url, ORIGIN).href;
  // Simula "Vary: Origin": una petición con Origin (script crossorigin) no
  // coincide con lo guardado salvo con ignoreVary.
  const varyMismatch = (input, options) => Boolean(input?.headers?.origin) && !options?.ignoreVary;
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      async put(input, response) { store.set(keyOf(input), response); },
      async match(input, options) {
        if (varyMismatch(input, options)) return undefined;
        const hit = store.get(keyOf(input));
        return hit ? clonar(hit) : undefined;
      },
      async addAll(inputs) {
        for (const input of inputs) {
          const response = await getFetch()(new URL(input, ORIGIN).href);
          if (!response.ok) throw new Error(`addAll ${input}`);
          store.set(keyOf(input), response);
        }
      },
    };
  };
  return {
    stores,
    api: {
      open,
      async keys() { return [...stores.keys()]; },
      async delete(name) { return stores.delete(name); },
      async match(input, options) {
        if (varyMismatch(input, options)) return undefined;
        for (const store of stores.values()) {
          const hit = store.get(keyOf(input));
          if (hit) return clonar(hit);
        }
        return undefined;
      },
    },
  };
}

/**
 * red.modo: 'online' | 'offline' | 'lie-fi' (nunca responde) | 'lenta' (responde tras red.demoraMs)
 */
export function loadServiceWorker(source, { clients = [], withSyncBundle = true } = {}) {
  const listeners = new Map();
  const red = { modo: 'online', demoraMs: 0, peticiones: [] };
  const responder = (url) => {
    if (url.pathname === '/agx-precache.json') return new Response(JSON.stringify(MANIFEST), { status: 200 });
    if (url.pathname.startsWith('/api/')) return new Response('{"ok":true}', { status: 200 });
    if (url.pathname === '/index.html') return marcarRedirigida(new Response('red /', { status: 200 }), `${ORIGIN}/`);
    return new Response(`red ${url.pathname}`, { status: 200 });
  };
  const fetchImpl = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN);
    red.peticiones.push(url.pathname);
    if (red.modo === 'offline') throw new TypeError('Failed to fetch');
    if (red.modo === 'lie-fi') return new Promise(() => {});
    if (red.modo === 'lenta') return new Promise((resolve) => setTimeout(() => resolve(responder(url)), red.demoraMs));
    return responder(url);
  };
  const caches = createCaches(() => fetchImpl);
  const pushes = [];
  const self = {
    location: new URL(`${ORIGIN}/service-worker.js`),
    addEventListener: (type, handler) => listeners.set(type, handler),
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => clients },
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
    // Timeouts acelerados x1000 (4 s -> 4 ms) para la prueba.
    setTimeout: (fn, ms) => setTimeout(fn, Math.ceil(ms / 1000)),
    clearTimeout,
    importScripts: () => {
      if (withSyncBundle) self.AgxOfflineSync = { pushDesdeServiceWorker: async () => { pushes.push('push'); return 'OK'; } };
    },
  });
  vm.runInContext(source, context);

  async function dispatch(type, init = {}) {
    const waits = [];
    let responsePromise = null;
    let responded = false;
    const event = {
      ...init,
      waitUntil: (promise) => waits.push(promise),
      respondWith: (promise) => { responded = true; responsePromise = promise; },
    };
    listeners.get(type)?.(event);
    await Promise.all(waits);
    let response = responsePromise ? await responsePromise : null;
    // Regla del navegador: una navegación (redirect 'manual') que recibe una
    // respuesta redirigida -> error de red (Chrome: ERR_FAILED). Sin
    // respuesta (undefined) también es error de red.
    let networkError = false;
    if (responded && init.request?.mode === 'navigate' && (!response || response.redirected)) {
      networkError = true;
      response = null;
    }
    return { responded, response, networkError };
  }

  const request = (pathname, extra = {}) => ({ url: pathname.startsWith('http') ? pathname : `${ORIGIN}${pathname}`, method: 'GET', mode: 'no-cors', destination: '', ...extra });
  async function get(pathname, extra) {
    const { responded, response, networkError } = await dispatch('fetch', { request: request(pathname, extra) });
    return {
      responded,
      networkError,
      status: response ? response.status : null,
      redirected: response ? response.redirected : null,
      body: response ? await response.text() : null,
    };
  }
  const navegar = (pathname) => get(pathname, { mode: 'navigate', destination: 'document' });
  async function precache() {
    let respuesta = null;
    await dispatch('message', { data: { type: 'AGX_PRECACHE' }, ports: [{ postMessage: (m) => { respuesta = JSON.parse(JSON.stringify(m)); } }] });
    return respuesta;
  }
  const cacheSnapshot = () => Object.fromEntries([...caches.stores].map(([name, store]) => [name, [...store.keys()].map((k) => new URL(k).pathname).sort()]));
  return { dispatch, get, navegar, precache, caches, red, pushes, cacheSnapshot };
}
