// FASE 3C: contrato unificado de errores del frontend de Ganadería
// (api/errorModel.js) + correlationId en el cliente autenticado +
// regresiones en pantallas representativas + búsqueda de fugas.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MENSAJE_ERROR_SERVIDOR,
  MENSAJE_SIN_CONEXION,
  MENSAJE_SIN_PERMISOS,
  TIPOS_FALLO,
  clasificarFallo,
  codigoSeguimiento,
  conCodigoSeguimiento,
  correlationIdDeRespuesta,
  errorConMensajeSeguro,
  mensajeDeExcepcion,
  mensajeError,
} from '../errorModel.js';
import { getFileWithSession, getJsonWithSession, MENSAJE_ROLE_FORBIDDEN, postJsonWithCsrf } from '../../auth/ganaderiaAuthedRequest.js';
import { resultadoRegistro } from '../../hato/pesajesModel.js';
import { resultadoCierre, MENSAJE_CIERRE_INCIERTO } from '../../hato/cierreModel.js';
import { mensajeErrorReporte } from '../../hato/reporteProductivoModel.js';
import { qrResolutionOutcome, codigoSeguimiento as codigoSeguimientoQr } from '../../hato/qrToken.js';
import { mensajeErrorAdminQr } from '../../admin/adminQrModel.js';
import { classifyResult } from '../../offline/syncEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GANADERIA_DIR = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(GANADERIA_DIR, rel), 'utf8').replace(/\r\n/g, '\n');

const UUID = '4612e456-7890-4abc-8def-740987654321';
const CORTO = '4612e456';
const TECNICO = 'error: duplicate key value violates unique constraint "animales_pkey" at Pool.query (/app/server/db.js:42) postgres://agx:pw@10.0.0.5/db';

const res500 = (data = { error: 'Error interno del servidor', code: 'INTERNAL_ERROR', correlationId: UUID }) => ({ ok: false, status: 500, data });

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

test('500 con correlationId válido -> "Código de seguimiento" con 8 caracteres en minúsculas', () => {
  const mensaje = mensajeError(res500());
  assert.equal(mensaje, `Ocurrió un error. Código de seguimiento: ${CORTO}`);
  assert.ok(!mensaje.includes(UUID), 'nunca el UUID completo');
  assert.equal(codigoSeguimiento(UUID.toUpperCase()), CORTO);
});

test('500 sin correlationId -> mensaje genérico; correlationId inválido -> ignorado (no se inventa)', () => {
  assert.equal(mensajeError(res500({ error: 'Error interno del servidor' })), MENSAJE_ERROR_SERVIDOR);
  for (const malo of ['123', 'not-a-uuid', `${UUID}x`, '<script>alert(1)</script>', 42, null]) {
    assert.equal(mensajeError(res500({ correlationId: malo })), MENSAJE_ERROR_SERVIDOR, String(malo));
    assert.equal(codigoSeguimiento(malo), null);
  }
});

test('5xx con mensaje técnico (SQL, stack, rutas, connection string) -> NUNCA se muestra', () => {
  for (const data of [{ error: TECNICO }, { error: 'x', message: TECNICO, stack: TECNICO }, { error: TECNICO, correlationId: UUID }]) {
    for (const status of [500, 502, 503, 504]) {
      const mensaje = mensajeError({ ok: false, status, data }, () => TECNICO);
      assert.ok(!mensaje.includes('duplicate') && !mensaje.includes('postgres://') && !mensaje.includes('/app/'), `${status}`);
    }
  }
});

test('400 funcional: conserva el mensaje del módulo (por código, función o mapa) y el fallback', () => {
  const r = { ok: false, status: 400, data: { error: 'INVALID_PESO' } };
  assert.equal(mensajeError(r, (c) => (c === 'INVALID_PESO' ? 'Revisa el peso.' : null)), 'Revisa el peso.');
  assert.equal(mensajeError(r, { INVALID_PESO: 'Revisa el peso.' }), 'Revisa el peso.');
  assert.equal(mensajeError(r, { OTRO: 'x' }, { fallback: 'Revisa los datos.' }), 'Revisa los datos.');
  assert.equal(mensajeError(r, { toString: 'no' }, { fallback: 'F' }), 'F', 'solo claves propias del mapa');
});

test('403 ROLE_FORBIDDEN -> mensaje de permisos (mismo texto que MENSAJE_ROLE_FORBIDDEN); otros 403 -> módulo', () => {
  assert.equal(MENSAJE_ROLE_FORBIDDEN, MENSAJE_SIN_PERMISOS);
  assert.equal(mensajeError({ ok: false, status: 403, data: { error: 'ROLE_FORBIDDEN' } }), MENSAJE_SIN_PERMISOS);
  assert.equal(mensajeError({ ok: false, status: 403, data: { error: 'ROLE_FORBIDDEN' }, failure: 'ROLE_FORBIDDEN' }, () => 'x'), MENSAJE_SIN_PERMISOS);
  assert.equal(mensajeError({ ok: false, status: 403, data: { error: 'CSRF_INVALID' } }, { CSRF_INVALID: 'Recarga la página.' }), 'Recarga la página.');
});

test('404 y 409: semántica del módulo intacta (tenant-safe, conflicto específico)', () => {
  assert.equal(mensajeError({ ok: false, status: 404, data: { error: 'ANIMAL_NOT_FOUND' } }, { ANIMAL_NOT_FOUND: 'Este animal no está disponible.' }), 'Este animal no está disponible.');
  assert.equal(mensajeError({ ok: false, status: 409, data: { error: 'ANIMAL_NUMERO_VISUAL_DUPLICADO' } }, { ANIMAL_NUMERO_VISUAL_DUPLICADO: 'Ya existe un animal con ese número.' }), 'Ya existe un animal con ese número.');
  assert.equal(clasificarFallo({ status: 409, data: { error: 'X' } }).tipo, TIPOS_FALLO.CLIENTE);
});

test('error de red (status 0, NETWORK_ERROR, REQUEST_NOT_SENT, TypeError) -> conectividad, nunca "5xx"', () => {
  for (const f of [
    { ok: false, status: 0, data: { error: 'NETWORK_ERROR' }, failure: 'NETWORK_ERROR' },
    { ok: false, status: 0, data: { error: 'CSRF_UNAVAILABLE' }, failure: 'REQUEST_NOT_SENT' },
    null,
    new TypeError('Failed to fetch'),
  ]) {
    assert.equal(mensajeError(f), MENSAJE_SIN_CONEXION);
  }
  assert.equal(mensajeDeExcepcion(new TypeError('NetworkError when attempting to fetch resource.')), MENSAJE_SIN_CONEXION);
});

test('AbortError / cancelación -> sin mensaje', () => {
  const abort = new DOMException('The operation was aborted.', 'AbortError');
  assert.equal(mensajeError(abort), null);
  assert.equal(mensajeDeExcepcion(abort), null);
  assert.equal(clasificarFallo(abort).tipo, TIPOS_FALLO.CANCELADO);
});

test('body malformado / ausente / HTML de proxy -> sin crash, mensaje seguro', () => {
  assert.equal(mensajeError({ ok: false, status: 502, data: null }), MENSAJE_ERROR_SERVIDOR);
  assert.equal(mensajeError({ ok: false, status: 500, data: '<html>Bad gateway</html>' }), MENSAJE_ERROR_SERVIDOR);
  assert.equal(mensajeError({ ok: false, status: 400, data: 'texto' }, null, { fallback: 'F' }), 'F');
  assert.equal(mensajeError({}), MENSAJE_SIN_CONEXION);
  assert.equal(correlationIdDeRespuesta(500, null, null), null);
  assert.equal(correlationIdDeRespuesta(500, null, { get() { throw new Error('x'); } }), null);
});

test('correlationId: body primero, luego X-Request-ID; solo 5xx; nunca de un 4xx', () => {
  const otro = '1111e456-7890-4abc-8def-740987654321';
  assert.equal(correlationIdDeRespuesta(500, { correlationId: UUID }, new Headers({ 'X-Request-ID': otro })), UUID);
  assert.equal(correlationIdDeRespuesta(503, { error: 'x' }, new Headers({ 'X-Request-ID': otro })), otro);
  assert.equal(correlationIdDeRespuesta(503, {}, new Headers({ 'X-Request-ID': 'no-uuid' })), null);
  assert.equal(correlationIdDeRespuesta(409, { correlationId: UUID }, new Headers({ 'X-Request-ID': otro })), null);
});

test('excepciones: solo mensajes seguros o de dominio; nunca message técnico', () => {
  assert.equal(mensajeDeExcepcion(errorConMensajeSeguro('Lote no encontrado.')), 'Lote no encontrado.');
  const dominio = Object.assign(new Error('La chapeta ya no está disponible.'), { code: 'QR_NO_DISPONIBLE' });
  assert.equal(mensajeDeExcepcion(dominio), 'La chapeta ya no está disponible.');
  assert.equal(mensajeDeExcepcion(new Error(TECNICO), 'Genérico.'), 'Genérico.');
  assert.equal(mensajeDeExcepcion(new DOMException('QuotaExceededError: IndexedDB', 'QuotaExceededError'), 'Genérico.'), 'Genérico.');
  assert.equal(mensajeDeExcepcion(new Error('STORE_DESCONOCIDO:animales'), 'Genérico.'), 'Genérico.');
  const csrf = Object.assign(new Error('CSRF_FETCH_FAILED_500'), { status: 500, code: 'SESSION_REQUIRED' });
  assert.equal(mensajeDeExcepcion(csrf), MENSAJE_ERROR_SERVIDOR, 'error HTTP: nunca su message técnico');
  assert.equal(mensajeDeExcepcion(null, 'F'), 'F');
});

test('conCodigoSeguimiento: agrega el código solo si el correlationId es válido', () => {
  assert.equal(conCodigoSeguimiento('No pudimos confirmar.', UUID), `No pudimos confirmar. Código de seguimiento: ${CORTO}`);
  assert.equal(conCodigoSeguimiento('No pudimos confirmar.', 'x'), 'No pudimos confirmar.');
});

// ---------------------------------------------------------------------------
// Cliente autenticado: correlationId aditivo en el resultado
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function installFetch(...queue) {
  globalThis.fetch = async () => {
    const next = queue.shift();
    if (typeof next === 'function') return next();
    return next;
  };
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

test('postJsonWithCsrf: 500 -> correlationId del body; data intacta (contrato existente)', async () => {
  installFetch(json(200, { csrfToken: 't' }), json(500, { error: 'Error interno del servidor', code: 'INTERNAL_ERROR', correlationId: UUID }));
  const r = await postJsonWithCsrf('/api/ganaderia/x', {});
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
  assert.equal(r.correlationId, UUID);
  assert.deepEqual(r.data, { error: 'Error interno del servidor', code: 'INTERNAL_ERROR', correlationId: UUID });
  assert.equal(mensajeError(r), `Ocurrió un error. Código de seguimiento: ${CORTO}`);
});

test('getJsonWithSession: 502 sin body JSON -> correlationId desde X-Request-ID; inválido -> ausente', async () => {
  installFetch(new Response('<html>502</html>', { status: 502, headers: { 'X-Request-ID': UUID } }));
  const r = await getJsonWithSession('/api/ganaderia/x');
  assert.equal(r.correlationId, UUID);
  installFetch(new Response('x', { status: 503, headers: { 'X-Request-ID': 'falso' } }));
  assert.equal('correlationId' in (await getJsonWithSession('/api/ganaderia/x')), false);
});

test('helpers: 2xx y 4xx nunca llevan correlationId; getFileWithSession 5xx sí', async () => {
  installFetch(json(200, { ok: true }, { 'X-Request-ID': UUID }));
  assert.equal('correlationId' in (await getJsonWithSession('/a')), false);
  installFetch(json(409, { error: 'X' }, { 'X-Request-ID': UUID }));
  assert.equal('correlationId' in (await getJsonWithSession('/a')), false);
  installFetch(json(500, { error: 'Error interno del servidor', correlationId: UUID }));
  assert.equal((await getFileWithSession('/a.pdf')).correlationId, UUID);
});

// ---------------------------------------------------------------------------
// Regresiones en pantallas representativas
// ---------------------------------------------------------------------------

test('pesaje: 5xx sigue siendo INCIERTO (reintento seguro) + código de seguimiento; red sin código', () => {
  const r = resultadoRegistro({ ...res500(), correlationId: UUID });
  assert.equal(r.tipo, 'INCIERTO');
  assert.match(r.mensaje, /^No pudimos confirmar si el pesaje se guardó\. Puedes reintentar: no se duplicará\. Código de seguimiento: 4612e456$/);
  assert.equal(resultadoRegistro({ ok: false, status: 0, data: { error: 'NETWORK_ERROR' } }).mensaje,
    'No pudimos confirmar si el pesaje se guardó. Puedes reintentar: no se duplicará.');
  assert.equal(resultadoRegistro({ ok: false, status: 403, data: { error: 'ROLE_FORBIDDEN' } }).tipo, 'PERMISOS');
});

test('cierre SALIDA/MUERTE: 5xx INCIERTO + código; 409 ya cerrado sin cambios', () => {
  for (const tipo of ['SALIDA', 'MUERTE']) {
    const r = resultadoCierre(tipo, { ...res500(), correlationId: UUID });
    assert.equal(r.tipo, 'INCIERTO');
    assert.equal(r.mensaje, `${MENSAJE_CIERRE_INCIERTO} Código de seguimiento: ${CORTO}`);
    assert.equal(resultadoCierre(tipo, { ok: false, status: 409, data: { error: 'ANIMAL_YA_SALIDO' } }).tipo, 'YA_CERRADO');
  }
});

test('reporte productivo: 5xx con código; 404 tenant-safe sin cambios', () => {
  assert.equal(mensajeErrorReporte({ ok: false, status: 500, data: null, correlationId: UUID }), `Ocurrió un error. Código de seguimiento: ${CORTO}`);
  assert.equal(mensajeErrorReporte({ ok: false, status: 404 }), 'Este animal no está disponible.');
});

test('QR: código de seguimiento desde body o desde X-Request-ID (correlationId del cliente)', () => {
  assert.deepEqual(qrResolutionOutcome({ ok: false, status: 500, data: null, correlationId: UUID }), { status: 'error', seguimiento: CORTO });
  assert.equal(codigoSeguimientoQr({ status: 500, data: { correlationId: UUID } }), CORTO);
  assert.equal(codigoSeguimientoQr({ status: 404, data: { correlationId: UUID }, correlationId: UUID }), null);
  assert.deepEqual(qrResolutionOutcome({ ok: false, status: 404, data: { error: 'QR_NOT_FOUND' } }), { status: 'not_found' });
});

test('admin QR: 5xx con código; 4xx con mensaje funcional y códigos rechazados', () => {
  assert.equal(mensajeErrorAdminQr({ ...res500(), correlationId: UUID }), `Ocurrió un error. Código de seguimiento: ${CORTO}`);
  assert.equal(mensajeErrorAdminQr({ ok: false, status: 409, data: { error: 'CLIENT_OPERATION_ID_REUSED' } }), 'Esta operación ya se usó. Recarga la página.');
});

test('offline sync: sin conexión / 5xx reintentables, 403 ROLE_FORBIDDEN terminal, 409 conflicto', () => {
  assert.equal(classifyResult({ ok: false, status: 0, failure: 'NETWORK_ERROR', data: { error: 'NETWORK_ERROR' } }), 'REINTENTABLE');
  assert.equal(classifyResult({ ...res500(), correlationId: UUID }), 'REINTENTABLE');
  assert.equal(classifyResult({ ok: false, status: 403, data: { error: 'ROLE_FORBIDDEN' } }), 'RECHAZADO');
  assert.equal(classifyResult({ ok: false, status: 409, data: { error: 'ANIMAL_NUMERO_VISUAL_DUPLICADO' } }), 'CONFLICTO');
  const engine = read('offline/syncEngine.js');
  assert.doesNotMatch(engine, /correlationId/, 'el correlationId no se persiste en la copia local');
});

test('pantallas: detalle y lista de animales muestran el mensaje del modelo; 404 tenant-safe intacto', () => {
  const detalle = read('hato/HatoDetallePage.jsx');
  assert.match(detalle, /setState\(status === 404\s*\? \{ status: 'not_found', animal: null \}/);
  assert.match(detalle, /mensajeError\(respuestaApi, null, \{ fallback: MENSAJE_CARGA_ANIMAL \}\)/);
  assert.match(detalle, /\{state\.mensaje \?\? MENSAJE_CARGA_ANIMAL\}/);
  assert.match(detalle, /setError\(mensajeError\(respuestaApi, messageForError\)\)/);
  const lista = read('hato/HatoListaPage.jsx');
  assert.match(lista, /mensajeDeExcepcion\(err, MENSAJE_CARGA_LISTA\)/);
  assert.match(lista, /\{state\.mensaje \?\? MENSAJE_CARGA_LISTA\}/);
});

test('pantallas: predios y potreros pasan por el modelo común (sin ternarios ROLE_FORBIDDEN dispersos)', () => {
  for (const archivo of ['predios/PrediosPage.jsx', 'potreros/PotrerosByPredioPanel.jsx', 'potreros/PotreroAgroClimaPanel.jsx',
    'potreros/PotreroCicloPastoreoPanel.jsx', 'potreros/PotreroResidualRealPanel.jsx', 'potreros/PotreroCapacidadPastoreoPanel.jsx']) {
    const src = read(archivo);
    assert.match(src, /from '\.\.\/api\/errorModel\.js'/, archivo);
    assert.doesNotMatch(src, /data\?\.error === 'ROLE_FORBIDDEN' \?/, archivo);
    assert.doesNotMatch(src, /set\w*Error\(resolve\w*\(data\??\.error\)\)/, archivo);
  }
  assert.match(read('predios/PrediosPage.jsx'), /PREDIO_CON_CICLO_EN_CURSO: 'No se puede archivar: al menos un potrero/);
});

// ---------------------------------------------------------------------------
// Búsqueda de fugas en el código montado (las páginas legacy no montadas
// quedan fuera: ver qr/__tests__/legacyContainmentArchitecture.test.js).
// ---------------------------------------------------------------------------

const LEGACY_NO_MONTADO = new Set([
  'animales/AnimalFichaBasica.jsx', 'animales/AnimalGeneticaTab.jsx', 'animales/AnimalInitialForm.jsx',
  'animales/AnimalPesajesTab.jsx', 'animales/AnimalReproduccionTab.jsx', 'animales/AnimalTratamientosTab.jsx',
  'animales/AnimalVacunacionesTab.jsx', 'pages/AnimalesListPage.jsx', 'potreros/PotrerosPage.jsx', 'qr/QrEntryPage.jsx',
]);

function archivosMontados() {
  const out = [];
  (function walk(dir) {
    for (const nombre of fs.readdirSync(dir)) {
      const p = path.join(dir, nombre);
      if (fs.statSync(p).isDirectory()) { if (nombre !== '__tests__') walk(p); continue; }
      if (!/\.(js|jsx)$/.test(nombre)) continue;
      const rel = path.relative(GANADERIA_DIR, p).replace(/\\/g, '/');
      if (!LEGACY_NO_MONTADO.has(rel)) out.push(rel);
    }
  })(GANADERIA_DIR);
  return out;
}

test('fugas: ninguna pantalla montada muestra err.message / error.message / stack crudos', () => {
  for (const rel of archivosMontados()) {
    const src = read(rel);
    assert.doesNotMatch(src, /set\w*\(\s*(err|error|e)\??\.message/, `${rel}: message crudo en estado de UI`);
    assert.doesNotMatch(src, /\.stack\b/, `${rel}: stack`);
    assert.doesNotMatch(src, /\{\s*(err|error)\??\.message\s*\}/, `${rel}: message crudo en JSX`);
  }
});

test('fugas: ningún console.* del código montado imprime cookies, tokens, CSRF ni Authorization', () => {
  for (const rel of archivosMontados()) {
    for (const linea of read(rel).split('\n').filter((l) => /console\.(log|warn|error|info|debug)\(/.test(l))) {
      assert.doesNotMatch(linea, /cookie|csrf|token|authorization|password|headers/i, `${rel}: ${linea.trim()}`);
    }
  }
});

test('correlationId nunca se persiste en el navegador', () => {
  for (const rel of archivosMontados()) {
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    if (!/correlationId/.test(src)) continue;
    assert.doesNotMatch(src, /(localStorage|sessionStorage|indexedDB)[^\n]*correlationId|correlationId[^\n]*(localStorage|sessionStorage|indexedDB)/, rel);
  }
});
