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
    for (const forbidden of [/fetch\(/, /agxStatic/, /\/api\//, /import\s/]) {
      assert.doesNotMatch(source, forbidden);
    }
  });
});
