import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { onRequest as catastroxOnRequest } from '../[[path]].js';
import { onRequest as paymentsOnRequest } from '../payments/[[path]].js';
import { resolveCorsAllowedOrigins } from '../../../../server/config/env.js';

// Pruebas de los dos relays de Cloudflare Pages Functions (LOTE-004,
// ADR-014 §7 Barrera 4/§21). `Request`/`Response`/`Headers` son APIs Web
// globales disponibles en este runtime de Node -- no se usa Miniflare ni
// Wrangler, no hay red real: `global.fetch` se sustituye en cada prueba.

const RELAYS = [
  { name: 'catastrox', onRequest: catastroxOnRequest },
  { name: 'catastrox/payments', onRequest: paymentsOnRequest },
];

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeRequest({ method = 'GET', url = 'https://relay.example/api/catastrox/lookup', origin, headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  if (origin !== undefined) requestHeaders.set('Origin', origin);
  return new Request(url, { method, headers: requestHeaders });
}

function stubFetch(handler) {
  let calls = 0;
  globalThis.fetch = async (...args) => {
    calls += 1;
    if (handler) return handler(...args);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return () => calls;
}

for (const relay of RELAYS) {
  describe(`LOTE-004: relay CORS (${relay.name})`, () => {
    test('1. relay staging permite staging.agrogenomax.com', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({ origin: 'https://staging.agrogenomax.com' });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'staging', API_BACKEND_URL: 'https://backend-staging.internal' },
      });
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://staging.agrogenomax.com');
      assert.equal(getCalls(), 1);
    });

    test('2. relay staging rechaza demo', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({ origin: 'https://demo.agrogenomax.com' });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'staging', API_BACKEND_URL: 'https://backend-staging.internal' },
      });
      assert.equal(response.status, 403);
      assert.equal(getCalls(), 0);
    });

    test('3. relay staging rechaza producción', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({ origin: 'https://agrogenomax.com' });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'staging', API_BACKEND_URL: 'https://backend-staging.internal' },
      });
      assert.equal(response.status, 403);
      assert.equal(getCalls(), 0);
    });

    test('4. relay production permite agrogenomax.com', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({ origin: 'https://agrogenomax.com' });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend-production.internal' },
      });
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://agrogenomax.com');
      assert.equal(getCalls(), 1);
    });

    test('5. relay production rechaza staging', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({ origin: 'https://staging.agrogenomax.com' });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend-production.internal' },
      });
      assert.equal(response.status, 403);
      assert.equal(getCalls(), 0);
    });

    test('6. relay production rechaza demo', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({ origin: 'https://demo.agrogenomax.com' });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend-production.internal' },
      });
      assert.equal(response.status, 403);
      assert.equal(getCalls(), 0);
    });

    test('7. relay rechaza Origin:null', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({ origin: 'null' });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend-production.internal' },
      });
      assert.equal(response.status, 403);
      assert.equal(getCalls(), 0);
    });

    test('8. relay no devuelve ACAO:*', async () => {
      stubFetch();
      const request = makeRequest({ origin: 'https://agrogenomax.com' });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend-production.internal' },
      });
      assert.notEqual(response.headers.get('Access-Control-Allow-Origin'), '*');
    });

    test('9. relay no refleja un Origin no autorizado', async () => {
      stubFetch();
      const request = makeRequest({ origin: 'https://attacker.example' });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend-production.internal' },
      });
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    });

    test('10. relay no refleja headers arbitrarios', async () => {
      stubFetch();
      const request = makeRequest({
        method: 'OPTIONS',
        origin: 'https://agrogenomax.com',
        headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'X-Evil-Header' },
      });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend-production.internal' },
      });
      assert.equal(response.status, 403);
      assert.notEqual(response.headers.get('Access-Control-Allow-Headers'), 'X-Evil-Header');
    });

    test('11. preflight válido devuelve 204 sin llamar upstream', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({
        method: 'OPTIONS',
        origin: 'https://agrogenomax.com',
        headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' },
      });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend-production.internal' },
      });
      assert.equal(response.status, 204);
      assert.equal(getCalls(), 0);
    });

    test('12. preflight inválido no llama upstream', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({
        method: 'OPTIONS',
        origin: 'https://evil.example',
        headers: { 'Access-Control-Request-Method': 'POST' },
      });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend-production.internal' },
      });
      assert.equal(response.status, 403);
      assert.equal(getCalls(), 0);
    });

    test('13. demo devuelve 404/410 y no llama upstream', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({ origin: 'https://demo.agrogenomax.com' });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'demo', API_BACKEND_URL: 'https://backend-production.internal' },
      });
      assert.ok([404, 410].includes(response.status));
      assert.equal(getCalls(), 0);
    });

    test('14. API_BACKEND_URL ausente devuelve 503 y no llama fetch', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({ origin: 'https://agrogenomax.com' });
      const response = await relay.onRequest({ request, env: { APP_ENV: 'production' } });
      assert.equal(response.status, 503);
      assert.equal(getCalls(), 0);
    });

    test('15. API_BACKEND_URL inválida devuelve 503', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({ origin: 'https://agrogenomax.com' });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'production', API_BACKEND_URL: 'not-a-valid-url' },
      });
      assert.equal(response.status, 503);
      assert.equal(getCalls(), 0);
    });

    test('15b. STAGING_READINESS_001: API_BACKEND_URL con http:// (sin TLS) en staging devuelve 503', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({ origin: 'https://staging.agrogenomax.com' });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'staging', API_BACKEND_URL: 'http://backend-staging.internal' },
      });
      assert.equal(response.status, 503);
      assert.equal(getCalls(), 0);
    });

    test('15c. STAGING_READINESS_001: API_BACKEND_URL apuntando a localhost en staging devuelve 503', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({ origin: 'https://staging.agrogenomax.com' });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'staging', API_BACKEND_URL: 'https://localhost:3001' },
      });
      assert.equal(response.status, 503);
      assert.equal(getCalls(), 0);
    });

    test('15d. STAGING_READINESS_001: API_BACKEND_URL apuntando a 127.0.0.1 en production devuelve 503', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({ origin: 'https://agrogenomax.com' });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'production', API_BACKEND_URL: 'https://127.0.0.1:3001' },
      });
      assert.equal(response.status, 503);
      assert.equal(getCalls(), 0);
    });

    test('15f. STAGING_READINESS_001 (revisión final): API_BACKEND_URL con credenciales embebidas en staging devuelve 503', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({ origin: 'https://staging.agrogenomax.com' });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'staging', API_BACKEND_URL: 'https://user:password@backend-staging.internal' },
      });
      assert.equal(response.status, 503);
      assert.equal(getCalls(), 0);
    });

    test('15g. STAGING_READINESS_001 (revisión final): API_BACKEND_URL con hostname wildcard en staging devuelve 503', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({ origin: 'https://staging.agrogenomax.com' });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'staging', API_BACKEND_URL: 'https://*.backend-staging.internal' },
      });
      assert.equal(response.status, 503);
      assert.equal(getCalls(), 0);
    });

    test('15h. STAGING_READINESS_001 (revisión final): API_BACKEND_URL apuntando a loopback IPv6 (::1) en staging devuelve 503', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({ origin: 'https://staging.agrogenomax.com' });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'staging', API_BACKEND_URL: 'https://[::1]:3001' },
      });
      assert.equal(response.status, 503);
      assert.equal(getCalls(), 0);
    });

    test('15e. STAGING_READINESS_001: API_BACKEND_URL https pública válida en staging sí llama upstream', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({ origin: 'https://staging.agrogenomax.com' });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'staging', API_BACKEND_URL: 'https://backend-staging.internal' },
      });
      assert.equal(response.status, 200);
      assert.equal(getCalls(), 1);
    });

    test('16. no existe fallback Railway', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({ origin: 'https://agrogenomax.com' });
      const response = await relay.onRequest({ request, env: { APP_ENV: 'production' } });
      assert.equal(response.status, 503);
      assert.equal(getCalls(), 0);
    });

    test('17. upstream solo se invoca después de aprobar política y configuración', async () => {
      const getCalls = stubFetch();

      const rejected = makeRequest({ origin: 'https://evil.example' });
      await relay.onRequest({
        request: rejected,
        env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend-production.internal' },
      });
      assert.equal(getCalls(), 0);

      const allowedButMisconfigured = makeRequest({ origin: 'https://agrogenomax.com' });
      await relay.onRequest({ request: allowedButMisconfigured, env: { APP_ENV: 'production' } });
      assert.equal(getCalls(), 0);

      const ok = makeRequest({ origin: 'https://agrogenomax.com' });
      await relay.onRequest({
        request: ok,
        env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend-production.internal' },
      });
      assert.equal(getCalls(), 1);
    });

    test('18. el valor de API_BACKEND_URL no aparece en errores', async () => {
      stubFetch();
      const request = makeRequest({ origin: 'https://agrogenomax.com' });
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'production', API_BACKEND_URL: 'https://secreto-interno.example/con-credenciales' },
      });
      const body = await response.text();
      assert.equal(response.status, 503);
      assert.ok(!body.includes('secreto-interno'));
    });

    test('19. no se registran Authorization, cookies o payload', async () => {
      stubFetch();
      const originalWarn = console.warn;
      const captured = [];
      console.warn = (...args) => captured.push(args.join(' '));
      try {
        const request = makeRequest({
          origin: 'https://evil.example',
          headers: { Authorization: 'Bearer secreto123', Cookie: 'session=abc123' },
        });
        await relay.onRequest({
          request,
          env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend-production.internal' },
        });
      } finally {
        console.warn = originalWarn;
      }
      const joined = captured.join(' ');
      assert.ok(!joined.includes('secreto123'));
      assert.ok(!joined.includes('abc123'));
    });

    test('20. una solicitud sin Origin no recibe ACAO:* (y sigue llegando al upstream, same-origin/server-to-server)', async () => {
      const getCalls = stubFetch();
      const request = makeRequest({});
      const response = await relay.onRequest({
        request,
        env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend-production.internal' },
      });
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
      assert.equal(getCalls(), 1);
    });

    test('D1. production permite ambos dominios apex oficiales (agrogenomax.com y agrogenomax.co)', async () => {
      for (const origin of ['https://agrogenomax.com', 'https://agrogenomax.co']) {
        stubFetch();
        const request = makeRequest({ origin });
        const response = await relay.onRequest({
          request,
          env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend-production.internal' },
        });
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
      }
    });

    test('D2. production rechaza https://www.agrogenomax.com/.co sin declaración explícita, los permite con ella', async () => {
      for (const wwwOrigin of ['https://www.agrogenomax.com', 'https://www.agrogenomax.co']) {
        const getCallsRejected = stubFetch();
        const rejected = await relay.onRequest({
          request: makeRequest({ origin: wwwOrigin }),
          env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend-production.internal' },
        });
        assert.equal(rejected.status, 403);
        assert.equal(getCallsRejected(), 0);

        stubFetch();
        const allowed = await relay.onRequest({
          request: makeRequest({ origin: wwwOrigin }),
          env: {
            APP_ENV: 'production',
            API_BACKEND_URL: 'https://backend-production.internal',
            CORS_ALLOWED_ORIGINS: wwwOrigin,
          },
        });
        assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), wwwOrigin);
      }
    });

    test('D3. production con CORS_ALLOWED_ORIGINS apuntando a otro subdominio de agrogenomax.com/.co queda mal configurado (503, sin upstream)', async () => {
      for (const badExtra of ['https://app.agrogenomax.com', 'https://app.agrogenomax.co']) {
        const getCalls = stubFetch();
        const response = await relay.onRequest({
          request: makeRequest({ origin: 'https://agrogenomax.com' }),
          env: {
            APP_ENV: 'production',
            API_BACKEND_URL: 'https://backend-production.internal',
            CORS_ALLOWED_ORIGINS: badExtra,
          },
        });
        assert.equal(response.status, 503);
        assert.equal(getCalls(), 0);
      }
    });
  });
}

describe('LOTE-004 (corrección): la allowlist productiva es idéntica entre Express y ambos relays Cloudflare', () => {
  test('D4. resolveCorsAllowedOrigins() (server/config/env.js) y la allowlist efectiva de cada relay coinciden exactamente', async () => {
    const expressAllowlist = resolveCorsAllowedOrigins('production', {});
    assert.deepEqual([...expressAllowlist], ['https://agrogenomax.com', 'https://agrogenomax.co']);

    for (const relay of RELAYS) {
      for (const origin of expressAllowlist) {
        stubFetch();
        const response = await relay.onRequest({
          request: makeRequest({ origin }),
          env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend-production.internal' },
        });
        assert.equal(
          response.headers.get('Access-Control-Allow-Origin'),
          origin,
          `relay ${relay.name} debía permitir ${origin}, igual que Express`,
        );
      }

      // Un origen fuera de la allowlist de Express también debe rechazarse
      // en ambos relays -- misma fuente de verdad, mismo resultado.
      stubFetch();
      const rejected = await relay.onRequest({
        request: makeRequest({ origin: 'https://app.agrogenomax.com' }),
        env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend-production.internal' },
      });
      assert.equal(rejected.status, 403);
    }
  });
});
