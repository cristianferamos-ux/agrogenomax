import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onRequest, LEGACY_QR_HOST, CANONICAL_ORIGIN } from '../[codigo].js';
import { onRequest as apiCatchAll } from '../../api/[[path]].js';

// HOTFIX-LEGACY-QR-CANONICAL-ORIGIN: functions/qr/[codigo].js redirige SOLO
// https://agrogenomax.pages.dev/qr/<codigo> al origen canónico. `next()` se
// simula: cualquier otro host o método debe llegar ahí sin respuesta propia.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const source = fs.readFileSync(path.resolve(__dirname, '..', '[codigo].js'), 'utf8');

const NEXT = new Response('spa', { status: 200 });

function call(url, { method = 'GET', codigo, headers = {} } = {}) {
  let nextCalls = 0;
  const request = new Request(url, { method, headers });
  const params = { codigo: codigo ?? decodeURIComponent(new URL(url).pathname.split('/').pop()) };
  const response = onRequest({ request, params, next: () => { nextCalls += 1; return NEXT; } });
  return { response, nextCalls };
}

describe('functions/qr/[codigo].js -- redirección canónica de QR legacy', () => {
  test('1. agrogenomax.pages.dev/qr/AGX-000003 -> 302 a https://agrogenomax.com/qr/AGX-000003, sin caché', () => {
    const { response, nextCalls } = call('https://agrogenomax.pages.dev/qr/AGX-000003');
    assert.equal(nextCalls, 0);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), 'https://agrogenomax.com/qr/AGX-000003');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  });

  test('2-4. agrogenomax.com, www y previews de rama -> next() (SPA sin cambios)', () => {
    for (const url of [
      'https://agrogenomax.com/qr/AGX-000003',
      'https://www.agrogenomax.com/qr/AGX-000003',
      'https://feature-ganaderia-animales-m.agrogenomax.pages.dev/qr/AGX-000003',
      'https://hotfix-legacy-qr-canonical.agrogenomax.pages.dev/qr/AGX-000003',
    ]) {
      const { response, nextCalls } = call(url);
      assert.equal(nextCalls, 1, url);
      assert.equal(response, NEXT, url);
    }
  });

  test('5. hosts parecidos o maliciosos -> next(), nunca redirigen', () => {
    for (const url of [
      'https://agrogenomax.pages.dev.evil.example/qr/AGX-000003',
      'https://evil-agrogenomax.pages.dev/qr/AGX-000003',
      'https://agrogenomax.pages.devx/qr/AGX-000003',
    ]) {
      const { nextCalls } = call(url);
      assert.equal(nextCalls, 1, url);
    }
  });

  test('solo GET redirige: HEAD/POST en pages.dev -> next()', () => {
    for (const method of ['HEAD', 'POST', 'OPTIONS']) {
      const { nextCalls } = call('https://agrogenomax.pages.dev/qr/AGX-000003', { method });
      assert.equal(nextCalls, 1, method);
    }
  });

  test('6. código con caracteres especiales -> encodeURIComponent, el destino sigue siendo agrogenomax.com', () => {
    for (const codigo of ['//evil.example', 'a/../../x', '?next=https://evil.example', '#frag', '@evil.example', 'AGX 000003']) {
      const { response } = call('https://agrogenomax.pages.dev/qr/x', { codigo });
      const location = new URL(response.headers.get('Location'));
      assert.equal(location.origin, CANONICAL_ORIGIN, codigo);
      assert.equal(location.pathname, `/qr/${encodeURIComponent(codigo)}`, codigo);
      assert.equal(location.search, '', codigo);
      assert.equal(location.hash, '', codigo);
    }
  });

  test('6b. el destino nunca sale de query, cabeceras ni Host', () => {
    const { response } = call('https://agrogenomax.pages.dev/qr/AGX-000003?origin=https://evil.example&next=//evil.example', {
      headers: { 'X-Forwarded-Host': 'evil.example', Origin: 'https://evil.example', Referer: 'https://evil.example/' },
    });
    assert.equal(response.headers.get('Location'), 'https://agrogenomax.com/qr/AGX-000003');
    assert.equal(LEGACY_QR_HOST, 'agrogenomax.pages.dev');
    assert.equal(CANONICAL_ORIGIN, 'https://agrogenomax.com');
    assert.doesNotMatch(source, /request\.headers|searchParams|\.host\b|env\./, 'el destino no depende de la petición');
  });

  test('7. /api/qr/AGX-000003 sigue en 404 JSON (comodín de functions/api)', async () => {
    const response = apiCatchAll();
    assert.equal(response.status, 404);
    assert.match(response.headers.get('Content-Type'), /application\/json/);
    assert.deepEqual(await response.json(), { error: 'Not Found', code: 'API_ROUTE_NOT_FOUND' });
  });

  test('8. contención legacy: no reaparecen functions/api/qr/[codigo].js ni functions/_data/agxStatic.js; la Function no consulta ninguna API', () => {
    for (const file of ['functions/api/qr/[codigo].js', 'functions/_data/agxStatic.js']) {
      assert.equal(fs.existsSync(path.join(REPO_ROOT, file)), false, file);
    }
    for (const forbidden of [/fetch\(/, /agxStatic/, /import\s/]) {
      assert.doesNotMatch(source, forbidden);
    }
    // FASE 3B: la única mención de /api/ es el Path de la cookie efímera
    // (atributo, no una consulta).
    const sinComentarios = source.replace(/^\s*\/\/.*$/gm, '');
    assert.deepEqual(sinComentarios.match(/['"`][^'"`]*\/api\/[^'"`]*['"`]/g), ["'/api/ganaderia/qr'"]);
  });
});

// ---------------------------------------------------------------------------
// FASE 3B: token QR fuera de la URL. La chapeta impresa abre GET /qr/<token>;
// la Function responde 303 a la URL limpia /ganaderia/qr y deja el token
// solo en una cookie HttpOnly acotada al resolver.
// ---------------------------------------------------------------------------
const TOKEN = 'aB3_-xYz09QwErTyUiOpAsDfGhJkLzXc';

describe('FASE 3B: functions/qr/[codigo].js -- token fuera de la URL', () => {
  test('3B-1. /qr/<token> en el origen canónico -> 303 a /ganaderia/qr; Location sin token', () => {
    for (const url of [
      `https://agrogenomax.com/qr/${TOKEN}`,
      `https://www.agrogenomax.com/qr/${TOKEN}`,
      `https://feature-x.agrogenomax.pages.dev/qr/${TOKEN}`,
    ]) {
      const { response, nextCalls } = call(url);
      assert.equal(nextCalls, 0, url);
      assert.equal(response.status, 303, url);
      assert.equal(response.headers.get('Location'), '/ganaderia/qr', url);
      assert.ok(!response.headers.get('Location').includes(TOKEN));
    }
  });

  test('3B-2. cookie efímera: HttpOnly, Secure (__Secure-) en https, Path acotado al resolver, SameSite=Lax, 10 min', () => {
    const { response } = call(`https://agrogenomax.com/qr/${TOKEN}`);
    assert.equal(
      response.headers.get('Set-Cookie'),
      `__Secure-agx_qr_pendiente=${TOKEN}; Max-Age=600; Path=/api/ganaderia/qr; HttpOnly; SameSite=Lax; Secure`,
    );
    const local = call(`http://localhost:8788/qr/${TOKEN}`).response;
    assert.equal(local.headers.get('Set-Cookie'), `agx_qr_pendiente=${TOKEN}; Max-Age=600; Path=/api/ganaderia/qr; HttpOnly; SameSite=Lax`);
  });

  test('3B-3. cabeceras: no-store, no-cache, Referrer-Policy no-referrer, nosniff; sin body', async () => {
    const { response } = call(`https://agrogenomax.com/qr/${TOKEN}`);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Pragma'), 'no-cache');
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(await response.text(), '');
  });

  test('3B-4. códigos visibles (no secretos) y valores inválidos siguen al SPA sin cambios', () => {
    for (const valor of ['AGX-000003', 'AGX-7KM4-P2XZ-R', 'corto', `${TOKEN}x`, TOKEN.slice(1)]) {
      const { response, nextCalls } = call(`https://agrogenomax.com/qr/${encodeURIComponent(valor)}`, { codigo: valor });
      assert.equal(nextCalls, 1, valor);
      assert.equal(response, NEXT, valor);
    }
  });

  test('3B-5. chapeta impresa con pages.dev: 302 al canónico (sin caché, sin Referer) y allí 303 + cookie', () => {
    const legacy = call(`https://agrogenomax.pages.dev/qr/${TOKEN}`).response;
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(legacy.headers.get('Set-Cookie'), null, 'la cookie solo se fija en el origen canónico');
    const canonical = call(legacy.headers.get('Location')).response;
    assert.equal(canonical.status, 303);
    assert.equal(canonical.headers.get('Location'), '/ganaderia/qr');
  });

  test('3B-6. solo GET: HEAD/POST con token -> next(), sin cookie', () => {
    for (const method of ['HEAD', 'POST']) {
      const { nextCalls } = call(`https://agrogenomax.com/qr/${TOKEN}`, { method });
      assert.equal(nextCalls, 1, method);
    }
  });

  test('3B-7. misma cookie que el servidor (qrPendienteCookie.js): nombre, Path y Max-Age', async () => {
    const server = await import('../../../server/security/qrPendienteCookie.js');
    const fn = await import('../[codigo].js');
    assert.equal(fn.qrPendienteCookieName(true), server.qrPendienteCookieName('production'));
    assert.equal(fn.qrPendienteCookieName(true), server.qrPendienteCookieName('staging'));
    assert.equal(fn.qrPendienteCookieName(false), server.qrPendienteCookieName('development'));
    assert.equal(fn.QR_PENDIENTE_COOKIE_PATH, server.QR_PENDIENTE_COOKIE_PATH);
    assert.equal(fn.QR_PENDIENTE_MAX_AGE_SECONDS, server.QR_PENDIENTE_MAX_AGE_SECONDS);
    const { response } = call(`https://agrogenomax.com/qr/${TOKEN}`);
    const cookieHeader = response.headers.get('Set-Cookie').split(';')[0];
    assert.equal(server.getQrPendienteTokenFromCookieHeader(`otra=1; ${cookieHeader}`, 'production'), TOKEN);
    assert.equal(server.getQrPendienteTokenFromCookieHeader(cookieHeader, 'development'), null, 'nombre distinto por ambiente');
    assert.equal(server.getQrPendienteTokenFromCookieHeader('__Secure-agx_qr_pendiente=../../x', 'production'), null);
    assert.equal(server.hasQrPendienteCookie('__Secure-agx_qr_pendiente=../../x', 'production'), true);
    assert.equal(server.hasQrPendienteCookie('agx_session=1', 'production'), false);
    assert.match(server.buildQrPendienteClearCookieHeader('production'), /^__Secure-agx_qr_pendiente=; Max-Age=0; Path=\/api\/ganaderia\/qr; HttpOnly; SameSite=Lax; Secure$/);
  });
});
