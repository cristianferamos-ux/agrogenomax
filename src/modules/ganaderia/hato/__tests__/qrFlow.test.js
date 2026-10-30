// SPRINT-3D11.3 (R1): flujo de chapetas QR del frontend de la organización
// -- lógica pura (lectura de escaneo/digitación, resultado de la resolución,
// destino post-login) + invariantes de arquitectura de las páginas QR.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isQrToken,
  normalizeCodigoChapeta,
  parseQrContent,
  qrResolutionOutcome,
  qrResolverPath,
} from '../qrToken.js';
import { loginReturnState, safeLoginReturnPath } from '../../auth/loginReturnPath.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HATO_DIR = path.resolve(__dirname, '..');
const GANADERIA_DIR = path.resolve(HATO_DIR, '..');
const REPO_ROOT = path.resolve(GANADERIA_DIR, '..', '..', '..');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const code = (name) => stripComments(read(path.join(HATO_DIR, name)));
const TOKEN = 'aB3_-xYz09QwErTyUiOpAsDfGhJkLzXc';
const CODIGO = 'AGX-7KM4-P2XZ-R';

// ---------------------------------------------------------------------
// Escaneo y digitación
// ---------------------------------------------------------------------

test('escaneo: URL /qr/<token> o token suelto -> token, conservando mayúsculas/minúsculas', () => {
  assert.equal(isQrToken(TOKEN), true);
  for (const raw of [
    TOKEN, `  ${TOKEN}\n`, `https://agrogenomax.com/qr/${TOKEN}`, `https://staging.example.test/qr/${TOKEN}/`,
    `https://agrogenomax.com/qr/${TOKEN}?utm=x#y`, `/qr/${TOKEN}`, `/ganaderia/qr/${TOKEN}`,
  ]) {
    assert.deepEqual(parseQrContent(raw), { kind: 'token', token: TOKEN }, raw);
  }
});

test('digitación: código visible tolerante (minúsculas, espacios, sin guiones) -> código canónico', () => {
  for (const raw of [CODIGO, 'agx-7km4-p2xz-r', ' agx 7km4 p2xz r ', '7KM4P2XZR', '7km4-p2xz-r', 'AGX7KM4P2XZR']) {
    assert.deepEqual(parseQrContent(raw), { kind: 'codigo', codigo: CODIGO }, raw);
  }
  assert.equal(normalizeCodigoChapeta('AGXB2345B'), 'AGX-AGXB-2345-B');
  for (const typo of ['AGX-7KM4-P2XZ-S', 'AGX-7KN4-P2XZ-R', 'AGX-7K4M-P2XZ-R', 'AGX-7KM4-P2XZ']) {
    assert.deepEqual(parseQrContent(typo), { kind: 'invalid' }, `error de digitación detectado sin red: ${typo}`);
  }
});

test('legacy: AGX-000003 (digitado o en URL legacy /qr/AGX-000003) -> código, se resuelve igual que uno nuevo', () => {
  for (const raw of ['AGX-000003', 'agx-000003', '000003', 'https://agrogenomax.com/qr/AGX-000003', '/qr/AGX-000003']) {
    assert.deepEqual(parseQrContent(raw), { kind: 'codigo', codigo: 'AGX-000003' }, raw);
  }
});

test('contenido ajeno -> invalid (sin navegar a la URL leída)', () => {
  for (const raw of [
    '', null, undefined, 'hola', TOKEN.slice(1), `${TOKEN}x`, 'AGX-0000-0000', 'AGX-OIOI-OIOI', 'AGX-12345',
    `javascript:alert(1)//${TOKEN}`, `https://agrogenomax.com/otra/${TOKEN}`, `https://agrogenomax.com/qr/${TOKEN}/extra`,
    `ftp://agrogenomax.com/qr/${TOKEN}`,
  ]) {
    assert.deepEqual(parseQrContent(raw), { kind: 'invalid' }, String(raw));
  }
});

test('escaneo y digitación llevan al MISMO resolver privado', () => {
  assert.equal(qrResolverPath({ kind: 'token', token: TOKEN }), `/ganaderia/qr/${TOKEN}`);
  assert.equal(qrResolverPath({ kind: 'codigo', codigo: CODIGO }), `/ganaderia/qr/${CODIGO}`);
});

// ---------------------------------------------------------------------
// Resolución -> pantalla
// ---------------------------------------------------------------------

test('chapeta asociada (QR o código) -> ficha del animal', () => {
  assert.deepEqual(
    qrResolutionOutcome({ ok: true, status: 200, data: { resultado: 'ANIMAL', animalId: '42', chapeta: { codigoVisible: CODIGO } } }),
    { status: 'found', to: '/ganaderia/animales/42' },
  );
});

test('chapeta disponible (QR o código) -> registro de animal con esa chapeta', () => {
  assert.deepEqual(
    qrResolutionOutcome({ ok: true, status: 200, data: { resultado: 'DISPONIBLE', chapeta: { codigoVisible: CODIGO } } }),
    { status: 'found', to: `/ganaderia/animales/nuevo?chapeta=${CODIGO}` },
  );
});

test('inexistente / de otra organización / stock central (404) -> un único estado controlado', () => {
  assert.deepEqual(qrResolutionOutcome({ ok: false, status: 404, data: { error: 'QR_NOT_FOUND' } }), { status: 'not_found' });
});

test('revocada / dañada / reemplazada (410) -> estado controlado con su estado', () => {
  assert.deepEqual(
    qrResolutionOutcome({ ok: false, status: 410, data: { error: 'QR_NO_OPERATIVO', estado: 'REEMPLAZADO' } }),
    { status: 'no_operativa', estado: 'Reemplazada', animalId: null },
  );
});

test('respuestas inesperadas -> error, nunca navegación', () => {
  for (const response of [
    { ok: false, status: 500, data: null },
    { ok: false, status: 401, data: { error: 'SESSION_REQUIRED' } },
    { ok: true, status: 200, data: { resultado: 'ANIMAL', animalId: '../admin' } },
    { ok: true, status: 200, data: { resultado: 'DISPONIBLE', chapeta: { codigoVisible: '<script>' } } },
    {},
  ]) {
    assert.deepEqual(qrResolutionOutcome(response), { status: 'error' });
  }
});

// ---------------------------------------------------------------------
// Sin sesión -> login -> volver al QR
// ---------------------------------------------------------------------

test('destino post-login: solo resolver QR (token o código) y escáner; nada de URLs absolutas', () => {
  for (const ok of [`/ganaderia/qr/${TOKEN}`, `/ganaderia/qr/${CODIGO}`, '/ganaderia/qr/AGX-000003', '/ganaderia/escanear-qr']) {
    assert.equal(safeLoginReturnPath(ok), ok);
  }
  for (const value of [
    undefined, null, 42, '', '/ganaderia/dashboard', '/ganaderia/animales/1', `//evil.example/ganaderia/qr/${TOKEN}`,
    `https://evil.example/ganaderia/qr/${TOKEN}`, `/ganaderia/qr/${TOKEN}/x`, '/ganaderia/qr/corto', `/ganaderia/qr/${CODIGO}?x=1`,
    '/ganaderia/admin/qr',
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
  assert.match(app, /<Route path="qr\/:valor" element=\{<HatoQrResolverPage \/>\} \/>/);
});

// ---------------------------------------------------------------------
// Arquitectura de las páginas QR de la organización
// ---------------------------------------------------------------------

test('resolver: valida el formato antes de llamar a la API, usa token o código y reemplaza el historial', () => {
  const resolver = code('HatoQrResolverPage.jsx');
  assert.match(resolver, /const parsed = parseQrContent\(valor\);/);
  assert.match(resolver, /if \(!valido\) return;/);
  assert.match(resolver, /kind === 'token' \? await resolveQrToken\(clave\) : await resolveQrCodigo\(clave\)/);
  assert.match(resolver, /if \(outcome\.status === 'found'\) return <Navigate to=\{outcome\.to\} replace \/>;/);
});

test('escáner móvil: html5-qrcode sin normalizador legacy ni MAYÚSCULAS; entrada manual "Código de chapeta" + "Buscar" al mismo resolver', () => {
  const scanner = code('HatoQrScanner.jsx');
  assert.match(scanner, /import \{ Html5Qrcode \} from 'html5-qrcode';/);
  assert.match(scanner, /\{ facingMode: 'environment' \}/);
  for (const forbidden of [/toUpperCase/, /normalizeQrCode/, /from '\.\.\/qr\//, /hatoApi/, /\/api\//, /fetch\(/]) {
    assert.doesNotMatch(scanner, forbidden);
  }
  const page = code('HatoEscanearQrPage.jsx');
  assert.match(page, /label="Código de chapeta"/);
  assert.match(page, />Buscar</);
  assert.match(page, /onDecoded=\{\(text\) => handleContent\(text, INVALID_SCAN_MESSAGE\)\}/);
  assert.match(page, /handleContent\(codigo, INVALID_CODE_MESSAGE\)/);
  assert.match(page, /navigate\(qrResolverPath\(parsed\)\)/);
  for (const forbidden of [/hatoApi/, /\/api\//, /fetch\(/, /from '\.\.\/qr\//]) {
    assert.doesNotMatch(page, forbidden);
  }
});

test('registro con chapeta: endpoint atómico registrar-animal y apertura de la ficha al terminar', () => {
  const registro = code('HatoRegistroPage.jsx');
  assert.match(registro, /const chapeta = chapetaParam === null \? null : normalizeCodigoChapeta\(chapetaParam\);/);
  assert.match(registro, /\? await registrarAnimalConChapeta\(chapeta, body\)\s*: await createAnimal\(body\);/);
  assert.match(registro, /navigate\(`\/ganaderia\/animales\/\$\{data\.animal\.animalId\}`, \{ replace: true \}\);/);
});

test('ficha: la organización asocia, reemplaza o da de baja chapetas existentes -- nunca las genera', () => {
  const panel = code('HatoQrPanel.jsx');
  assert.match(panel, /asociarQr\(animalId, codigoNormalizado\)/);
  assert.match(panel, /reemplazarQr\(animalId, \{ codigoNuevo: codigoNormalizado, motivo: texto \}\)/);
  assert.match(panel, /bajaQr\(animalId, \{ causa, motivo: texto \}\)/);
  assert.doesNotMatch(panel, /asignarQr|Generar QR|token|localStorage|sessionStorage|setTimeout/);
});

test('hatoApi: chapetas solo bajo /api/ganaderia/qr y /animales/:id/qr; nunca /api/qr legacy ni admin', () => {
  const api = code('hatoApi.js');
  for (const fragment of ['/qr/token/', '/qr/codigo/', '/qr/chapetas', '/registrar-animal', '/qr/asociar', '/qr/reemplazar', '/qr/baja']) {
    assert.ok(api.includes(fragment), fragment);
  }
  assert.doesNotMatch(api, /'\/api\/qr|`\/api\/qr|\/admin\//);
});

test('dependencia QR: qrcode@1.5.4 exacta, usada solo por el servidor (archivo del proveedor)', () => {
  const pkg = JSON.parse(read(path.join(REPO_ROOT, 'package.json')));
  assert.equal(pkg.dependencies.qrcode, '1.5.4');
  for (const name of fs.readdirSync(HATO_DIR).filter((f) => /\.(js|jsx)$/.test(f))) {
    assert.doesNotMatch(read(path.join(HATO_DIR, name)), /from 'qrcode'/, name);
  }
});
