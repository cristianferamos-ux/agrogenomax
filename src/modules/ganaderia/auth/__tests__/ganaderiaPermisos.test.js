// FASE 3A: matriz central de capacidades (frontend), alineación con la matriz
// del backend, outbox offline ante 403 ROLE_FORBIDDEN y ausencia de acciones
// críticas en la UI según el rol.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  CAPACIDADES,
  CAPACIDAD_OPERACION_OFFLINE,
  MENSAJE_OFFLINE_ROLE_FORBIDDEN,
  MENSAJE_ROLE_FORBIDDEN,
  ROLES_ORGANIZACION,
  canAdministrarCiclo,
  canAnularAnimal,
  canAsociarQr,
  canCerrarAnimal,
  canCorregirAnimal,
  canCrearAnimal,
  canCrearCatalogoPersonalizado,
  canDarBajaQr,
  canEditarPotrero,
  canEditarPredio,
  canOperarCiclo,
  canPlanificarPastoreo,
  canReemplazarQr,
  canRegistrarPesaje,
  capacidadesDe,
  puede,
  puedeEncolar,
} from '../ganaderiaPermisos.js';
import {
  ROLES_ADMINISTRACION,
  ROLES_OPERACION,
  ROLES_ORGANIZACION as ROLES_SERVIDOR,
} from '../../../../../server/security/ganaderiaPermisos.js';
import { ORG_STORES } from '../../offline/offlineSchema.js';
import { createMemoryStorage } from '../../offline/storage.js';
import { createLocalRepo } from '../../offline/localRepo.js';
import { classifyResult, createSyncEngine, isRoleForbidden } from '../../offline/syncEngine.js';
import { OUTBOX_ESTADOS } from '../../offline/outbox.js';
import { buildPesajeBody, initialPesajeForm } from '../../hato/pesajesModel.js';
import { estadoPesajePendiente, mensajeBloqueoPesaje } from '../../hato/pesajesOfflineModel.js';
import { accionesCierre } from '../../hato/cierreModel.js';
import { messageForError } from '../../hato/hatoFormModel.js';

const OPERATIVAS = ['crearAnimal', 'registrarPesaje', 'asociarQr', 'operarCiclo', 'planificarPastoreo'];
const ADMINISTRATIVAS = ['corregirAnimal', 'anularAnimal', 'reemplazarQr', 'darBajaQr', 'cerrarAnimal',
  'editarPredio', 'editarPotrero', 'administrarCiclo', 'crearCatalogoPersonalizado'];

// ---------------------------------------------------------------------------
// Matriz
// ---------------------------------------------------------------------------

test('la matriz cubre exactamente las capacidades operativas + administrativas', () => {
  assert.deepEqual(Object.keys(CAPACIDADES).sort(), [...OPERATIVAS, ...ADMINISTRATIVAS].sort());
  assert.deepEqual([...ROLES_ORGANIZACION], ['owner', 'admin', 'operador', 'lector']);
});

test('owner y admin: todas las capacidades', () => {
  for (const rol of ['owner', 'admin']) {
    const caps = capacidadesDe(rol);
    for (const c of Object.keys(CAPACIDADES)) assert.equal(caps[c], true, `${rol}.${c}`);
    assert.equal(caps.soloLectura, false);
  }
});

test('operador: solo operativas (crear animal, pesaje, asociar QR, ciclos cotidianos, planificación)', () => {
  const caps = capacidadesDe('operador');
  for (const c of OPERATIVAS) assert.equal(caps[c], true, c);
  for (const c of ADMINISTRATIVAS) assert.equal(caps[c], false, c);
  assert.equal(caps.soloLectura, false);
});

test('lector: ninguna escritura (modo lectura)', () => {
  const caps = capacidadesDe('lector');
  for (const c of Object.keys(CAPACIDADES)) assert.equal(caps[c], false, c);
  assert.equal(caps.soloLectura, true);
});

test('rol ausente, desconocido, con otra capitalización o super_admin -> modo lectura', () => {
  for (const rol of [null, undefined, '', 'propietario', 'OWNER', 'Admin', 'super_admin', 42, {}]) {
    assert.equal(capacidadesDe(rol).soloLectura, true, String(rol));
  }
  assert.throws(() => puede('owner', 'inexistente'), /CAPACIDAD_DESCONOCIDA/);
});

test('helpers can*: coherentes con la matriz para los 4 roles', () => {
  const helpers = {
    crearAnimal: canCrearAnimal, registrarPesaje: canRegistrarPesaje, asociarQr: canAsociarQr,
    corregirAnimal: canCorregirAnimal, anularAnimal: canAnularAnimal, reemplazarQr: canReemplazarQr,
    darBajaQr: canDarBajaQr, cerrarAnimal: canCerrarAnimal, editarPredio: canEditarPredio,
    editarPotrero: canEditarPotrero, operarCiclo: canOperarCiclo, administrarCiclo: canAdministrarCiclo,
    planificarPastoreo: canPlanificarPastoreo, crearCatalogoPersonalizado: canCrearCatalogoPersonalizado,
  };
  for (const [c, fn] of Object.entries(helpers)) {
    for (const rol of ROLES_ORGANIZACION) assert.equal(fn(rol), puede(rol, c), `${c}(${rol})`);
  }
});

test('alineada con la matriz del backend (server/security/ganaderiaPermisos.js)', () => {
  assert.deepEqual([...ROLES_ORGANIZACION], [...ROLES_SERVIDOR]);
  for (const c of OPERATIVAS) assert.deepEqual([...CAPACIDADES[c]], [...ROLES_OPERACION], c);
  for (const c of ADMINISTRATIVAS) assert.deepEqual([...CAPACIDADES[c]], [...ROLES_ADMINISTRACION], c);
});

test('cierres (salida/muerte) siguen la matriz central: solo owner/admin', () => {
  const animal = { estado: 'ACTIVO', estadoOperativo: 'EN_HATO' };
  for (const rol of ROLES_ORGANIZACION) {
    assert.equal(accionesCierre({ animal, rol, online: true }).visible, canCerrarAnimal(rol), rol);
  }
});

// ---------------------------------------------------------------------------
// Mensajes 403
// ---------------------------------------------------------------------------

test('copy central: ROLE_FORBIDDEN online y offline; nunca "sesión expirada"', () => {
  assert.equal(MENSAJE_ROLE_FORBIDDEN, 'No tienes permisos para realizar esta acción.');
  assert.equal(MENSAJE_OFFLINE_ROLE_FORBIDDEN, 'La operación no se sincronizó porque ya no tienes permisos para realizarla.');
  assert.equal(messageForError('ROLE_FORBIDDEN'), MENSAJE_ROLE_FORBIDDEN);
  assert.equal(mensajeBloqueoPesaje('ROLE_FORBIDDEN'), MENSAJE_OFFLINE_ROLE_FORBIDDEN);
  assert.doesNotMatch(MENSAJE_ROLE_FORBIDDEN, /sesi[oó]n/i);
});

test('mapas de error de los paneles con escrituras incluyen ROLE_FORBIDDEN', () => {
  const base = new URL('../../', import.meta.url);
  const archivos = [
    'potreros/PotreroCapacidadPastoreoPanel.jsx', 'potreros/PotreroCicloPastoreoPanel.jsx',
    'potreros/PotreroDescansoReentradaPanel.jsx', 'potreros/PotreroFichaProductivaPanel.jsx',
    'potreros/PotreroPlanPastoreoSmart.jsx', 'potreros/PotreroRecomendacionPastoreoPanel.jsx',
    'potreros/PotreroRegistrationPanel.jsx', 'potreros/PotreroResidualRealPanel.jsx',
    'predios/PrediosPage.jsx', 'offline/OfflineSyncPage.jsx',
  ];
  for (const archivo of archivos) {
    const src = fs.readFileSync(new URL(archivo, base), 'utf8');
    assert.match(src, /ROLE_FORBIDDEN: MENSAJE_(OFFLINE_)?ROLE_FORBIDDEN/, archivo);
  }
});

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------

test('encolar: lector nada; operador solo lo permitido; operación desconocida nunca', () => {
  for (const tipo of Object.keys(CAPACIDAD_OPERACION_OFFLINE)) {
    assert.equal(puedeEncolar('lector', tipo), false, tipo);
    assert.equal(puedeEncolar('operador', tipo), true, tipo);
    assert.equal(puedeEncolar('owner', tipo), true, tipo);
  }
  assert.equal(puedeEncolar('owner', 'ANIMAL_ANULAR'), false);
  assert.equal(puedeEncolar(null, 'PESAJE_CREAR'), false);
});

test('classifyResult: 403 ROLE_FORBIDDEN -> RECHAZADO (nunca SESION, CSRF ni reintentable)', () => {
  const conFailure = { ok: false, status: 403, data: { error: 'ROLE_FORBIDDEN' }, failure: 'ROLE_FORBIDDEN' };
  const transporteCrudo = { ok: false, status: 403, data: { error: 'ROLE_FORBIDDEN' } };
  for (const r of [conFailure, transporteCrudo]) {
    assert.equal(isRoleForbidden(r), true);
    assert.equal(classifyResult(r), 'RECHAZADO');
  }
  assert.equal(classifyResult({ ok: false, status: 403, data: { error: 'CSRF_INVALID' }, failure: 'CSRF_REJECTED' }), 'SESION');
  assert.equal(classifyResult({ ok: false, status: 401, data: { error: 'SESSION_REQUIRED' } }), 'SESION');
  assert.equal(classifyResult({ ok: false, status: 403, data: { error: 'SUPERADMIN_REQUIRED' } }), 'SESION');
});

const ORG = '11111111-1111-4111-8111-111111111111';

test('rol cambió con outbox pendiente: 403 ROLE_FORBIDDEN -> RECHAZADO terminal, sin reintento infinito', async () => {
  let t = new Date('2026-10-20T15:00:00.000Z').getTime();
  const now = () => new Date(t);
  const repo = createLocalRepo(createMemoryStorage(ORG_STORES), { organizacionId: ORG, deviceId: 'dev-1', now });
  const body = buildPesajeBody({ ...initialPesajeForm('2026-10-20'), pesoKg: '355' }, randomUUID());
  await repo.registrarPesajeLocal({ animalId: '1', body });

  const posts = [];
  const transport = {
    async postJson(pathname) {
      posts.push(pathname);
      return { ok: false, status: 403, data: { error: 'ROLE_FORBIDDEN' }, failure: 'ROLE_FORBIDDEN' };
    },
    async getJson() {
      return { ok: true, status: 200, data: { organizacionId: ORG, cursor: 'c', completo: false, animales: [], chapetas: [], predios: [], potreros: [], razas: [], categorias: [] } };
    },
  };
  const engine = createSyncEngine({ repo, transport, now, isOnline: () => true, lock: null });
  await engine.syncNow();
  const [op] = await repo.listOutbox();
  assert.equal(op.estado, OUTBOX_ESTADOS.RECHAZADO);
  assert.equal(op.ultimoError.codigo, 'ROLE_FORBIDDEN');
  assert.equal(op.siguienteIntentoAt ?? null, null);

  const enviados = posts.length;
  t += 24 * 60 * 60_000;
  await engine.syncNow({ forzar: true });
  assert.equal(posts.length, enviados, 'un rechazo por permisos no se reenvía');

  const estado = estadoPesajePendiente(op);
  assert.equal(estado.bloqueado, true);
  assert.equal(estado.detalle, MENSAJE_OFFLINE_ROLE_FORBIDDEN);
});

// ---------------------------------------------------------------------------
// UI: acciones críticas detrás de la matriz (sin `rol === 'owner'` disperso)
// ---------------------------------------------------------------------------

const src = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

test('ninguna pantalla repite comparaciones de rol literales', () => {
  const archivos = [
    'hato/HatoListaPage.jsx', 'hato/HatoRegistroPage.jsx', 'hato/HatoDetallePage.jsx', 'hato/HatoQrPanel.jsx',
    'hato/HatoPesajesPanel.jsx', 'hato/HatoCierreAnimal.jsx', 'hato/cierreModel.js', 'predios/PrediosPage.jsx',
    'potreros/PotrerosByPredioPanel.jsx', 'potreros/PotreroFichaProductivaPanel.jsx', 'potreros/PotreroCicloPastoreoPanel.jsx',
    'potreros/PotreroResidualRealPanel.jsx', 'offline/OfflineSyncPage.jsx',
  ];
  for (const archivo of archivos) {
    assert.doesNotMatch(src(archivo), /rol\s*===\s*'(owner|admin|operador|lector)'/, archivo);
    assert.doesNotMatch(src(archivo), /\['owner', 'admin'\]/, archivo);
  }
});

test('hook de permisos: rol solo desde la sesión (organizacionActiva.rol)', () => {
  const hook = src('auth/useGanaderiaPermisos.js');
  assert.match(hook, /useGanaderiaAuthOptional\(\)\?\.organizacionActiva\?\.rol \?\? null/);
  assert.match(hook, /capacidadesDe\(rol\)/);
});

test('animales: registrar/corregir/anular/pesaje solo con su capacidad', () => {
  assert.match(src('hato/HatoListaPage.jsx'), /\{permisos\.crearAnimal \? <Link className="gan-submit gan-hato-cta" to="\/ganaderia\/animales\/nuevo">Registrar animal<\/Link> : null\}/);
  const registro = src('hato/HatoRegistroPage.jsx');
  assert.match(registro, /if \(!permisos\.crearAnimal\) \{\s*setError\(MENSAJE_ROLE_FORBIDDEN\);\s*return;\s*\}/);
  assert.ok(registro.indexOf('if (!permisos.crearAnimal)') < registro.indexOf('if (local) {'), 'el guard va antes de encolar offline');
  assert.match(registro, /\{permisos\.crearAnimal && catalogos\.status === 'ok' && catalogos\.predios\.length > 0 \? \(\s*<form/);
  const detalle = src('hato/HatoDetallePage.jsx');
  assert.match(detalle, /\{permisos\.corregirAnimal \? \(\s*<button type="button" className="gan-submit" onClick=\{abrirCorreccion\}/);
  assert.match(detalle, /\{permisos\.anularAnimal \? \(\s*<button[\s\S]{0,600}?Anular registro/);
  assert.match(detalle, /modo === 'corregir' && form && permisos\.corregirAnimal/);
  assert.match(detalle, /modo === 'anular' && permisos\.anularAnimal/);
  const pesajes = src('hato/HatoPesajesPanel.jsx');
  assert.match(pesajes, /const mostrarFormulario = permisos\.registrarPesaje && /);
  assert.match(pesajes, /if \(!permisos\.registrarPesaje\) \{\s*setMensaje\(\{ type: 'error', text: MENSAJE_ROLE_FORBIDDEN \}\);\s*return;/);
});

test('QR: asociar (operación) vs reemplazar/baja (administración)', () => {
  const qr = src('hato/HatoQrPanel.jsx');
  assert.match(qr, /\(activa \? permisos\.reemplazarQr \|\| permisos\.darBajaQr : permisos\.asociarQr\)/);
  assert.match(qr, /\{permisos\.reemplazarQr \? <button[^>]*onClick=\{\(\) => abrir\('reemplazar'\)\}/);
  assert.match(qr, /\{permisos\.darBajaQr \? <button[^>]*onClick=\{\(\) => abrir\('baja'\)\}/);
});

test('predios/potreros: estructura solo owner/admin', () => {
  const predios = src('predios/PrediosPage.jsx');
  assert.match(predios, /\{!permisos\.editarPredio \? null : sinConexion \? \(/);
  assert.match(predios, /\{sinConexion \|\| !permisos\.editarPredio \? null : !archivado \? \(/);
  assert.match(predios, /\{!sinConexion && permisos\.editarPotrero \? \(/);
  const potreros = src('potreros/PotrerosByPredioPanel.jsx');
  assert.match(potreros, /\{!permisos\.editarPotrero \? null : !archivado \? \(/);
  const ficha = src('potreros/PotreroFichaProductivaPanel.jsx');
  assert.match(ficha, /\{showForm && permisos\.editarPotrero \? \(/);
  assert.match(ficha, /\{!permisos\.crearCatalogoPersonalizado \? null : !showOtra \? \(/);
});

test('ciclos: operación cotidiana vs administrativas', () => {
  const ciclo = src('potreros/PotreroCicloPastoreoPanel.jsx');
  assert.match(ciclo, /\{!permisos\.operarCiclo \? null : !ajustando \? \(\s*<>\s*<button type="button" className="gan-secondary-button" onClick=\{handleIniciar\}/);
  assert.match(ciclo, /\{permisos\.operarCiclo \? \(\s*<button type="button" className="gan-submit" onClick=\{handleFinalizar\}/);
  assert.match(ciclo, /\{permisos\.administrarCiclo \? \(\s*<button type="button" className="gan-back-inline" onClick=\{handleAbrirCancelar\}/);
  assert.match(ciclo, /\{permisos\.administrarCiclo && ciclo\.estado !== 'ANULADO'/);
  const residual = src('potreros/PotreroResidualRealPanel.jsx');
  assert.match(residual, /\{permisos\.administrarCiclo && !mostrarAnular \? \(/);
  assert.match(residual, /\{permisos\.operarCiclo && comparativoEstado === 'COMPLETO' \? \(/);
});

test('offline: un rechazo por permisos solo se puede descartar, nunca reenviar', () => {
  const page = src('offline/OfflineSyncPage.jsx');
  assert.match(page, /const puedeReenviar = permisos\.crearAnimal && codigo !== 'ROLE_FORBIDDEN';/);
  assert.match(page, /\{puedeReenviar && op\.payload\?\.chapetaCodigo \? \(/);
});
