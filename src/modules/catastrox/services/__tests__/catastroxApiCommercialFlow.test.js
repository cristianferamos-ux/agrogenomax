import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

let vite;
let api;
let storage;
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalConsoleError = console.error;

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
  };
}

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

before(async () => {
  vite = await createServer({
    root: process.cwd(),
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true },
    appType: 'custom',
  });
  api = await vite.ssrLoadModule('/src/modules/catastrox/services/catastroxApi.js');
});

beforeEach(() => {
  storage = createStorage();
  globalThis.window = {
    location: { hostname: 'localhost' },
    sessionStorage: storage,
  };
  globalThis.fetch = originalFetch;
  console.error = () => {};
});

after(async () => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  console.error = originalConsoleError;
  await vite?.close();
});

test('API_UNAVAILABLE no devuelve mock ni persiste resultado alternativo', async () => {
  globalThis.fetch = async () => {
    throw new Error('network unavailable');
  };

  await assert.rejects(
    api.lookupPredioWithFallback({ lat: '1.326892', lng: '-74.813366' }),
    (error) => error.name === 'CatastroxApiError' && error.code === 'LOOKUP_UNAVAILABLE',
  );

  assert.equal(storage.getItem(api.CATASTROX_LOOKUP_STORAGE_KEY), null);
});

test('ENDPOINT_NOT_FOUND no devuelve mock ni source: mock', async () => {
  globalThis.fetch = async () => jsonResponse({ error: 'not found' }, { status: 404 });

  await assert.rejects(
    api.lookupPredioWithFallback({ lat: '1.326892', lng: '-74.813366' }),
    (error) => error.name === 'CatastroxApiError' && error.code === 'LOOKUP_UNAVAILABLE',
  );

  assert.equal(storage.getItem(api.CATASTROX_LOOKUP_STORAGE_KEY), null);
});

test('routeId desconocido no produce resultado mock', () => {
  assert.equal(api.resolveLookupForRoute('identificador-arbitrario'), null);
});

test('consulta real valida se conserva y resuelve sin source: mock', async () => {
  globalThis.fetch = async () => jsonResponse({
    found: true,
    lookup_id: 'real-lookup-1',
    predio: {
      id: 'real-lookup-1',
      codigoPredial: '181500002000000300047000000000',
      municipio: 'Cartagena del Chaira',
      departamento: 'Caqueta',
    },
  });

  const result = await api.lookupPredio({ lat: '1.326892', lng: '-74.813366' });
  const resolved = api.resolveLookupForRoute('real-lookup-1');

  assert.equal(result.source, 'api');
  assert.equal(result.predio.source, 'api');
  assert.equal(resolved.routeId, 'real-lookup-1');
  assert.notEqual(resolved.source, 'mock');
  assert.notEqual(resolved.predio.source, 'mock');
});

test('resultado mock guardado no se reutiliza en flujo comercial', () => {
  storage.setItem(api.CATASTROX_LOOKUP_STORAGE_KEY, JSON.stringify({
    found: true,
    routeId: 'mock-guardado',
    source: 'mock',
    predio: {
      id: 'mock-guardado',
      source: 'mock',
    },
  }));

  assert.equal(api.resolveLookupForRoute('mock-guardado'), null);
});
