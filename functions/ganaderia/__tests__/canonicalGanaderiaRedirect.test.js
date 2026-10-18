import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onRequest, LEGACY_GANADERIA_HOST, CANONICAL_ORIGIN } from '../[[path]].js';

// HOTFIX-CANONICAL-GANADERIA-ORIGIN: functions/ganaderia/[[path]].js
// redirige SOLO https://agrogenomax.pages.dev/ganaderia/* al origen
// canónico. `next()` se simula: cualquier otro host o método debe llegar
// ahí sin respuesta propia.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.resolve(__dirname, '..', '[[path]].js'), 'utf8');

const NEXT = new Response('spa', { status: 200 });

function call(url, { method = 'GET', headers = {} } = {}) {
  let nextCalls = 0;
  const request = new Request(url, { method, headers });
  const response = onRequest({ request, next: () => { nextCalls += 1; return NEXT; } });
  return { response, nextCalls };
}

function assertRedirect(url, expectedLocation) {
  const { response, nextCalls } = call(url);
  assert.equal(nextCalls, 0, url);
  assert.equal(response.status, 302, url);
  assert.equal(response.headers.get('Location'), expectedLocation, url);
  assert.equal(response.headers.get('Cache-Control'), 'no-store', url);
}

describe('functions/ganaderia/[[path]].js -- origen canónico de Ganadería', () => {
  test('1. pages.dev /ganaderia/login -> 302 a https://agrogenomax.com/ganaderia/login', () => {
    assertRedirect('https://agrogenomax.pages.dev/ganaderia/login', 'https://agrogenomax.com/ganaderia/login');
  });

  test('2. pages.dev /ganaderia/qr/AGX-000003 y la raíz /ganaderia -> 302 conservando la ruta', () => {
    assertRedirect('https://agrogenomax.pages.dev/ganaderia/qr/AGX-000003', 'https://agrogenomax.com/ganaderia/qr/AGX-000003');
    assertRedirect('https://agrogenomax.pages.dev/ganaderia', 'https://agrogenomax.com/ganaderia');
    assertRedirect('https://agrogenomax.pages.dev/ganaderia/', 'https://agrogenomax.com/ganaderia/');
  });

  test('3. query string preservada (el hash nunca llega al servidor)', () => {
    assertRedirect(
      'https://agrogenomax.pages.dev/ganaderia/animales/nuevo?chapeta=AGX-000003&x=1',
      'https://agrogenomax.com/ganaderia/animales/nuevo?chapeta=AGX-000003&x=1',
    );
    assertRedirect(
      'https://agrogenomax.pages.dev/ganaderia/restablecer-contrasena?token=abc%2F%2B',
      'https://agrogenomax.com/ganaderia/restablecer-contrasena?token=abc%2F%2B',
    );
  });

  test('4-6. agrogenomax.com, www y previews de rama -> next() (SPA sin cambios)', () => {
    for (const url of [
      'https://agrogenomax.com/ganaderia/login',
      'https://www.agrogenomax.com/ganaderia/login',
      'https://feature-ganaderia-animales-m.agrogenomax.pages.dev/ganaderia/login',
      'https://hotfix-canonical-ganaderia-p.agrogenomax.pages.dev/ganaderia/qr/AGX-000003',
    ]) {
      const { response, nextCalls } = call(url);
      assert.equal(nextCalls, 1, url);
      assert.equal(response, NEXT, url);
    }
  });

  test('7. hosts parecidos o maliciosos -> next(), nunca redirigen', () => {
    for (const url of [
      'https://agrogenomax.pages.dev.evil.example/ganaderia/login',
      'https://evil-agrogenomax.pages.dev/ganaderia/login',
      'https://agrogenomax.pages.devx/ganaderia/login',
    ]) {
      assert.equal(call(url).nextCalls, 1, url);
    }
  });

  test('8. solo GET redirige: POST/HEAD/OPTIONS en pages.dev -> next()', () => {
    for (const method of ['POST', 'HEAD', 'OPTIONS', 'PUT']) {
      assert.equal(call('https://agrogenomax.pages.dev/ganaderia/login', { method }).nextCalls, 1, method);
    }
  });

  test('sin open redirect: el destino siempre es agrogenomax.com, nunca query, cabeceras ni Host', () => {
    const casos = [
      'https://agrogenomax.pages.dev/ganaderia/..%2F..%2F%2Fevil.example',
      'https://agrogenomax.pages.dev/ganaderia/x?next=https://evil.example&origin=//evil.example',
      'https://agrogenomax.pages.dev/ganaderia/%2F%2Fevil.example',
    ];
    for (const url of casos) {
      const { response, nextCalls } = call(url, {
        headers: { 'X-Forwarded-Host': 'evil.example', Origin: 'https://evil.example', Referer: 'https://evil.example/' },
      });
      if (nextCalls === 0) {
        const location = new URL(response.headers.get('Location'));
        assert.equal(location.origin, CANONICAL_ORIGIN, url);
        assert.match(location.pathname, /^\/ganaderia(\/|$)/, url);
      }
    }
    assert.equal(LEGACY_GANADERIA_HOST, 'agrogenomax.pages.dev');
    assert.equal(CANONICAL_ORIGIN, 'https://agrogenomax.com');
    assert.doesNotMatch(source, /request\.headers|searchParams|\.host\b|env\./, 'el destino no depende de la petición');
    assert.doesNotMatch(source, /fetch\(|import\s/);
  });

  test('9. /api/ganaderia/* no pasa por aquí: su relay es una Function distinta y no cambia', () => {
    assert.ok(fs.existsSync(path.join(FUNCTIONS_DIR, 'api', 'ganaderia', '[[path]].js')));
    assert.ok(fs.existsSync(path.join(FUNCTIONS_DIR, 'qr', '[codigo].js')));
    // Ninguna Function de CatastroX nueva ni modificada por este cambio.
    assert.equal(fs.existsSync(path.join(FUNCTIONS_DIR, 'catastrox')), false);
  });
});
