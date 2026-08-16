import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { onRequest } from '../[[path]].js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const relaySource = readFileSync(path.resolve(__dirname, '../[[path]].js'), 'utf8');

// BFF-001: relay dedicado y aislado de Ganadería. Mismo patrón de prueba
// que functions/api/catastrox/__tests__/corsRelay.test.js /
// functions/api/__tests__/healthRelay.test.js -- `Request`/`Response`/
// `Headers` son APIs Web globales de Node, sin Miniflare/Wrangler, `fetch`
// se sustituye en cada prueba. La demostración empírica contra el
// runtime REAL de Cloudflare Pages ya se hizo con el cookie-probe
// (CLOUDFLARE RUNTIME COOKIE RELAY GATE: PASS) -- este archivo prueba que
// este relay nuevo reproduce exactamente la misma mecánica ya validada,
// no la vuelve a demostrar contra un despliegue real.

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeRequest({ method = 'GET', url = 'https://relay.example/api/ganaderia/auth/session', headers = {} } = {}) {
  return new Request(url, { method, headers: new Headers(headers) });
}

function stubFetch(handler) {
  let calls = 0;
  const capturedInit = [];
  globalThis.fetch = async (url, init) => {
    calls += 1;
    capturedInit.push(init);
    if (handler) return handler(url, init);
    return new Response(JSON.stringify({ authenticated: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { getCalls: () => calls, getInit: () => capturedInit };
}

const PRODUCTION_ENV = { APP_ENV: 'production', API_BACKEND_URL: 'https://backend.example.com' };

describe('BFF-001: functions/api/ganaderia/[[path]].js (relay dedicado)', () => {
  test('demo responde 404, nunca llama fetch', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({ request: makeRequest(), env: { APP_ENV: 'demo', API_BACKEND_URL: 'https://x.example' } });
    assert.equal(response.status, 404);
    assert.equal(getCalls(), 0);
  });

  test('APP_ENV ausente/inválida responde 503 sin llamar fetch', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({ request: makeRequest(), env: {} });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('API_BACKEND_URL ausente/inválida responde 503 sin llamar fetch', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({ request: makeRequest(), env: { APP_ENV: 'production' } });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('Cookie entrante se reenvía intacta al backend', async () => {
    let receivedCookie;
    const { getCalls } = stubFetch((_url, init) => {
      receivedCookie = init.headers.get('cookie');
      return new Response(null, { status: 200 });
    });
    await onRequest({
      request: makeRequest({ headers: { Cookie: '__Host-agx_session=raw-token-value' } }),
      env: PRODUCTION_ENV,
    });
    assert.equal(getCalls(), 1);
    assert.equal(receivedCookie, '__Host-agx_session=raw-token-value');
  });

  test('el fetch saliente usa redirect:"manual" -- nunca sigue un 30x automáticamente', async () => {
    const { getInit } = stubFetch();
    await onRequest({ request: makeRequest(), env: PRODUCTION_ENV });
    assert.equal(getInit()[0].redirect, 'manual');
  });

  test('un 302 del backend se propaga tal cual -- status y Location exactos, nunca se convierte en 200', async () => {
    stubFetch(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: '/api/ganaderia/auth/session' },
        }),
    );
    const response = await onRequest({ request: makeRequest(), env: PRODUCTION_ENV });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/api/ganaderia/auth/session');
  });

  test('múltiples Set-Cookie se preservan como líneas separadas (getSetCookie() si el runtime lo soporta -- Node sí lo soporta)', async () => {
    stubFetch(async () => {
      const headers = new Headers();
      headers.append('Set-Cookie', 'agx_session=abc; HttpOnly; Secure; SameSite=Lax; Path=/');
      headers.append('Set-Cookie', 'otra=xyz; HttpOnly; Secure; SameSite=Lax; Path=/');
      return new Response(null, { status: 200, headers });
    });
    const response = await onRequest({ request: makeRequest(), env: PRODUCTION_ENV });
    const setCookies = response.headers.getSetCookie();
    assert.equal(setCookies.length, 2);
    assert.ok(setCookies.some((c) => c.startsWith('agx_session=abc')));
    assert.ok(setCookies.some((c) => c.startsWith('otra=xyz')));
  });

  test('no reconstruye Set-Cookie si getSetCookie() no está disponible -- no borra nada a ciegas (fix del gate real)', async () => {
    stubFetch(async () => {
      const headers = new Headers();
      headers.append('Set-Cookie', 'agx_session=abc; HttpOnly; Secure; SameSite=Lax; Path=/');
      headers.append('Set-Cookie', 'otra=xyz; HttpOnly; Secure; SameSite=Lax; Path=/');
      // Simula el runtime real de Cloudflare Pages Functions detectado en
      // el gate: getSetCookie() no existe en el objeto Headers.
      Object.defineProperty(headers, 'getSetCookie', { value: undefined, configurable: true });
      return new Response(null, { status: 200, headers });
    });
    const response = await onRequest({ request: makeRequest(), env: PRODUCTION_ENV });
    // Sin getSetCookie(), el relay confía en new Headers(response.headers)
    // -- comportamiento ya verificado como correcto contra el runtime real.
    assert.equal(typeof response.headers.getSetCookie, 'function'); // Node SÍ lo expone en la respuesta final
    const preserved = response.headers.getSetCookie();
    assert.ok(preserved.length >= 1, 'al menos un Set-Cookie debe sobrevivir vía el constructor Headers()');
  });

  test('respuesta 200 normal se propaga con su body', async () => {
    stubFetch(async () => new Response(JSON.stringify({ authenticated: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const response = await onRequest({ request: makeRequest(), env: PRODUCTION_ENV });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { authenticated: true });
  });

  test('cero cabeceras CORS -- same-origin por diseño, nunca Access-Control-Allow-Origin', async () => {
    stubFetch();
    const response = await onRequest({
      request: makeRequest({ headers: { Origin: 'https://agrogenomax.com' } }),
      env: PRODUCTION_ENV,
    });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  test('aislamiento: no importa nada de functions/api/catastrox/[[path]].js ni de su gemela de pagos', () => {
    const importLines = relaySource.split('\n').filter((line) => line.trim().startsWith('import '));
    assert.ok(!importLines.some((line) => line.includes('catastrox')));
  });

  // GANADERIA-API-RELAY-001: predios/potreros se namespacean bajo
  // /api/ganaderia/ para reusar este mismo relay ya aprobado -- el relay
  // es genérico (reenvía incomingUrl.pathname tal cual, sin ninguna rama
  // condicionada a "/auth"), así que debe cubrir cualquier sub-ruta sin
  // cambios de código. Estas pruebas lo demuestran explícitamente.
  test('/api/ganaderia/predios se reenvía al backend en la misma ruta exacta', async () => {
    let receivedUrl;
    const { getCalls } = stubFetch((url) => {
      receivedUrl = url;
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    await onRequest({
      request: makeRequest({ url: 'https://relay.example/api/ganaderia/predios' }),
      env: PRODUCTION_ENV,
    });
    assert.equal(getCalls(), 1);
    assert.equal(receivedUrl, 'https://backend.example.com/api/ganaderia/predios');
  });

  test('/api/ganaderia/potreros?predio_id=... se reenvía al backend con el mismo query string', async () => {
    let receivedUrl;
    const { getCalls } = stubFetch((url) => {
      receivedUrl = url;
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    await onRequest({
      request: makeRequest({ url: 'https://relay.example/api/ganaderia/potreros?predio_id=abc-123' }),
      env: PRODUCTION_ENV,
    });
    assert.equal(getCalls(), 1);
    assert.equal(receivedUrl, 'https://backend.example.com/api/ganaderia/potreros?predio_id=abc-123');
  });

  test('el relay no tiene ninguna rama condicionada al literal "auth" -- es genérico por diseño', () => {
    assert.ok(!relaySource.includes("'auth'"));
    assert.ok(!relaySource.includes('"auth"'));
  });
});
