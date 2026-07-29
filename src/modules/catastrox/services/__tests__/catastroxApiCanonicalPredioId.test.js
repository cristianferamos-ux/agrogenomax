// Defecto bloqueante corregido (revisión de seguridad, prueba de
// regresión): buildRealPredio() (server/routes/catastrox.js SÍ devuelve
// canonicalPredioId en las tres vías de búsqueda -- código, coordenadas y
// "mi ubicación actual", que reutiliza la misma vía de coordenadas)
// mapeaba la respuesta a una lista blanca de campos que nunca incluía
// canonicalPredioId. Sin él, y con codigoPredial legítimamente ausente
// (es un entregable pago, nunca se revela antes de comprar), POST
// /checkout no tenía identidad de predio válida que enviar y rechazaba
// con INVALID_CADASTRAL_CODE -- el comprador nunca llegaba a ver Wompi.
// Esta prueba fija el contrato: lookupPredioByCode()/lookupPredio() deben
// preservar canonicalPredioId tal como lo devuelve el backend.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

let vite;
let catastroxApi;
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
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
  catastroxApi = await vite.ssrLoadModule('/src/modules/catastrox/services/catastroxApi.js');
});

beforeEach(() => {
  globalThis.window = {
    location: { hostname: 'localhost' },
    localStorage: (() => {
      const values = new Map();
      return {
        getItem: (key) => (values.has(key) ? values.get(key) : null),
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key),
      };
    })(),
    sessionStorage: (() => {
      const values = new Map();
      return {
        getItem: (key) => (values.has(key) ? values.get(key) : null),
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key),
      };
    })(),
  };
  globalThis.fetch = originalFetch;
});

after(async () => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  await vite?.close();
});

test('lookupPredioByCode: preserva canonicalPredioId del backend en predio.canonicalPredioId (búsqueda por código)', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/lookup-by-code')) {
      return jsonResponse({
        lookup_id: 'cx-regresion-1',
        routeId: 'cx-regresion-1',
        canonicalPredioId: '181500003000000130054000000000',
        found: true,
        status: 'FOUND',
        municipio: 'CARTAGENA DEL CHAIRA',
        departamento: 'CAQUETA',
        canPurchase: true,
        predio: {
          lookup_id: 'cx-regresion-1',
          routeId: 'cx-regresion-1',
          canonicalPredioId: '181500003000000130054000000000',
          municipio: 'CARTAGENA DEL CHAIRA',
          departamento: 'CAQUETA',
        },
      });
    }
    throw new Error(`URL no simulada: ${url}`);
  };

  const result = await catastroxApi.lookupPredioByCode({ codigo: '181500003000000130054000000000' });
  assert.equal(
    result.predio.canonicalPredioId,
    '181500003000000130054000000000',
    'predio.canonicalPredioId debe preservarse tal como lo devuelve el backend',
  );
});

test('lookupPredio (coordenadas/ubicación actual): preserva canonicalPredioId del backend en predio.canonicalPredioId', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/lookup')) {
      return jsonResponse({
        lookup_id: 'cx-regresion-2',
        routeId: 'cx-regresion-2',
        canonicalPredioId: 'clean:v1:998877',
        found: true,
        status: 'FOUND',
        municipio: 'CARTAGENA DEL CHAIRA',
        departamento: 'CAQUETA',
        canPurchase: true,
        predio: {
          lookup_id: 'cx-regresion-2',
          routeId: 'cx-regresion-2',
          canonicalPredioId: 'clean:v1:998877',
          municipio: 'CARTAGENA DEL CHAIRA',
          departamento: 'CAQUETA',
        },
      });
    }
    throw new Error(`URL no simulada: ${url}`);
  };

  const result = await catastroxApi.lookupPredio({ lat: 1.258651, lng: -75.821317 });
  assert.equal(
    result.predio.canonicalPredioId,
    'clean:v1:998877',
    'predio.canonicalPredioId debe preservarse para coordenadas/ubicación actual (mismo endpoint)',
  );
});

test('lookupPredioByCode: sin canonicalPredioId en la respuesta del backend, predio.canonicalPredioId queda null (nunca un valor inventado)', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/lookup-by-code')) {
      return jsonResponse({
        lookup_id: 'cx-regresion-3',
        routeId: 'cx-regresion-3',
        found: true,
        status: 'FOUND',
        canPurchase: true,
        predio: { lookup_id: 'cx-regresion-3', routeId: 'cx-regresion-3' },
      });
    }
    throw new Error(`URL no simulada: ${url}`);
  };

  const result = await catastroxApi.lookupPredioByCode({ codigo: '181500003000000130054000000000' });
  assert.equal(result.predio.canonicalPredioId, null);
});
