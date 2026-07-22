import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { corsPreflightResponse, corsRejectedResponse, evaluateStaticCors, json } from '../agxStatic.js';
import { onRequestGet as animalGet, onRequestOptions as animalOptions } from '../../api/animales/[id].js';
import { onRequestGet as razasGet } from '../../api/animales/[id]/razas.js';
import { onRequestGet as qrGet, onRequestOptions as qrOptions } from '../../api/qr/[codigo].js';
import { resolveAllowedOriginsForEnvironment } from '../../../shared/security/corsPolicy.js';

// LOTE-004B: pruebas de los endpoints estáticos de Cloudflare Pages
// Functions (health/animales/qr) que consumían functions/_data/agxStatic.js
// con Access-Control-Allow-Origin: '*' incondicional. `Request`/`Headers`/
// `Response` son APIs Web globales en este runtime de Node -- sin
// Miniflare/Wrangler, sin red real (estos endpoints nunca hacen fetch).
//
// Ajuste LOTE-006: functions/api/health.js dejó de ser un endpoint
// estático (ahora es el relay real de health, con su propia suite en
// functions/api/__tests__/healthRelay.test.js) -- este archivo sigue
// probando el adaptador CORS compartido de agxStatic.js (evaluateStaticCors/
// corsPreflightResponse/corsRejectedResponse/json) mediante un sujeto de
// prueba equivalente al que health.js exponía antes de LOTE-006, en lugar
// de importar de health.js directamente. animales/[id].js y qr/[codigo].js
// (todavía endpoints estáticos reales) siguen probándose vía su propio
// código sin ningún cambio.
function healthGet({ request, env } = {}) {
  const decision = evaluateStaticCors({ request, env });
  if (decision.action === 'reject') {
    return corsRejectedResponse(decision);
  }
  return json({ ok: true, database: 'test-fixture', schema: 'agx' }, {}, decision);
}
const healthOptions = corsPreflightResponse;

function makeRequest({ method = 'GET', url = 'https://relay.example/api/health', origin, headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  if (origin !== undefined) requestHeaders.set('Origin', origin);
  return new Request(url, { method, headers: requestHeaders });
}

describe('LOTE-004B: CORS en endpoints estáticos de Cloudflare (functions/_data/agxStatic.js)', () => {
  test('1. no existe ACAO:* en ningún caso permitido', async () => {
    const response = await healthGet({ request: makeRequest({ origin: 'https://agrogenomax.com' }), env: { APP_ENV: 'production' } });
    assert.notEqual(response.headers.get('Access-Control-Allow-Origin'), '*');
  });

  test('2. origen permitido recibe ACAO exacto', async () => {
    const response = await healthGet({
      request: makeRequest({ origin: 'https://staging.agrogenomax.com' }),
      env: { APP_ENV: 'staging' },
    });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://staging.agrogenomax.com');
  });

  test('3. origen rechazado no recibe ACAO', async () => {
    const response = await healthGet({
      request: makeRequest({ origin: 'https://attacker.example' }),
      env: { APP_ENV: 'production' },
    });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(response.status, 403);
  });

  test('4. Origin:null se rechaza', async () => {
    const response = await healthGet({ request: makeRequest({ origin: 'null' }), env: { APP_ENV: 'production' } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  });

  test('5. solicitud sin Origin continúa sin ACAO', async () => {
    const response = await healthGet({ request: makeRequest({}), env: { APP_ENV: 'production' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  });

  test('6. staging permite staging.agrogenomax.com', async () => {
    const response = await healthGet({
      request: makeRequest({ origin: 'https://staging.agrogenomax.com' }),
      env: { APP_ENV: 'staging' },
    });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://staging.agrogenomax.com');
  });

  test('7. staging rechaza demo', async () => {
    const response = await healthGet({
      request: makeRequest({ origin: 'https://demo.agrogenomax.com' }),
      env: { APP_ENV: 'staging' },
    });
    assert.equal(response.status, 403);
  });

  test('8. staging rechaza production', async () => {
    const response = await healthGet({
      request: makeRequest({ origin: 'https://agrogenomax.com' }),
      env: { APP_ENV: 'staging' },
    });
    assert.equal(response.status, 403);
  });

  test('9. production permite agrogenomax.com', async () => {
    const response = await healthGet({
      request: makeRequest({ origin: 'https://agrogenomax.com' }),
      env: { APP_ENV: 'production' },
    });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://agrogenomax.com');
  });

  test('10. production permite agrogenomax.co', async () => {
    const response = await healthGet({
      request: makeRequest({ origin: 'https://agrogenomax.co' }),
      env: { APP_ENV: 'production' },
    });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://agrogenomax.co');
  });

  test('11. production rechaza staging', async () => {
    const response = await healthGet({
      request: makeRequest({ origin: 'https://staging.agrogenomax.com' }),
      env: { APP_ENV: 'production' },
    });
    assert.equal(response.status, 403);
  });

  test('12. production rechaza demo', async () => {
    const response = await healthGet({
      request: makeRequest({ origin: 'https://demo.agrogenomax.com' }),
      env: { APP_ENV: 'production' },
    });
    assert.equal(response.status, 403);
  });

  test('13. production rechaza Railway', async () => {
    const response = await healthGet({
      request: makeRequest({ origin: 'https://agrogenomax-production.up.railway.app' }),
      env: { APP_ENV: 'production' },
    });
    assert.equal(response.status, 403);
  });

  test('14. demo no permite cross-origin arbitrario', async () => {
    const anyOrigin = await healthGet({
      request: makeRequest({ origin: 'https://cualquier-cosa.example' }),
      env: { APP_ENV: 'demo' },
    });
    assert.equal(anyOrigin.status, 403);
    assert.equal(anyOrigin.headers.get('Access-Control-Allow-Origin'), null);

    // demo no admite ampliar su CORS ni siquiera vía CORS_ALLOWED_ORIGINS
    // -- configuración mal formada, falla-rápido (503), nunca un permiso
    // implícito.
    const attemptedExtension = await healthGet({
      request: makeRequest({ origin: 'https://cualquier-cosa.example' }),
      env: { APP_ENV: 'demo', CORS_ALLOWED_ORIGINS: 'https://cualquier-cosa.example' },
    });
    assert.equal(attemptedExtension.status, 503);

    // Sin Origin (same-origin dentro del propio despliegue de demo), sigue
    // funcionando con normalidad.
    const sameOrigin = await healthGet({ request: makeRequest({}), env: { APP_ENV: 'demo' } });
    assert.equal(sameOrigin.status, 200);
    assert.equal(sameOrigin.headers.get('Access-Control-Allow-Origin'), null);
  });

  test('15. OPTIONS válido no ejecuta lógica del endpoint', async () => {
    const response = await animalOptions({
      request: makeRequest({
        method: 'OPTIONS',
        origin: 'https://agrogenomax.com',
        headers: { 'Access-Control-Request-Method': 'GET' },
      }),
      env: { APP_ENV: 'production' },
    });
    assert.equal(response.status, 204);
    const body = await response.text();
    assert.equal(body, '');
  });

  test('16. OPTIONS inválido no ejecuta lógica del endpoint', async () => {
    const response = await animalOptions({
      request: makeRequest({
        method: 'OPTIONS',
        origin: 'https://evil.example',
        headers: { 'Access-Control-Request-Method': 'GET' },
      }),
      env: { APP_ENV: 'production' },
    });
    assert.equal(response.status, 403);
    const body = await response.text();
    assert.equal(body, '');
  });

  test('17. health sin Origin continúa funcionando incluso con APP_ENV ausente', async () => {
    const response = await healthGet({ request: makeRequest({}), env: {} });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
  });

  test('18. animales y QR conservan su respuesta funcional', async () => {
    const animalResponse = await animalGet({
      params: { id: '4' },
      request: makeRequest({}),
      env: { APP_ENV: 'production' },
    });
    assert.equal(animalResponse.status, 200);
    const animalPayload = await animalResponse.json();
    assert.equal(animalPayload.nombre, 'RADAMANTIS');

    const razasResponse = await razasGet({
      params: { id: '4' },
      request: makeRequest({}),
      env: { APP_ENV: 'production' },
    });
    assert.equal(razasResponse.status, 200);
    const razasPayload = await razasResponse.json();
    assert.equal(razasPayload[0].nombre_raza, 'Angus');

    const qrResponse = await qrGet({
      params: { codigo: 'AGX-000003' },
      request: makeRequest({}),
      env: { APP_ENV: 'production' },
    });
    assert.equal(qrResponse.status, 200);
    const qrPayload = await qrResponse.json();
    assert.equal(qrPayload.exists, true);

    const notFound = await animalGet({
      params: { id: '999' },
      request: makeRequest({}),
      env: { APP_ENV: 'production' },
    });
    assert.equal(notFound.status, 404);
  });

  test('19. no se reflejan headers arbitrarios', async () => {
    const response = await animalOptions({
      request: makeRequest({
        method: 'OPTIONS',
        origin: 'https://agrogenomax.com',
        headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'X-Evil-Header' },
      }),
      env: { APP_ENV: 'production' },
    });
    assert.equal(response.status, 403);
    assert.notEqual(response.headers.get('Access-Control-Allow-Headers'), 'X-Evil-Header');
  });

  test('20. la política coincide exactamente con shared/security/corsPolicy.js (misma allowlist de producción)', async () => {
    const sharedAllowlist = resolveAllowedOriginsForEnvironment('production', []);
    assert.deepEqual([...sharedAllowlist], ['https://agrogenomax.com', 'https://agrogenomax.co']);

    for (const origin of sharedAllowlist) {
      const response = await healthGet({ request: makeRequest({ origin }), env: { APP_ENV: 'production' } });
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    }

    // qr/[codigo].js usa el mismo mecanismo -- verificación cruzada rápida.
    const qrResponse = await qrGet({
      params: { codigo: 'AGX-000003' },
      request: makeRequest({ origin: 'https://agrogenomax.co' }),
      env: { APP_ENV: 'production' },
    });
    assert.equal(qrResponse.headers.get('Access-Control-Allow-Origin'), 'https://agrogenomax.co');
  });

  test('bonus: health OPTIONS y qr OPTIONS también resuelven sin ejecutar lógica de negocio', async () => {
    const healthPreflight = await healthOptions({
      request: makeRequest({
        method: 'OPTIONS',
        origin: 'https://agrogenomax.com',
        headers: { 'Access-Control-Request-Method': 'GET' },
      }),
      env: { APP_ENV: 'production' },
    });
    assert.equal(healthPreflight.status, 204);

    const qrPreflight = await qrOptions({
      request: makeRequest({
        method: 'OPTIONS',
        origin: 'https://evil.example',
        headers: { 'Access-Control-Request-Method': 'GET' },
      }),
      env: { APP_ENV: 'production' },
    });
    assert.equal(qrPreflight.status, 403);
  });
});
