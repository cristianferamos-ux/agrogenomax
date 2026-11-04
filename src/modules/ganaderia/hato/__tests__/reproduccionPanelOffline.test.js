// FASE 4E.1: panel reproductivo y OfflineSyncPage sin conexión. Modelo puro,
// repositorio real e invariantes por fuente (no hay jsdom en el repo): los
// componentes no se ejecutan aquí.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ORG_STORES } from '../../offline/offlineSchema.js';
import { createMemoryStorage } from '../../offline/storage.js';
import { createLocalRepo, eventoPendienteDe } from '../../offline/localRepo.js';
import { OUTBOX_ESTADOS as E, REPRODUCCION_EVENTO_CREAR, claveOrdenAnimal, newOperation } from '../../offline/outbox.js';
import { MENSAJE_REGISTRO_SIN_CONEXION, MENSAJE_REPRODUCCION_OFFLINE, accionesReproduccion, buildCrearBody, detalleEvento, formDesdeEvento } from '../reproduccionModel.js';
import {
  accionesEventoPendiente,
  destinoRegistro,
  estadoCargaLocal,
  estadoEventoPendiente,
  eventoDesdePendiente,
  leerCopiaLocal,
  mensajeBloqueoReproduccion,
  torosLocales,
} from '../reproduccionOfflineModel.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const ID = 'c0000000-0000-4000-8000-000000000001';
const AHORA = '2026-10-20T15:00:00.000Z';
const HEMBRA = { animalId: '7', sexo: 'HEMBRA', estado: 'ACTIVO', estadoOperativo: 'EN_HATO' };

const leer = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/^\s*\/\/.*$/gm, '');
const panel = leer('../HatoReproduccionPanel.jsx');
const pagina = leer('../../offline/OfflineSyncPage.jsx');
const css = fs.readFileSync(new URL('../../styles/ganaderia-hato.css', import.meta.url), 'utf8');

const repoNuevo = () => createLocalRepo(createMemoryStorage(ORG_STORES), { organizacionId: ORG, deviceId: 'd', now: () => new Date(AHORA) });

async function operacion(repo, cambios = {}) {
  const op = {
    ...newOperation({
      tipoOperacion: REPRODUCCION_EVENTO_CREAR, entidad: 'reproduccion_evento', localUuid: 'l', clientOperationId: ID,
      payload: { animalId: '7', evento: { tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-10-01' } }, deviceId: 'd', now: new Date('2026-10-02T00:00:00Z'), uuid: () => 'o-1',
      claveOrden: claveOrdenAnimal('7'), origen: { organizacionId: ORG, cuentaId: A },
    }),
    ...cambios,
  };
  await repo.storage.put('outbox', op);
  return op;
}

const pendiente = (estado, cambios = {}) => ({ localOperationId: 'o', cuentaOrigenId: A, tipoEvento: 'IATF', fechaEvento: '2026-10-01', estado, posibleEnServidor: false, ultimoError: null, ...cambios });
const acciones = (p, cuentaId = A, puedeRegistrar = true) => accionesEventoPendiente(p, { cuentaId, puedeRegistrar });

// ---------------------------------------------------------------------------
// Disponibilidad
// ---------------------------------------------------------------------------

test('sin conexión con el historial descargado: registrar sí; anular y corregir no', () => {
  const a = accionesReproduccion({ animal: HEMBRA, puedeRegistrar: true, puedeAdministrar: true, online: false, registroLocal: true });
  assert.equal(a.registrarHabilitado, true);
  assert.equal(a.habilitado, false);
  assert.equal(a.aviso, MENSAJE_REGISTRO_SIN_CONEXION);
  assert.match(MENSAJE_REGISTRO_SIN_CONEXION, /Anular o corregir requiere conexión/);
});

test('sin conexión y sin historial descargado: nada, con su aviso', () => {
  const a = accionesReproduccion({ animal: HEMBRA, puedeRegistrar: true, puedeAdministrar: true, online: false, registroLocal: false });
  assert.equal(a.registrarHabilitado, false);
  assert.equal(a.aviso, MENSAJE_REPRODUCCION_OFFLINE);
});

test('la copia local no da permisos: el lector tampoco registra sin conexión', () => {
  const a = accionesReproduccion({ animal: HEMBRA, puedeRegistrar: false, puedeAdministrar: false, online: false, registroLocal: true });
  assert.equal(a.registrar, false);
});

test('destino: online sin pendientes va al servidor; sin red o con pendientes, a la cola', () => {
  assert.equal(destinoRegistro({ online: true, pendientes: [] }), 'servidor');
  assert.equal(destinoRegistro({ online: false, pendientes: [] }), 'local');
  assert.equal(destinoRegistro({ online: true, pendientes: [pendiente(E.PENDIENTE)] }), 'local', 'no adelanta la cadena FIFO');
});

// ---------------------------------------------------------------------------
// Acciones por estado y cuenta
// ---------------------------------------------------------------------------

test('otra cuenta nunca puede editar, descartar ni reintentar, en ningún estado', () => {
  for (const estado of Object.values(E)) {
    assert.deepEqual(acciones(pendiente(estado), B), { editar: false, cancelar: false, reintentar: false, confirmarIncierto: false }, estado);
  }
});

test('sin cuenta en la sesión, o sin cuenta de origen, tampoco', () => {
  assert.equal(acciones(pendiente(E.PENDIENTE), null).cancelar, false);
  assert.equal(acciones(pendiente(E.PENDIENTE, { cuentaOrigenId: null }), null).cancelar, false);
  assert.equal(acciones(pendiente(E.PENDIENTE, { cuentaOrigenId: null })).editar, false);
});

test('enviándose: ninguna acción', () => {
  assert.deepEqual(acciones(pendiente(E.SINCRONIZANDO)), { editar: false, cancelar: false, reintentar: false, confirmarIncierto: false });
});

test('sin riesgo en el servidor: editar y descartar; reintentar solo si falló', () => {
  assert.deepEqual(acciones(pendiente(E.PENDIENTE)), { editar: true, cancelar: true, reintentar: false, confirmarIncierto: false });
  assert.equal(acciones(pendiente(E.ERROR_REINTENTABLE)).reintentar, true);
  assert.equal(acciones(pendiente(E.RECHAZADO)).reintentar, true);
  assert.equal(acciones(pendiente(E.CONFLICTO)).reintentar, true);
  assert.equal(acciones(pendiente(E.BLOQUEADA_POR_IDENTIDAD)).reintentar, false, 'sale sola al volver su cuenta');
});

test('pudo llegar al servidor: la intención no cambia y un pendiente vivo no se descarta', () => {
  for (const estado of [E.PENDIENTE, E.ERROR_REINTENTABLE, E.BLOQUEADA_POR_IDENTIDAD]) {
    const a = acciones(pendiente(estado, { posibleEnServidor: true }));
    assert.equal(a.editar, false, estado);
    assert.equal(a.cancelar, false, estado);
  }
});

test('conflicto que pudo llegar: se descarta solo confirmando, y nunca se edita', () => {
  const a = acciones(pendiente(E.CONFLICTO, { posibleEnServidor: true }));
  assert.deepEqual(a, { editar: false, cancelar: true, reintentar: true, confirmarIncierto: true });
});

test('intención distinta o id reutilizado: reintentar no lo resolvería', () => {
  for (const codigo of ['CONCILIACION_INTENCION_DISTINTA', 'CLIENT_OPERATION_ID_REUSED']) {
    assert.equal(acciones(pendiente(E.CONFLICTO, { ultimoError: { codigo } })).reintentar, false, codigo);
  }
});

test('sin permiso actual no se ofrece reintentar', () => {
  assert.equal(acciones(pendiente(E.RECHAZADO, { ultimoError: { codigo: 'ROLE_FORBIDDEN' } }), A, false).reintentar, false);
});

// ---------------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------------

test('cada estado se explica con texto, y lo incierto se avisa', () => {
  assert.equal(estadoEventoPendiente(pendiente(E.PENDIENTE)).etiqueta, 'Pendiente');
  assert.equal(estadoEventoPendiente(pendiente(E.SINCRONIZANDO)).etiqueta, 'Sincronizando');
  assert.equal(estadoEventoPendiente(pendiente(E.BLOQUEADA_POR_IDENTIDAD)).etiqueta, 'Esperando su cuenta');
  assert.equal(estadoEventoPendiente(pendiente(E.CONFLICTO)).etiqueta, 'No sincronizado');
  assert.equal(estadoEventoPendiente(pendiente(E.RECHAZADO)).clase, 'bloqueado');
  assert.match(estadoEventoPendiente(pendiente(E.ERROR_REINTENTABLE, { posibleEnServidor: true })).detalle, /Pudo haber llegado/);
});

test('identidad: el motivo distingue otra cuenta, sesión y origen', () => {
  assert.match(estadoEventoPendiente(pendiente(E.BLOQUEADA_POR_IDENTIDAD, { ultimoError: { codigo: 'IDENTIDAD_NO_COINCIDE' } })).detalle, /otra cuenta/);
  assert.match(estadoEventoPendiente(pendiente(E.BLOQUEADA_POR_IDENTIDAD, { ultimoError: { codigo: 'SESION_NO_VERIFICABLE' } })).detalle, /verificar la sesión/);
  assert.match(estadoEventoPendiente(pendiente(E.BLOQUEADA_POR_IDENTIDAD, { ultimoError: { codigo: 'ORIGEN_NO_VERIFICABLE' } })).detalle, /no se enviará/);
});

test('mensajes: por código conocido y genérico; nunca el código ni el texto del servidor', () => {
  assert.match(mensajeBloqueoReproduccion('CONCILIACION_INTENCION_DISTINTA'), /datos distintos/);
  assert.match(mensajeBloqueoReproduccion('SEXO_INCOMPATIBLE'), /hembras/);
  assert.equal(mensajeBloqueoReproduccion('ALGO_INTERNO_DESCONOCIDO'), 'El servidor no aceptó este evento.');
  assert.equal(mensajeBloqueoReproduccion(undefined), 'El servidor no aceptó este evento.');
});

// ---------------------------------------------------------------------------
// El pendiente nunca altera lo confirmado
// ---------------------------------------------------------------------------

test('la copia local pliega solo confirmados: un pendiente no cambia estado ni parto probable', async () => {
  const repo = repoNuevo();
  await repo.putMeta({ reproduccionListaAt: AHORA });
  await repo.storage.put('reproduccion_eventos', { eventoId: '1', animalId: '7', tipoEvento: 'CELO_OBSERVADO', fechaEvento: '2026-09-01', estadoRegistro: 'ACTIVO', clientOperationId: 'x' });
  await operacion(repo, { payload: { animalId: '7', evento: { tipoEvento: 'DIAGNOSTICO_PRENEZ', fechaEvento: '2026-10-01', diagnosticoResultado: 'PRENADA', diagnosticoMetodo: 'ECOGRAFIA' } } });
  const carga = await leerCopiaLocal(repo, { animalId: '7', sexo: 'HEMBRA', hoy: '2026-10-20' });
  assert.equal(carga.origen, 'local');
  assert.equal(carga.estado.estado, 'CICLANDO');
  assert.equal(carga.estado.gestacion ?? null, null);
  assert.deepEqual(carga.eventos.map((e) => e.eventoId), ['1']);
});

test('sin historial descargado no hay copia local que mostrar', async () => {
  assert.equal(await leerCopiaLocal(repoNuevo(), { animalId: '7', sexo: 'HEMBRA', hoy: '2026-10-20' }), null);
  assert.equal(await leerCopiaLocal(null, { animalId: '7', sexo: 'HEMBRA', hoy: '2026-10-20' }), null);
});

test('un ANULADO de la copia local sigue visible pero no cuenta', () => {
  const carga = estadoCargaLocal({ sexo: 'HEMBRA', hoy: '2026-10-20', eventos: [{ eventoId: '1', tipoEvento: 'PARTO', fechaEvento: '2026-09-01', estadoRegistro: 'ANULADO', partoTipo: 'NORMAL', numeroCrias: 1 }] });
  assert.equal(carga.estado.estado, 'SIN_ESTADO');
  assert.equal(carga.eventos.length, 1);
});

test('un pendiente se puede mostrar y editar con el mismo formulario', () => {
  const p = pendiente(E.PENDIENTE, { tipoEvento: 'PARTO', partoTipo: 'NORMAL', numeroCrias: 2, observaciones: 'nota' });
  const evento = eventoDesdePendiente(p);
  assert.ok(detalleEvento(evento, {}).length >= 2);
  const form = formDesdeEvento(evento);
  assert.equal(form.partoTipo, 'NORMAL');
  assert.equal(form.numeroCrias, '2');
  assert.deepEqual(buildCrearBody(form, ID), { tipoEvento: 'PARTO', fechaEvento: '2026-10-01', observaciones: 'nota', partoTipo: 'NORMAL', numeroCrias: 2, clientOperationId: ID });
});

test('toros de la copia local: solo machos, activos seleccionables', async () => {
  const repo = repoNuevo();
  await repo.storage.put('animales', { key: 'srv:1', animalId: '1', sexo: 'MACHO', estado: 'ACTIVO', numeroVisual: 'T1' });
  await repo.storage.put('animales', { key: 'srv:2', animalId: '2', sexo: 'MACHO', estado: 'ANULADO', numeroVisual: 'T2' });
  await repo.storage.put('animales', { key: 'srv:3', animalId: '3', sexo: 'HEMBRA', estado: 'ACTIVO', numeroVisual: 'H' });
  const toros = await torosLocales(repo, (a) => a.numeroVisual);
  assert.deepEqual(toros.opciones, [{ value: '1', label: 'T1' }]);
  assert.equal(toros.mapa.get('2'), 'T2');
  assert.equal(toros.mapa.has('3'), false);
});

// ---------------------------------------------------------------------------
// Reintentar: repositorio real
// ---------------------------------------------------------------------------

for (const estado of [E.CONFLICTO, E.RECHAZADO, E.ERROR_REINTENTABLE]) {
  test(`reintentar ${estado}: mismo id, misma posición, misma incertidumbre e intentos`, async () => {
    const repo = repoNuevo();
    const op = await operacion(repo, { estado, posibleEnServidor: true, intentos: 3, ultimoError: { codigo: 'X', status: 500 }, siguienteIntentoAt: '2026-10-21T00:00:00.000Z' });
    await repo.reintentarEventoPendiente(op.operationId, { cuentaId: A });
    const [r] = await repo.listOutbox();
    assert.equal(r.estado, E.PENDIENTE);
    assert.equal(r.clientOperationId, ID);
    assert.equal(r.createdAt, op.createdAt);
    assert.equal(r.posibleEnServidor, true);
    assert.equal(r.intentos, 3);
    assert.equal(r.ultimoError, null);
    assert.equal(r.siguienteIntentoAt, null);
    assert.deepEqual(r.payload, op.payload);
    assert.deepEqual(r.origen, op.origen);
  });
}

test('reintentar: otra cuenta o sin cuenta no puede, y la operación queda igual', async () => {
  const repo = repoNuevo();
  const op = await operacion(repo, { estado: E.RECHAZADO });
  await assert.rejects(repo.reintentarEventoPendiente(op.operationId, { cuentaId: B }), { code: 'BLOQUEADA_POR_IDENTIDAD' });
  await assert.rejects(repo.reintentarEventoPendiente(op.operationId), { code: 'BLOQUEADA_POR_IDENTIDAD' });
  assert.deepEqual(await repo.listOutbox(), [op]);
});

for (const estado of [E.PENDIENTE, E.SINCRONIZANDO, E.BLOQUEADA_POR_IDENTIDAD]) {
  test(`reintentar ${estado}: no aplica y no cambia nada`, async () => {
    const repo = repoNuevo();
    const op = await operacion(repo, { estado });
    await assert.rejects(repo.reintentarEventoPendiente(op.operationId, { cuentaId: A }), { code: 'EVENTO_NO_REINTENTABLE' });
    assert.deepEqual(await repo.listOutbox(), [op]);
  });
}

for (const codigo of ['CONCILIACION_INTENCION_DISTINTA', 'CLIENT_OPERATION_ID_REUSED']) {
  test(`reintentar ${codigo}: el repositorio también lo rechaza`, async () => {
    const repo = repoNuevo();
    const op = await operacion(repo, { estado: E.CONFLICTO, ultimoError: { codigo, status: 409 } });
    await assert.rejects(repo.reintentarEventoPendiente(op.operationId, { cuentaId: A }), { code: 'EVENTO_NO_REINTENTABLE' });
    assert.deepEqual(await repo.listOutbox(), [op]);
  });
}

test('reintentar otro tipo u operación inexistente: no encontrada', async () => {
  const repo = repoNuevo();
  const pesaje = await operacion(repo, { tipoOperacion: 'PESAJE_CREAR', estado: E.RECHAZADO });
  await assert.rejects(repo.reintentarEventoPendiente(pesaje.operationId, { cuentaId: A }), { code: 'EVENTO_PENDIENTE_NO_ENCONTRADO' });
  await assert.rejects(repo.reintentarEventoPendiente('nada', { cuentaId: A }), { code: 'EVENTO_PENDIENTE_NO_ENCONTRADO' });
});

test('el pendiente expone su cuenta de origen para la UI, sin el resto de la operación', async () => {
  const repo = repoNuevo();
  const op = await operacion(repo);
  const p = eventoPendienteDe(op);
  assert.equal(p.cuentaOrigenId, A);
  assert.equal('origen' in p, false);
  assert.equal((await repo.contar()).reproduccionListaAt, null);
});

// ---------------------------------------------------------------------------
// Invariantes por fuente (componentes)
// ---------------------------------------------------------------------------

test('panel: la cuenta sale de la sesión y el registro va a la cola según el destino', () => {
  assert.match(panel, /auth\?\.cuenta\?\.cuentaId/);
  assert.match(panel, /destinoRegistro\(\{ online, pendientes \}\)/);
  assert.match(panel, /if \(registroEnOutbox\) \{\s*guardarLocal\(\);\s*return;\s*\}\s*ejecutar\(/);
  assert.match(panel, /registroLocal: Boolean\(repoOffline\) && registroLocal/);
});

test('panel: anular y corregir siguen exigiendo conexión y no pasan por el repositorio local', () => {
  assert.match(panel, /deshabilitado=\{modo\.accion === 'corregir' \? !acciones\.habilitado : false\}/);
  assert.match(panel, /async function ejecutar\(accion, firma, enviar\) \{\s*if \(enviandoRef\.current \|\| !online\) return;/);
  assert.match(panel, /ejecutar\('anular'/);
  assert.match(panel, /ejecutar\('corregir'/);
  assert.match(panel, /deshabilitado=\{!acciones\.habilitado\}\s*aviso=\{acciones\.aviso\}\s*onCancelar=\{cerrar\}/);
});

test('panel: los pendientes van en su sección y no entran en el estado ni en el historial confirmado', () => {
  assert.match(panel, /Pendientes de sincronizar/);
  assert.match(panel, /TEXTO_PENDIENTES_NO_CUENTAN/);
  assert.match(panel, /<EstadoReproductivo estado=\{carga\.estado\} \/>/);
  assert.match(panel, /carga\.eventos\.map\(\(evento\) => \(\s*<EventoHistorial/);
  assert.doesNotMatch(panel, /derivarEstadoReproductivo/);
});

test('panel: no reutiliza el id al confirmar una advertencia ni lo descarta antes de guardar', () => {
  assert.match(panel, /if \(trasGuardarLocal\(resultado\)\) operaciones\.current\.resolver\('crear', \{ descartarOperacion: true \}\);/);
  assert.match(panel, /Guardar de todos modos/);
});

test('panel: la copia local se identifica y se sustituye al volver la conexión', () => {
  assert.match(panel, /carga\.origen === 'local' \? <StatusMessage type="info">\{TEXTO_COPIA_LOCAL\}/);
  assert.match(panel, /if \(visible && online && carga\.origen === 'local'\) cargar\(\);/);
});

test('panel: una consulta de toros sin red usa la copia local', () => {
  assert.match(panel, /torosLocales\(repoOffline, formatIdentidad\)/);
});

test('ficha: entrega al panel el repositorio y la sincronización', () => {
  const ficha = leer('../HatoDetallePage.jsx');
  assert.match(ficha, /<HatoReproduccionPanel[\s\S]*?repoOffline=\{offline\.repo\}[\s\S]*?syncNow=\{offline\.syncNow\}/);
});

test('sincronización: distingue eventos reproductivos y no los trata como un animal local', () => {
  assert.match(pagina, /op\.tipoOperacion === REPRODUCCION_EVENTO_CREAR\) \{\s*return <EventoReproductivoItem/);
  assert.match(pagina, /op\.tipoOperacion === 'PESAJE_CREAR' \|\| op\.tipoOperacion === REPRODUCCION_EVENTO_CREAR\s*\? await offline\.repo\.getAnimal\(op\.payload\?\.animalId\)/);
});

test('sincronización: lista aparte lo que espera a su cuenta y no lo cuenta como conflicto', () => {
  assert.match(pagina, /op\.estado === OUTBOX_ESTADOS\.BLOQUEADA_POR_IDENTIDAD/);
  assert.match(pagina, /Esperando a la cuenta que los registró/);
  assert.match(pagina, /Nunca cambian de autor/);
});

test('sincronización: lista también lo pendiente, lo que se envía y lo reintentable, sin pintarlo como conflicto', () => {
  assert.match(pagina, /op\.tipoOperacion === REPRODUCCION_EVENTO_CREAR\s*&& \[OUTBOX_ESTADOS\.PENDIENTE, OUTBOX_ESTADOS\.SINCRONIZANDO, OUTBOX_ESTADOS\.ERROR_REINTENTABLE\]\.includes\(op\.estado\)/);
  assert.match(pagina, /Eventos reproductivos por sincronizar/);
  assert.match(pagina, /gan-offline-conflictos gan-offline-en-curso/);
});

test('sincronización: reintentar y descartar pasan la cuenta de la sesión al repositorio', () => {
  assert.match(pagina, /repo\.reintentarEventoPendiente\(op\.operationId, \{ cuentaId \}\)/);
  assert.match(pagina, /repo\.cancelarEventoReproductivoPendiente\(op\.operationId, \{ cuentaId, confirmarIncierto: acciones\.confirmarIncierto \}\)/);
  assert.match(pagina, /Historial reproductivo/);
});

test('estilos de los pendientes existen', () => {
  for (const clase of ['.gan-repro-badge-pendiente', '.gan-repro-badge-bloqueado', '.gan-repro-evento-pendiente']) assert.ok(css.includes(clase), clase);
});
