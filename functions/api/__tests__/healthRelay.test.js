import { test, describe, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { onRequest } from '../health.js';

// LOTE-006: pruebas del relay real de health de plataforma. `Request`/
// `Response`/`Headers`/`AbortController` son APIs Web globales en este
// runtime de Node -- sin Miniflare/Wrangler, sin red real: `global.fetch`
// se sustituye en cada prueba y se restaura en `afterEach`. Los timers
// falsos de `node:test` (`mock.timers`) controlan el timeout sin esperar
// 3 segundos reales y sin dejar residuos entre pruebas.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const healthSource = readFileSync(path.resolve(__dirname, '../health.js'), 'utf8');

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.timers.reset();
});

function makeRequest({ method = 'GET', url = 'https://relay.example/api/health', origin, headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  if (origin !== undefined) requestHeaders.set('Origin', origin);
  return new Request(url, { method, headers: requestHeaders });
}

function stubFetch(handler) {
  let calls = 0;
  const capturedArgs = [];
  globalThis.fetch = async (...args) => {
    calls += 1;
    capturedArgs.push(args);
    if (handler) return handler(...args);
    return jsonUpstreamResponse({ status: 'ok', check: 'liveness', timestamp: '2026-01-01T00:00:00.000Z' });
  };
  return { getCalls: () => calls, getArgs: () => capturedArgs };
}

function jsonUpstreamResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

function makeEnvWithBackendUrlSpy({ APP_ENV, API_BACKEND_URL, ...rest } = {}) {
  let accessed = false;
  const env = { APP_ENV, ...rest };
  Object.defineProperty(env, 'API_BACKEND_URL', {
    enumerable: true,
    configurable: true,
    get() {
      accessed = true;
      return API_BACKEND_URL;
    },
  });
  return { env, wasAccessed: () => accessed };
}

// API_BACKEND_ALLOWED_ORIGIN igual a API_BACKEND_URL -- ambientes
// "correctamente configurados" usados como caso feliz en la mayoría de
// las pruebas. Las pruebas de la corrección (mecanismo positivo) usan
// combinaciones deliberadamente distintas.
const PRODUCTION_ENV = {
  APP_ENV: 'production',
  API_BACKEND_URL: 'https://backend.example.com',
  API_BACKEND_ALLOWED_ORIGIN: 'https://backend.example.com',
};
const STAGING_ENV = {
  APP_ENV: 'staging',
  API_BACKEND_URL: 'https://backend-staging.example.com',
  API_BACKEND_ALLOWED_ORIGIN: 'https://backend-staging.example.com',
};

describe('LOTE-006: functions/api/health.js (relay real de health)', () => {
  test('1. demo responde 404/410', async () => {
    stubFetch();
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const response = await onRequest({
        request: makeRequest({ method, origin: 'https://agrogenomax.com' }),
        env: { APP_ENV: 'demo', API_BACKEND_URL: 'https://backend.example.com' },
      });
      assert.ok([404, 410].includes(response.status), `esperado 404/410 para ${method}`);
    }
  });

  test('2. demo no lee API_BACKEND_URL', async () => {
    const { env, wasAccessed } = makeEnvWithBackendUrlSpy({ APP_ENV: 'demo', API_BACKEND_URL: 'https://backend.example.com' });
    await onRequest({ request: makeRequest({ origin: 'https://agrogenomax.com' }), env });
    assert.equal(wasAccessed(), false);
  });

  test('3. demo no llama fetch', async () => {
    const { getCalls } = stubFetch();
    await onRequest({ request: makeRequest({ origin: 'https://agrogenomax.com' }), env: { APP_ENV: 'demo', API_BACKEND_URL: 'https://backend.example.com' } });
    assert.equal(getCalls(), 0);
  });

  test('4. APP_ENV ausente responde 503', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({ request: makeRequest({}), env: {} });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('5. APP_ENV inválida responde 503', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({ request: makeRequest({}), env: { APP_ENV: 'preproduccion' } });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('6. API_BACKEND_URL ausente responde 503', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({ request: makeRequest({}), env: { APP_ENV: 'production' } });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('7. API_BACKEND_URL inválida responde 503', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({ request: makeRequest({}), env: { APP_ENV: 'production', API_BACKEND_URL: 'no-es-una-url' } });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('8. API_BACKEND_URL con credenciales se rechaza', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: { APP_ENV: 'production', API_BACKEND_URL: 'https://usuario:secreto@backend.example.com' },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('9. API_BACKEND_URL con query se rechaza', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend.example.com?x=1' },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('10. API_BACKEND_URL con fragmento se rechaza', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend.example.com#frag' },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('11. API_BACKEND_URL con path ambiguo se rechaza', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend.example.com/api' },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  // Tests 12-17: la lista negativa es defensa ADICIONAL, evaluada solo
  // después de la igualdad positiva -- por eso API_BACKEND_ALLOWED_ORIGIN
  // se fija exactamente igual a API_BACKEND_URL en cada caso, para que el
  // 503 provenga genuinamente de la lista de rechazo, no de la variable
  // positiva ausente.
  test('12. staging rechaza localhost', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: {
        APP_ENV: 'staging',
        API_BACKEND_URL: 'http://localhost:3001',
        API_BACKEND_ALLOWED_ORIGIN: 'http://localhost:3001',
      },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('13. staging rechaza demo', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: {
        APP_ENV: 'staging',
        API_BACKEND_URL: 'https://demo.agrogenomax.com',
        API_BACKEND_ALLOWED_ORIGIN: 'https://demo.agrogenomax.com',
      },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('14. staging rechaza production inequívoca', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: {
        APP_ENV: 'staging',
        API_BACKEND_URL: 'https://agrogenomax.com',
        API_BACKEND_ALLOWED_ORIGIN: 'https://agrogenomax.com',
      },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('15. production rechaza localhost', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: {
        APP_ENV: 'production',
        API_BACKEND_URL: 'http://127.0.0.1:3001',
        API_BACKEND_ALLOWED_ORIGIN: 'http://127.0.0.1:3001',
      },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('16. production rechaza staging', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: {
        APP_ENV: 'production',
        API_BACKEND_URL: 'https://staging.agrogenomax.com',
        API_BACKEND_ALLOWED_ORIGIN: 'https://staging.agrogenomax.com',
      },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('17. production rechaza demo', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: {
        APP_ENV: 'production',
        API_BACKEND_URL: 'https://demo.agrogenomax.com',
        API_BACKEND_ALLOWED_ORIGIN: 'https://demo.agrogenomax.com',
      },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('18. no existe fallback Railway', async () => {
    const { getCalls, getArgs } = stubFetch();
    const response = await onRequest({ request: makeRequest({}), env: { APP_ENV: 'production' } });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
    assert.equal(getArgs().length, 0);
    // El único host de Railway mencionado en el código es una entrada de
    // la lista de rechazo para staging -- nunca un valor por defecto/
    // fallback al que el relay caiga automáticamente.
    assert.ok(!/API_BACKEND_URL\s*\|\|.*railway/i.test(healthSource));
  });

  test('19. URL final es exactamente /api/health/live', async () => {
    const { getArgs } = stubFetch();
    await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    assert.equal(getArgs()[0][0], 'https://backend.example.com/api/health/live');
  });

  test('20. no se produce /api/api/health/live', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend.example.com/api' },
    });
    // API_BACKEND_URL con path se rechaza por completo -- estructuralmente
    // imposible producir /api/api/health/live.
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('21. preflight válido responde 204 sin fetch', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({
        method: 'OPTIONS',
        origin: 'https://agrogenomax.com',
        headers: { 'Access-Control-Request-Method': 'GET' },
      }),
      env: PRODUCTION_ENV,
    });
    assert.equal(response.status, 204);
    assert.equal(getCalls(), 0);
  });

  test('22. preflight inválido responde 403 sin fetch', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({
        method: 'OPTIONS',
        origin: 'https://evil.example',
        headers: { 'Access-Control-Request-Method': 'GET' },
      }),
      env: PRODUCTION_ENV,
    });
    assert.equal(response.status, 403);
    assert.equal(getCalls(), 0);
  });

  test('23. Origin:null responde 403 sin fetch', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({ request: makeRequest({ origin: 'null' }), env: PRODUCTION_ENV });
    assert.equal(response.status, 403);
    assert.equal(getCalls(), 0);
  });

  test('24. Origin ausente puede continuar sin ACAO', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(getCalls(), 1);
  });

  test('25. origen permitido recibe ACAO exacto', async () => {
    stubFetch();
    const response = await onRequest({ request: makeRequest({ origin: 'https://agrogenomax.co' }), env: PRODUCTION_ENV });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://agrogenomax.co');
  });

  test('26. nunca se devuelve ACAO:*', async () => {
    stubFetch();
    const responses = await Promise.all([
      onRequest({ request: makeRequest({ origin: 'https://agrogenomax.com' }), env: PRODUCTION_ENV }),
      onRequest({ request: makeRequest({}), env: PRODUCTION_ENV }),
      onRequest({ request: makeRequest({ origin: 'https://evil.example' }), env: PRODUCTION_ENV }),
    ]);
    for (const response of responses) {
      assert.notEqual(response.headers.get('Access-Control-Allow-Origin'), '*');
    }
  });

  test('27. fetch usa timeout (AbortSignal presente)', async () => {
    let capturedSignal;
    globalThis.fetch = async (_url, init) => {
      capturedSignal = init.signal;
      return jsonUpstreamResponse({ status: 'ok', check: 'liveness' });
    };
    await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    assert.ok(capturedSignal instanceof AbortSignal);
  });

  test('28. timeout devuelve 504', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      });

    const responsePromise = onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    mock.timers.tick(3000);
    const response = await responsePromise;
    assert.equal(response.status, 504);
    const body = await response.json();
    assert.equal(body.status, 'error');
    assert.equal(body.reason, 'upstream_timeout');
  });

  test('29. error de red devuelve 502', async () => {
    globalThis.fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND backend.example.com');
    };
    const response = await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.reason, 'upstream_unreachable');
  });

  test('30. upstream 500 no se convierte en 200', async () => {
    stubFetch(async () => new Response(null, { status: 500 }));
    const response = await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    assert.equal(response.status, 502);
    assert.notEqual(response.status, 200);
  });

  test('31. upstream 503 no se convierte en 200', async () => {
    stubFetch(async () => new Response(null, { status: 503 }));
    const response = await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    assert.equal(response.status, 503);
    assert.notEqual(response.status, 200);
  });

  test('32. upstream HTML devuelve 502', async () => {
    stubFetch(async () => new Response('<html><body>Not JSON</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    const response = await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    assert.equal(response.status, 502);
  });

  test('33. upstream JSON malformado devuelve 502', async () => {
    stubFetch(async () => new Response('{not valid json', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const response = await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    assert.equal(response.status, 502);
  });

  test('34. upstream JSON sin status devuelve 502', async () => {
    stubFetch(async () => jsonUpstreamResponse({ check: 'liveness' }));
    const response = await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    assert.equal(response.status, 502);
  });

  test('35. upstream JSON sin check=liveness devuelve 502', async () => {
    stubFetch(async () => jsonUpstreamResponse({ status: 'ok', check: 'readiness' }));
    const response = await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    assert.equal(response.status, 502);
  });

  test('36. upstream status diferente de ok devuelve error', async () => {
    stubFetch(async () => jsonUpstreamResponse({ status: 'degraded', check: 'liveness' }));
    const response = await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.status, 'error');
  });

  test('37. upstream válido devuelve 200', async () => {
    stubFetch(async () => jsonUpstreamResponse({ status: 'ok', check: 'liveness', timestamp: '2026-01-01T00:00:00.000Z', appEnv: 'production' }));
    const response = await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    assert.equal(response.status, 200);
  });

  test('38. payload exitoso conserva status/check', async () => {
    stubFetch(async () => jsonUpstreamResponse({ status: 'ok', check: 'liveness', timestamp: '2026-01-01T00:00:00.000Z' }));
    const response = await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.check, 'liveness');
    assert.equal(body.timestamp, '2026-01-01T00:00:00.000Z');
  });

  test('39. campos extra del upstream se descartan', async () => {
    stubFetch(async () =>
      jsonUpstreamResponse({
        status: 'ok',
        check: 'liveness',
        timestamp: '2026-01-01T00:00:00.000Z',
        secretInternal: 'no-debe-propagarse',
        databaseUrl: 'postgres://no-debe-verse',
      }),
    );
    const response = await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['check', 'status', 'timestamp']);
    assert.equal('secretInternal' in body, false);
    assert.equal('databaseUrl' in body, false);
  });

  test('40. Cache-Control:no-store en éxito', async () => {
    stubFetch();
    const response = await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  });

  test('41. Cache-Control:no-store en errores', async () => {
    const { getCalls } = stubFetch();
    const configError = await onRequest({ request: makeRequest({}), env: { APP_ENV: 'production' } });
    assert.equal(configError.headers.get('Cache-Control'), 'no-store');

    const rejected = await onRequest({ request: makeRequest({ origin: 'https://evil.example' }), env: PRODUCTION_ENV });
    assert.equal(rejected.headers.get('Cache-Control'), 'no-store');

    const demo = await onRequest({ request: makeRequest({}), env: { APP_ENV: 'demo' } });
    assert.equal(demo.headers.get('Cache-Control'), 'no-store');
    assert.equal(getCalls(), 0);
  });

  test('42. Content-Type JSON', async () => {
    stubFetch();
    const response = await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    assert.ok(response.headers.get('Content-Type').includes('application/json'));
  });

  test('43. X-Content-Type-Options:nosniff', async () => {
    stubFetch();
    const response = await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  });

  test('44. no se propagan cookies/headers internos', async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ status: 'ok', check: 'liveness' }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': 'session=abc123',
            Server: 'nginx-internal',
            Via: '1.1 upstream-proxy',
          },
        }),
    );
    const response = await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.equal(response.headers.get('Server'), null);
    assert.equal(response.headers.get('Via'), null);
  });

  test('45. no se expone API_BACKEND_URL en errores', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: { APP_ENV: 'production', API_BACKEND_URL: 'https://secreto-interno.example/con-credenciales' },
    });
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.ok(!body.includes('secreto-interno'));
    assert.equal(getCalls(), 0);
  });

  test('46. reporter no incluye secretos', async () => {
    stubFetch(async () => new Response(null, { status: 500 }));
    const events = [];
    await onRequest({
      request: makeRequest({}),
      env: STAGING_ENV,
      reporter: (event) => events.push(event),
    });
    assert.equal(events.length, 1);
    const serialized = JSON.stringify(events[0]);
    assert.ok(!serialized.includes('backend-staging.example.com'));
    assert.ok(!serialized.toLowerCase().includes('authorization'));
    assert.ok(!serialized.toLowerCase().includes('cookie'));
  });

  test('47. no se consulta base de datos (health.js no importa db.js/catastroxDb.js)', () => {
    const importLines = healthSource.split('\n').filter((line) => line.trim().startsWith('import '));
    assert.ok(!importLines.some((line) => /db\.js|catastroxDb\.js/.test(line)));
  });

  test('48. no se implementa readiness', async () => {
    stubFetch();
    const response = await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    const body = await response.json();
    for (const readinessField of ['checks', 'domains', 'database', 'postgis', 'ready']) {
      assert.equal(readinessField in body, false);
    }
  });

  test('49. functions/_data/agxStatic.js ya no fabrica esta respuesta', async () => {
    const importLines = healthSource.split('\n').filter((line) => line.trim().startsWith('import '));
    assert.ok(!importLines.some((line) => line.includes('agxStatic')));

    // "pages-static-fallback" solo puede sobrevivir como referencia
    // histórica en un comentario -- nunca en código ejecutable que lo
    // devuelva.
    const codeLines = healthSource.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
    assert.ok(!codeLines.some((line) => line.includes('pages-static-fallback')));

    stubFetch();
    const response = await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    const body = await response.json();
    assert.notEqual(body.database, 'pages-static-fallback');
  });

  test('50. la política CORS coincide con LOTE-004/004B (mismo módulo compartido, sin allowlist propia)', async () => {
    // Fuente estática: health.js importa la política desde el mismo
    // módulo que server/security/corsPolicy.js y los relays de CatastroX
    // -- nunca redefine su propia allowlist.
    assert.ok(healthSource.includes("from '../../shared/security/corsPolicy.js'"));
    assert.ok(!/const\s+\w*ALLOWED_ORIGINS\w*\s*=\s*\[/i.test(healthSource));

    // Comportamiento: la misma allowlist de producción (agrogenomax.com/.co)
    // que server/security/corsPolicy.js y los relays de CatastroX ya
    // verifican produce el mismo resultado aquí.
    stubFetch();
    for (const origin of ['https://agrogenomax.com', 'https://agrogenomax.co']) {
      const response = await onRequest({ request: makeRequest({ origin }), env: PRODUCTION_ENV });
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    }
  });
});

describe('LOTE-006 (corrección): API_BACKEND_ALLOWED_ORIGIN -- mecanismo positivo definitivo', () => {
  test('D1. staging sin API_BACKEND_ALLOWED_ORIGIN responde 503', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: { APP_ENV: 'staging', API_BACKEND_URL: 'https://backend-staging.example.com' },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('D2. production sin API_BACKEND_ALLOWED_ORIGIN responde 503', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: { APP_ENV: 'production', API_BACKEND_URL: 'https://backend.example.com' },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('D3. staging con URL y origen autorizado iguales puede llamar fetch', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({ request: makeRequest({}), env: STAGING_ENV });
    assert.equal(response.status, 200);
    assert.equal(getCalls(), 1);
  });

  test('D4. production con URL y origen autorizado iguales puede llamar fetch', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({ request: makeRequest({}), env: PRODUCTION_ENV });
    assert.equal(response.status, 200);
    assert.equal(getCalls(), 1);
  });

  test('D5. staging con valores distintos responde 503 sin fetch', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: {
        APP_ENV: 'staging',
        API_BACKEND_URL: 'https://backend-staging.example.com',
        API_BACKEND_ALLOWED_ORIGIN: 'https://otro-backend-staging.example.com',
      },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('D6. production con valores distintos responde 503 sin fetch', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: {
        APP_ENV: 'production',
        API_BACKEND_URL: 'https://backend.example.com',
        API_BACKEND_ALLOWED_ORIGIN: 'https://otro-backend.example.com',
      },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('D7. diferencia solo por barra final se normaliza correctamente (coinciden, permite fetch)', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: {
        APP_ENV: 'production',
        API_BACKEND_URL: 'https://backend.example.com/',
        API_BACKEND_ALLOWED_ORIGIN: 'https://backend.example.com',
      },
    });
    assert.equal(response.status, 200);
    assert.equal(getCalls(), 1);
  });

  test('D8. diferencia de protocolo se rechaza', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: {
        APP_ENV: 'production',
        API_BACKEND_URL: 'http://backend.example.com',
        API_BACKEND_ALLOWED_ORIGIN: 'https://backend.example.com',
      },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('D9. diferencia de puerto se rechaza', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: {
        APP_ENV: 'production',
        API_BACKEND_URL: 'https://backend.example.com:8443',
        API_BACKEND_ALLOWED_ORIGIN: 'https://backend.example.com',
      },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('D10. diferencia de hostname se rechaza', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: {
        APP_ENV: 'production',
        API_BACKEND_URL: 'https://backend-a.example.com',
        API_BACKEND_ALLOWED_ORIGIN: 'https://backend-b.example.com',
      },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('D11. origen autorizado con path se rechaza', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: {
        APP_ENV: 'production',
        API_BACKEND_URL: 'https://backend.example.com',
        API_BACKEND_ALLOWED_ORIGIN: 'https://backend.example.com/health',
      },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('D12. origen autorizado con query se rechaza', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: {
        APP_ENV: 'production',
        API_BACKEND_URL: 'https://backend.example.com',
        API_BACKEND_ALLOWED_ORIGIN: 'https://backend.example.com?x=1',
      },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('D13. origen autorizado con fragmento se rechaza', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: {
        APP_ENV: 'production',
        API_BACKEND_URL: 'https://backend.example.com',
        API_BACKEND_ALLOWED_ORIGIN: 'https://backend.example.com#frag',
      },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('D14. origen autorizado con credenciales se rechaza', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: {
        APP_ENV: 'production',
        API_BACKEND_URL: 'https://backend.example.com',
        API_BACKEND_ALLOWED_ORIGIN: 'https://usuario:secreto@backend.example.com',
      },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('D15. dominio externo arbitrario no funciona solo por no estar en la blacklist', async () => {
    const { getCalls } = stubFetch();
    // "cualquier-dominio-externo.example" no coincide con ningún patrón de
    // la lista de rechazo (no es demo/staging/production/localhost/
    // Railway conocidos) -- antes de esta corrección habría pasado la
    // única validación existente. Ahora, sin API_BACKEND_ALLOWED_ORIGIN
    // igual, debe rechazarse igualmente.
    const response = await onRequest({
      request: makeRequest({}),
      env: { APP_ENV: 'production', API_BACKEND_URL: 'https://cualquier-dominio-externo.example' },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('D16. development funciona sin variable adicional cuando API_BACKEND_URL es local y válida', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: { APP_ENV: 'development', API_BACKEND_URL: 'http://127.0.0.1:3001' },
    });
    assert.equal(response.status, 200);
    assert.equal(getCalls(), 1);
  });

  test('D17. development con variable adicional distinta falla', async () => {
    const { getCalls } = stubFetch();
    const response = await onRequest({
      request: makeRequest({}),
      env: {
        APP_ENV: 'development',
        API_BACKEND_URL: 'http://127.0.0.1:3001',
        API_BACKEND_ALLOWED_ORIGIN: 'http://127.0.0.1:4000',
      },
    });
    assert.equal(response.status, 503);
    assert.equal(getCalls(), 0);
  });

  test('D18. demo no lee API_BACKEND_ALLOWED_ORIGIN', async () => {
    const { env, wasAccessed } = (() => {
      let accessed = false;
      const envObj = { APP_ENV: 'demo', API_BACKEND_URL: 'https://backend.example.com' };
      Object.defineProperty(envObj, 'API_BACKEND_ALLOWED_ORIGIN', {
        enumerable: true,
        configurable: true,
        get() {
          accessed = true;
          return 'https://backend.example.com';
        },
      });
      return { env: envObj, wasAccessed: () => accessed };
    })();
    const response = await onRequest({ request: makeRequest({}), env });
    assert.equal(response.status, 404);
    assert.equal(wasAccessed(), false);
  });

  test('D19. errores no exponen API_BACKEND_URL', async () => {
    const response = await onRequest({
      request: makeRequest({}),
      env: {
        APP_ENV: 'production',
        API_BACKEND_URL: 'https://backend-secreto-real.example.com',
        API_BACKEND_ALLOWED_ORIGIN: 'https://otro-distinto.example.com',
      },
    });
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.ok(!body.includes('backend-secreto-real'));
  });

  test('D20. errores no exponen API_BACKEND_ALLOWED_ORIGIN', async () => {
    const response = await onRequest({
      request: makeRequest({}),
      env: {
        APP_ENV: 'production',
        API_BACKEND_URL: 'https://backend.example.com',
        API_BACKEND_ALLOWED_ORIGIN: 'https://autorizado-secreto.example.com',
      },
    });
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.ok(!body.includes('autorizado-secreto'));
  });
});
