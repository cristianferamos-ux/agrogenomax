// SPRINT-3D11.3 (R1): flujo QR del frontend -- lógica pura (lectura del
// contenido escaneado, resultado de la resolución, destino post-login) +
// invariantes de arquitectura de las páginas QR de hato/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isQrToken, parseQrContent, qrPublicUrl, qrResolutionOutcome, qrResolverPath } from '../qrToken.js';
import { loginReturnState, safeLoginReturnPath } from '../../auth/loginReturnPath.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HATO_DIR = path.resolve(__dirname, '..');
const GANADERIA_DIR = path.resolve(HATO_DIR, '..');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const code = (name) => stripComments(read(path.join(HATO_DIR, name)));
const TOKEN = 'aB3_-xYz09QwErTyUiOpAsDfGhJkLzXc';

// ---------------------------------------------------------------------
// Lectura del contenido escaneado
// ---------------------------------------------------------------------

test('parseQrContent: token suelto o URL /qr/<token> -> token, conservando mayúsculas/minúsculas', () => {
  assert.equal(isQrToken(TOKEN), true);
  for (const raw of [
    TOKEN,
    `  ${TOKEN}\n`,
    `https://agrogenomax.com/qr/${TOKEN}`,
    `https://staging.example.test/qr/${TOKEN}/`,
    `https://agrogenomax.com/qr/${TOKEN}?utm=x#y`,
    `/qr/${TOKEN}`,
    `/ganaderia/qr/${TOKEN}`,
  ]) {
    assert.deepEqual(parseQrContent(raw), { kind: 'token', token: TOKEN }, raw);
  }
});

test('parseQrContent: códigos legacy AGX-000001 se reconocen pero nunca como token', () => {
  for (const raw of ['AGX-000003', 'agx-000001', 'https://agrogenomax.com/qr/AGX-000003', '/qr/AGX-000005']) {
    assert.deepEqual(parseQrContent(raw), { kind: 'legacy' }, raw);
  }
});

test('parseQrContent: contenido ajeno -> invalid (sin navegar a la URL leída)', () => {
  for (const raw of [
    '', null, undefined, 'hola', TOKEN.slice(1), `${TOKEN}x`,
    `javascript:alert(1)//${TOKEN}`,
    `https://agrogenomax.com/otra/${TOKEN}`,
    `https://agrogenomax.com/qr/${TOKEN}/extra`,
    `ftp://agrogenomax.com/qr/${TOKEN}`,
  ]) {
    assert.deepEqual(parseQrContent(raw), { kind: 'invalid' }, String(raw));
  }
});

test('rutas QR: resolver privado y enlace impreso /qr/<token>', () => {
  assert.equal(qrResolverPath(TOKEN), `/ganaderia/qr/${TOKEN}`);
  assert.equal(qrPublicUrl(TOKEN, 'https://agrogenomax.com'), `https://agrogenomax.com/qr/${TOKEN}`);
});

// ---------------------------------------------------------------------
// Resolución -> estado de pantalla
// ---------------------------------------------------------------------

test('resolución encontrada -> ficha correcta del animal', () => {
  assert.deepEqual(
    qrResolutionOutcome({ ok: true, status: 200, data: { ok: true, animalId: '42', animal: { animalId: '42' } } }),
    { status: 'found', to: '/ganaderia/animales/42' },
  );
});

test('token inexistente, revocado, reemplazado o de otra organización (404) -> un único estado controlado', () => {
  assert.deepEqual(qrResolutionOutcome({ ok: false, status: 404, data: { error: 'QR_NOT_FOUND' } }), { status: 'not_found' });
});

test('errores del servidor o respuestas inesperadas -> estado de error, nunca navegación', () => {
  for (const response of [
    { ok: false, status: 500, data: null },
    { ok: false, status: 401, data: { error: 'SESSION_REQUIRED' } },
    { ok: true, status: 200, data: { animalId: '../admin' } },
    { ok: true, status: 200, data: { animalId: 42 } },
    {},
  ]) {
    assert.deepEqual(qrResolutionOutcome(response), { status: 'error' });
  }
});

// ---------------------------------------------------------------------
// Sin sesión -> login -> volver al QR
// ---------------------------------------------------------------------

test('destino post-login: solo el resolver QR y el escáner; nada de URLs absolutas ni otras rutas', () => {
  assert.equal(safeLoginReturnPath(`/ganaderia/qr/${TOKEN}`), `/ganaderia/qr/${TOKEN}`);
  assert.equal(safeLoginReturnPath('/ganaderia/escanear-qr'), '/ganaderia/escanear-qr');
  for (const value of [
    undefined, null, 42, '', '/ganaderia/dashboard', '/ganaderia/animales/1', `//evil.example/ganaderia/qr/${TOKEN}`,
    `https://evil.example/ganaderia/qr/${TOKEN}`, `/ganaderia/qr/${TOKEN}/x`, '/ganaderia/qr/corto', `/ganaderia/qr/${TOKEN}?x=1`,
  ]) {
    assert.equal(safeLoginReturnPath(value), null, String(value));
  }
  assert.deepEqual(loginReturnState(`/ganaderia/qr/${TOKEN}`), { from: `/ganaderia/qr/${TOKEN}` });
  assert.equal(loginReturnState('/ganaderia/predios'), undefined);
});

test('sin sesión: el guard envía a /ganaderia/login antes de renderizar el resolver', () => {
  const guard = stripComments(read(path.join(GANADERIA_DIR, 'auth', 'RequireGanaderiaAuth.jsx')));
  assert.match(guard, /if \(status === 'anonymous'\) \{\s*return <Navigate to="\/ganaderia\/login" replace state=\{loginReturnState\(location\.pathname\)\} \/>;/);
  const app = stripComments(read(path.join(GANADERIA_DIR, 'GanaderiaApp.jsx')));
  assert.match(app, /<Route path="qr\/:token" element=\{<HatoQrResolverPage \/>\} \/>/);
});

// ---------------------------------------------------------------------
// Arquitectura de las páginas QR
// ---------------------------------------------------------------------

test('HatoQrResolverPage: valida el formato antes de llamar a la API y reemplaza el historial al abrir la ficha', () => {
  const resolver = code('HatoQrResolverPage.jsx');
  assert.match(resolver, /const tokenValido = isQrToken\(token\);/);
  assert.match(resolver, /if \(!tokenValido\) return;\s*setOutcome\(\{ status: 'loading' \}\);/);
  assert.match(resolver, /qrResolutionOutcome\(await resolveQr\(token\)\)/);
  assert.match(resolver, /if \(outcome\.status === 'found'\) return <Navigate to=\{outcome\.to\} replace \/>;/);
  assert.match(resolver, /no corresponde a ningún animal activo de tu cuenta/);
});

test('escáner móvil: html5-qrcode sin normalizador legacy ni MAYÚSCULAS; no consulta ninguna API', () => {
  const scanner = code('HatoQrScanner.jsx');
  assert.match(scanner, /import \{ Html5Qrcode \} from 'html5-qrcode';/);
  assert.match(scanner, /\{ facingMode: 'environment' \}/);
  assert.match(scanner, /onDecoded\(decodedText\)/);
  for (const forbidden of [/toUpperCase/, /normalizeQrCode/, /from '\.\.\/qr\//, /hatoApi/, /\/api\//, /fetch\(/]) {
    assert.doesNotMatch(scanner, forbidden);
  }
  const page = code('HatoEscanearQrPage.jsx');
  assert.match(page, /const parsed = parseQrContent\(rawValue\);/);
  assert.match(page, /navigate\(qrResolverPath\(parsed\.token\)\)/);
  for (const forbidden of [/hatoApi/, /\/api\//, /fetch\(/, /from '\.\.\/qr\//]) {
    assert.doesNotMatch(page, forbidden);
  }
});

test('hatoApi: QR solo bajo /api/ganaderia (resolver y acciones por animal)', () => {
  const api = code('hatoApi.js');
  assert.match(api, /return getJsonWithSession\(`\$\{BASE\}\/qr\/\$\{encodeURIComponent\(token\)\}`\);/);
  for (const action of ['/qr`, {})', '/qr/revocar`', '/qr/reemplazar`']) {
    assert.ok(api.includes(action), action);
  }
  assert.doesNotMatch(api, /'\/api\/qr|`\/api\/qr/);
});

test('HatoQrPanel: reemplazo con clientOperationId fijo por formulario y fail-closed; sin reintento automático', () => {
  const panel = code('HatoQrPanel.jsx');
  assert.match(panel, /setOperationId\(nuevoModo === 'reemplazar' \? newClientOperationId\(\) : null\);/);
  assert.match(panel, /if \(!operationId\) \{/);
  assert.match(panel, /reemplazarQr\(animalId, \{ motivo: texto, clientOperationId: operationId \}\)/);
  assert.doesNotMatch(panel, /localStorage|sessionStorage|setTimeout|setInterval/);
});
