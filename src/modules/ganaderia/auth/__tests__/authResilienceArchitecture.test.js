// SPRINT-3D10.5 F3a: gates de arquitectura de la resiliencia auth/sesión.
// Garantiza que las 9 copias previas de "fetchCsrfToken + fetch" ya no
// existan y que todo POST autenticado de potreros/predios pase por el
// cliente compartido auth/ganaderiaAuthedRequest.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GANADERIA_DIR = path.resolve(__dirname, '..', '..');
const AUTH_DIR = path.join(GANADERIA_DIR, 'auth');
const POTREROS_DIR = path.join(GANADERIA_DIR, 'potreros');
const PREDIOS_DIR = path.join(GANADERIA_DIR, 'predios');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(js|jsx)$/.test(entry.name))
    .map((entry) => path.join(dir, entry.name));
}

const API_WRAPPERS = {
  'ganaderiaAgroClimaApi.js': 'postWithCsrf',
  'ganaderiaCapacidadPastoreoApi.js': 'postJsonWithCsrf',
  'ganaderiaCicloPastoreoApi.js': 'postJsonWithCsrf',
  'ganaderiaDescansoReentradaApi.js': 'postJsonWithCsrf',
  'ganaderiaFichaProductivaApi.js': 'postJsonWithCsrf',
  'ganaderiaPotrerosApi.js': 'postJsonWithCsrf',
  'ganaderiaRecomendacionPastoreoApi.js': 'postJsonWithCsrf',
};

const helperSource = read(path.join(AUTH_DIR, 'ganaderiaAuthedRequest.js'));
const signalSource = read(path.join(AUTH_DIR, 'ganaderiaAuthNoticeSignal.js'));
const contextSource = read(path.join(AUTH_DIR, 'GanaderiaAuthContext.jsx'));

test('no existe ninguna llamada a fetchCsrfToken en potreros/ ni predios/', () => {
  for (const file of [...sourceFiles(POTREROS_DIR), ...sourceFiles(PREDIOS_DIR)]) {
    const code = stripComments(read(file));
    assert.doesNotMatch(code, /fetchCsrfToken/, path.basename(file));
    assert.doesNotMatch(code, /X-CSRF-Token/, path.basename(file));
  }
});

for (const [file, postHelper] of Object.entries(API_WRAPPERS)) {
  test(`${file}: wrappers locales delegan en el cliente compartido, sin fetch propio`, () => {
    const code = stripComments(read(path.join(POTREROS_DIR, file)));
    assert.match(code, /from '\.\.\/auth\/ganaderiaAuthedRequest\.js';/);
    assert.match(code, /function getJson\(path\) \{\s*return getJsonWithSession\(path\);\s*\}/);
    assert.match(code, new RegExp(`function postJson\\(path(, body)?\\) \\{\\s*return ${postHelper}\\(path(, body)?\\);\\s*\\}`));
    assert.doesNotMatch(code, /\bfetch\(/);
    assert.doesNotMatch(code, /async function parseJson/);
    assert.doesNotMatch(code, /GanaderiaAuthContext/);
  });
}

test('ganaderiaAgroClimaApi.js: refresh conserva POST sin body ni Content-Type', () => {
  const code = stripComments(read(path.join(POTREROS_DIR, 'ganaderiaAgroClimaApi.js')));
  assert.match(code, /function postJson\(path\) \{\s*return postWithCsrf\(path\);\s*\}/);
});

test('ganaderiaPotrerosApi.js: previewPotreroFile delega en postWithCsrf con body raw', () => {
  const code = stripComments(read(path.join(POTREROS_DIR, 'ganaderiaPotrerosApi.js')));
  const fn = code.match(/export async function previewPotreroFile\(predioId, file\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'previewPotreroFile no encontrado');
  assert.match(fn[0], /return postWithCsrf\(`\/api\/ganaderia\/predios\/\$\{predioId\}\/potreros\/preview-file`/);
  assert.match(fn[0], /body: file/);
  assert.match(fn[0], /'Content-Type': 'application\/octet-stream'/);
  assert.doesNotMatch(fn[0], /X-CSRF-Token/);
});

test('PrediosPage.jsx: postGanaderiaPredios delega en postJsonWithCsrf', () => {
  const code = stripComments(read(path.join(PREDIOS_DIR, 'PrediosPage.jsx')));
  assert.match(code, /function postGanaderiaPredios\(path, body\) \{\s*return postJsonWithCsrf\(path, body\);\s*\}/);
});

test('ningún componente .jsx de potreros/ ni predios/ importa el helper o la señal directamente', () => {
  for (const file of [...sourceFiles(POTREROS_DIR), ...sourceFiles(PREDIOS_DIR)].filter((f) => f.endsWith('.jsx'))) {
    if (path.basename(file) === 'PrediosPage.jsx') continue; // su wrapper POST local es el punto único aprobado
    const code = stripComments(read(file));
    assert.doesNotMatch(code, /ganaderiaAuthedRequest/, path.basename(file));
    assert.doesNotMatch(code, /ganaderiaAuthNoticeSignal/, path.basename(file));
  }
});

test('helper y señal son JS puro: sin React, sin window/document/storage', () => {
  for (const [name, source] of [['helper', helperSource], ['signal', signalSource]]) {
    const code = stripComments(source);
    assert.doesNotMatch(code, /from 'react'/, name);
    assert.doesNotMatch(code, /\bwindow\b/, name);
    assert.doesNotMatch(code, /\bdocument\b/, name);
    assert.doesNotMatch(code, /localStorage|sessionStorage/, name);
  }
});

test('helper nunca reintenta: sin bucles ni setTimeout alrededor de fetch', () => {
  const code = stripComments(helperSource);
  assert.doesNotMatch(code, /\bwhile\s*\(/);
  assert.doesNotMatch(code, /setTimeout|setInterval/);
  assert.doesNotMatch(code, /retry/i);
  assert.equal((code.match(/\bfetch\(/g) || []).length, 4); // /csrf, POST, logout (F3b), GET
});

test('fetchCsrfToken tiene una única implementación y el Context la re-exporta', () => {
  assert.match(contextSource, /export \{ fetchCsrfToken \} from '\.\/ganaderiaAuthedRequest\.js';/);
  assert.doesNotMatch(stripComments(contextSource), /async function fetchCsrfToken/);
  assert.equal((helperSource.match(/export async function fetchCsrfToken/g) || []).length, 1);
});

test('señal sin latch global: solo el Set de suscripciones como estado de módulo', () => {
  const code = stripComments(signalSource);
  assert.match(code, /const subscriptions = new Set\(\);/);
  assert.doesNotMatch(code, /^let /m);
});
