// FASE 5A.3c -- UI offline de pesajes sobre el motor 5A.3b: modelo puro
// (pesajesOfflineVista.js), lectura del motor (localRepo.leerPesajesLocales) con el
// repositorio REAL en memoria, y arquitectura de la ficha (sin render JSX en node:
// el comportamiento visual se verifica en la E2E de navegador).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ORG_STORES } from '../../offline/offlineSchema.js';
import { createMemoryStorage } from '../../offline/storage.js';
import { createLocalRepo } from '../../offline/localRepo.js';
import { OUTBOX_ESTADOS, PESAJE_CREAR, newOperation } from '../../offline/outbox.js';
import { capacidadesDe } from '../../auth/ganaderiaPermisos.js';
import { construirHistorialPesajes as construirServidor } from '../../../../../server/services/ganaderia/pesajesService.js';
import {
  ADVERTENCIA_CANCELAR_PENDIENTE,
  ETIQUETA_ANULACION_PENDIENTE,
  accionesPesajePendiente,
  construirHistorialPesajes,
  estadoAnulacionPendiente,
  marcarAnulacionesPendientes,
  mensajeAccionOffline,
  presentarUltimoPesoFicha,
  vistaLocalPesajes,
} from '../pesajesOfflineVista.js';
import { accionAnularPesaje, presentarFilaHistorial, MENSAJE_ANULACION_REQUIERE_CONEXION } from '../pesajesAnulacionModel.js';
import { MENSAJE_IDENTIDAD_OPERACION, estadoPesajePendiente } from '../pesajesOfflineModel.js';
import { AVISO_REPORTE_SIN_CONEXION } from '../reporteProductivoModel.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const CUENTA_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CUENTA_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const panel = src('../HatoPesajesPanel.jsx');
const pendientesJsx = src('../HatoPesajesPendientes.jsx');
const historialJsx = src('../HatoPesajesHistorial.jsx');
const dialogo = src('../HatoPesajeAnularDialog.jsx');
const detalle = src('../HatoDetallePage.jsx');
const reporteBoton = src('../HatoReporteProductivoBoton.jsx');

function contadorUuid() {
  let n = 0;
  return () => `ffffffff-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

const fila = (f) => ({
  organizacionId: ORG, animalId: '7', metodo: 'BASCULA', origen: 'MANUAL', observaciones: null, createdAt: '2026-10-01T10:00:00.000Z',
  estadoRegistro: 'ACTIVO', anulacion: null, clientOperationId: null, anulacionClientOperationId: null, ...f,
});
const pagina = (pesajes) => ({
  ok: true, pesajes, hayMas: false, completo: true, cursorSiguiente: 'c-1',
  totales: { pesajes: pesajes.length, anulados: pesajes.filter((p) => p.estadoRegistro === 'ANULADO').length },
  organizacionId: ORG, cuentaId: CUENTA_A,
});

/** Repositorio real en memoria con la copia local completa (o no) de los pesajes del animal 7. */
async function dispositivo(filas = [], { completa = true } = {}) {
  const storage = createMemoryStorage(ORG_STORES);
  const repo = createLocalRepo(storage, { organizacionId: ORG, deviceId: 'd-1', now: () => new Date('2026-11-21T15:00:00.000Z'), uuid: contadorUuid() });
  await storage.put('animales', { key: 'srv:7', animalId: '7', ultimoPeso: { pesoKg: 999, fecha: '2026-01-01', metodo: 'ESTIMADO' } });
  if (filas.length || completa) {
    await repo.aplicarPullPesajes(completa ? pagina(filas.map(fila)) : { ...pagina(filas.map(fila)), hayMas: true, totales: null });
  }
  return { storage, repo };
}
const BASE = [
  { pesajeId: '1', fecha: '2026-10-01', pesoKg: 200 },
  { pesajeId: '2', fecha: '2026-10-11', pesoKg: 210 },
  { pesajeId: '3', fecha: '2026-10-21', pesoKg: 225 },
];
const anular = (repo, datos) => repo.encolarAnulacionPesaje({ animalId: '7', motivo: 'Error de báscula', cuentaId: CUENTA_A, rol: 'owner', clientOperationId: ID(50), ...datos });
const crear = (repo, n, { cuentaId = CUENTA_A, fecha = '2026-11-20', pesoKg = 240 } = {}) => repo.registrarPesajeLocal({
  animalId: '7', body: { fecha, pesoKg, metodo: 'BASCULA', clientOperationId: ID(n) }, cuentaId,
});
const vista = (lectura) => vistaLocalPesajes({ animalId: '7', ...lectura });

// ---------------------------------------------------------------------------------
// 1-4. Historial local, pendientes y anulados
// ---------------------------------------------------------------------------------

test('1. historial offline confirmado: misma forma y mismos cálculos que el servidor (paridad)', async () => {
  const filas = [...BASE, { pesajeId: '4', fecha: '2026-10-21', pesoKg: 228 }, { pesajeId: '5', fecha: '2026-10-25', pesoKg: 230, estadoRegistro: 'ANULADO', anulacion: { anuladoEn: '2026-11-01T00:00:00.000Z', motivo: 'Duplicado' } }];
  const { repo } = await dispositivo(filas);
  const lectura = await repo.leerPesajesLocales('7');
  assert.equal(lectura.copiaCompleta, true);
  const local = vista(lectura);
  const servidor = construirServidor({ animalId: '7', pesajes: lectura.confirmados });
  assert.deepEqual({ ...local, origen: undefined, provisional: undefined }, { ...servidor, origen: undefined, provisional: undefined });
  assert.deepEqual(construirHistorialPesajes({ animalId: '7', pesajes: lectura.confirmados }), servidor);
  assert.equal(local.origen, 'LOCAL');
  assert.equal(local.provisional, false);
  assert.equal(local.resumen.ultimoPesoKg, 228, 'mismo día: último por pesajeId');
  assert.equal(local.historial.length, 5);
});

test('2. CREATE pendiente visible aparte, sin pesajeId, "Pendiente de sincronización"', async () => {
  const { repo } = await dispositivo(BASE);
  await crear(repo, 1);
  const lectura = await repo.leerPesajesLocales('7');
  assert.equal(lectura.pendientes.length, 1);
  const p = lectura.pendientes[0];
  assert.equal('pesajeId' in p, false);
  assert.equal(estadoPesajePendiente(p).etiqueta, 'Pendiente de sincronización');
  // Nunca entra en el historial confirmado ni en los cálculos.
  assert.equal(vista(lectura).historial.length, 3);
  assert.equal(vista(lectura).resumen.ultimoPesoKg, 225);
});

test('3. ANULAR pendiente: el pesaje sigue confirmado ACTIVO con "Anulación pendiente" y sale de los cálculos provisionales', async () => {
  const { repo } = await dispositivo(BASE);
  await anular(repo, { pesajeId: '3' });
  const lectura = await repo.leerPesajesLocales('7');
  assert.deepEqual(lectura.anulaciones.map((a) => [a.pesajeId, a.estado, a.diferida]), [['3', 'PENDIENTE', false]]);
  const local = vista(lectura);
  const fila3 = marcarAnulacionesPendientes(local.historial, lectura.anulaciones).find((f) => f.pesajeId === '3');
  assert.equal(fila3.estadoRegistro, 'ACTIVO', 'no se inventa un ANULADO del servidor');
  assert.equal(fila3.anulacion, null);
  assert.equal(estadoAnulacionPendiente(fila3.anulacionPendiente).etiqueta, ETIQUETA_ANULACION_PENDIENTE);
  assert.equal(local.resumen.ultimoPesoKg, 210);
  assert.equal(local.provisional, true);
  assert.equal(fila3.gmdKgDia, null, 'sin derivaciones mientras está pendiente');
});

test('4. ANULADO confirmado: fecha/peso original, motivo, fecha de anulación y "No participa en los cálculos."', async () => {
  const { repo } = await dispositivo([...BASE.slice(0, 2), { pesajeId: '3', fecha: '2026-10-21', pesoKg: 225, estadoRegistro: 'ANULADO', anulacion: { anuladoEn: '2026-11-05T15:00:00.000Z', motivo: 'Báscula descalibrada' } }]);
  const local = vista(await repo.leerPesajesLocales('7'));
  const f = local.historial.find((x) => x.pesajeId === '3');
  assert.equal(f.pesoKg, 225);
  assert.equal(f.fecha, '2026-10-21');
  const v = presentarFilaHistorial(f);
  assert.equal(v.etiquetaEstado, 'Anulado');
  assert.match(v.notaCalculo, /Anulado el 05\/11\/2026\. Motivo: Báscula descalibrada\. No participa en los cálculos\./);
  assert.equal(local.resumen.ultimoPesoKg, 210);
});

// ---------------------------------------------------------------------------------
// 5-7. Cancelación segura vs. incierto vs. legacy
// ---------------------------------------------------------------------------------

test('5. "Cancelar registro pendiente" solo si el MOTOR lo permite, de esta cuenta y con permiso de registro', async () => {
  const { repo } = await dispositivo(BASE);
  await crear(repo, 1);
  const [p] = (await repo.leerPesajesLocales('7')).pendientes;
  assert.equal(p.cancelableSeguro, true);
  const de = (rol, cuentaId = CUENTA_A) => accionesPesajePendiente(p, { cuentaId, puedeRegistrar: capacidadesDe(rol).registrarPesaje, puedeAnular: capacidadesDe(rol).anularPesaje });
  assert.equal(de('owner').cancelar, true);
  assert.equal(de('operador').cancelar, true, 'su propio registro: no requiere privilegio administrativo');
  assert.equal(de('lector').cancelar, false);
  assert.equal(de('owner', CUENTA_B).cancelar, false, 'otra cuenta: nunca');
  assert.equal(de('owner').anularDiferida, false, 'nunca salió: no se anula, se cancela');
  assert.match(ADVERTENCIA_CANCELAR_PENDIENTE, /aún no fue enviado al servidor y puede retirarse de este dispositivo/);
  // Cancelar: 0 POST (el motor no tiene transporte aquí), sin ANULAR, desaparece de la vista.
  await repo.cancelarPesajePendiente(p.localOperationId, { cuentaId: CUENTA_A });
  const despues = await repo.leerPesajesLocales('7');
  assert.deepEqual(despues.pendientes, []);
  assert.deepEqual(despues.anulaciones, []);
  assert.match(pendientesJsx, />\s*Cancelar registro pendiente\s*</);
  assert.doesNotMatch(pendientesJsx, />\s*Anular\s*</, 'la cancelación nunca se llama "Anular"');
});

async function createIncierto(repo, storage, n) {
  const r = await crear(repo, n);
  await storage.mutate('outbox', r.operationId, (op) => ({ ...op, estado: OUTBOX_ESTADOS.ERROR_REINTENTABLE, posibleEnServidor: true, ultimoError: { codigo: 'NETWORK_ERROR', status: 0, tipo: 'red' } }));
  return r;
}

test('6. posibleEnServidor=true: no cancelable; "Pendiente de confirmar"; owner/admin pueden pedir anulación diferida', async () => {
  const { repo, storage } = await dispositivo(BASE);
  await createIncierto(repo, storage, 1);
  const [p] = (await repo.leerPesajesLocales('7')).pendientes;
  assert.equal(p.cancelableSeguro, false);
  assert.equal(estadoPesajePendiente(p).etiqueta, 'Pendiente de confirmar');
  assert.match(estadoPesajePendiente(p).detalle, /Pendiente de confirmar con el servidor\./);
  for (const rol of ['owner', 'admin']) {
    const a = accionesPesajePendiente(p, { cuentaId: CUENTA_A, puedeRegistrar: true, puedeAnular: capacidadesDe(rol).anularPesaje });
    assert.deepEqual([a.cancelar, a.anularDiferida], [false, true], rol);
  }
  for (const rol of ['operador', 'lector']) {
    assert.equal(accionesPesajePendiente(p, { cuentaId: CUENTA_A, puedeRegistrar: capacidadesDe(rol).registrarPesaje, puedeAnular: capacidadesDe(rol).anularPesaje }).anularDiferida, false, rol);
  }
  // Diferida: se encola por pesajeRef y queda visible en el pendiente; no se ofrece otra.
  await anular(repo, { pesajeRef: { clientOperationId: p.clientOperationId } });
  const lectura = await repo.leerPesajesLocales('7');
  assert.deepEqual(lectura.anulaciones.map((a) => [a.pesajeId, a.diferida]), [[null, true]]);
  assert.match(estadoAnulacionPendiente(lectura.anulaciones[0]).detalle, /se enviará cuando el servidor confirme este pesaje/);
  const otra = accionesPesajePendiente(lectura.pendientes[0], { cuentaId: CUENTA_A, puedeRegistrar: true, puedeAnular: true, anulaciones: lectura.anulaciones });
  assert.deepEqual([otra.anularDiferida, otra.anulacionSolicitada], [false, true]);
});

test('7. CREATE legacy (sin origen): nunca cancelable; "Pendiente de confirmar"', async () => {
  const { repo, storage } = await dispositivo(BASE);
  await storage.put('outbox', newOperation({
    tipoOperacion: PESAJE_CREAR, entidad: 'pesaje', localUuid: 'l-1', clientOperationId: ID(9),
    payload: { animalId: '7', fecha: '2026-11-01', pesoKg: 230, metodo: 'BASCULA', observaciones: null, clientOperationId: ID(9) },
    deviceId: 'd-0', now: new Date('2026-11-01T00:00:00.000Z'), uuid: () => 'legacy-9',
  }));
  const [p] = (await repo.leerPesajesLocales('7')).pendientes;
  assert.equal(p.legacy, true);
  assert.equal(p.cancelableSeguro, false);
  assert.equal(accionesPesajePendiente(p, { cuentaId: CUENTA_A, puedeRegistrar: true, puedeAnular: true }).cancelar, false);
  assert.equal(estadoPesajePendiente(p).etiqueta, 'Pendiente de confirmar');
});

// ---------------------------------------------------------------------------------
// 8-13. Roles, doble acción e idempotencia
// ---------------------------------------------------------------------------------

test('8-11. Anular: owner y admin sí; operador y lector no ven la acción (online y sin conexión)', () => {
  const activo = { pesajeId: '3', estadoRegistro: 'ACTIVO' };
  for (const [rol, visible] of [['owner', true], ['admin', true], ['operador', false], ['lector', false]]) {
    const puedeAnular = capacidadesDe(rol).anularPesaje;
    assert.equal(accionAnularPesaje({ puedeAnular, pesaje: activo }).visible, visible, `${rol} online`);
    const offline = accionAnularPesaje({ puedeAnular, pesaje: activo, online: false, puedeEncolar: true });
    assert.equal(offline.visible, visible, `${rol} offline`);
    if (visible) assert.equal(offline.habilitado, true, 'sin conexión se encola en el motor');
  }
  // Sin motor offline: bloqueada con aviso (comportamiento previo).
  assert.deepEqual(accionAnularPesaje({ puedeAnular: true, pesaje: activo, online: false }), { visible: true, habilitado: false, motivoBloqueo: MENSAJE_ANULACION_REQUIERE_CONEXION });
});

test('12. doble clic: una sola operación (guardas en la UI + clave única del motor)', async () => {
  const { repo } = await dispositivo(BASE);
  const resultados = await Promise.allSettled([anular(repo, { pesajeId: '3', clientOperationId: ID(60) }), anular(repo, { pesajeId: '3', clientOperationId: ID(61) })]);
  assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(resultados.find((r) => r.status === 'rejected').reason.code, 'OPERACION_ADMINISTRATIVA_PENDIENTE');
  assert.equal((await repo.leerPesajesLocales('7')).anulaciones.length, 1);
  assert.match(panel, /if \(!controlador \|\| controlador\.enCurso\) return;/);
  assert.match(panel, /controlador\.enCurso = true;/);
  assert.match(panel, /if \(accionLocalRef\.current\) return;/);
  assert.match(dialogo, /disabled=\{enviando\}/);
  assert.match(pendientesJsx, /disabled=\{ocupado\}/);
});

test('13. ANULAR existente: no se ofrece otra (fila marcada) y el motor no duplica', async () => {
  const { repo } = await dispositivo(BASE);
  await anular(repo, { pesajeId: '3' });
  const lectura = await repo.leerPesajesLocales('7');
  const fila3 = marcarAnulacionesPendientes(vista(lectura).historial, lectura.anulaciones).find((f) => f.pesajeId === '3');
  assert.equal(accionAnularPesaje({ puedeAnular: true, pesaje: fila3, online: false, puedeEncolar: true }).visible, false);
  await assert.rejects(anular(repo, { pesajeId: '3', clientOperationId: ID(70) }), (e) => {
    assert.equal(mensajeAccionOffline(e), 'Este pesaje ya tiene una anulación pendiente en este dispositivo.');
    return true;
  });
  // También en el historial del SERVIDOR (online con una anulación aún pendiente).
  const servidor = [{ pesajeId: '3', estadoRegistro: 'ACTIVO' }, { pesajeId: '2', estadoRegistro: 'ACTIVO' }];
  const marcadas = marcarAnulacionesPendientes(servidor, lectura.anulaciones);
  assert.ok(marcadas[0].anulacionPendiente);
  assert.equal(marcadas[1].anulacionPendiente, undefined);
});

// ---------------------------------------------------------------------------------
// 14-16. Identidad, conflicto, rechazo
// ---------------------------------------------------------------------------------

test('14. bloqueado por identidad: mensaje claro, sin forzar envío', () => {
  const create = estadoPesajePendiente({ estado: 'BLOQUEADA_POR_IDENTIDAD', ultimoError: { codigo: 'IDENTIDAD_NO_COINCIDE' } });
  assert.deepEqual(create, { etiqueta: 'Bloqueado por cambio de cuenta', detalle: MENSAJE_IDENTIDAD_OPERACION, bloqueado: true });
  assert.equal(MENSAJE_IDENTIDAD_OPERACION, 'Esta operación fue creada con otra cuenta u organización y no se enviará desde la sesión actual.');
  const anul = estadoAnulacionPendiente({ estado: 'BLOQUEADA_POR_IDENTIDAD', pesajeId: '3', ultimoError: { codigo: 'IDENTIDAD_NO_COINCIDE' } });
  assert.equal(anul.etiqueta, 'Bloqueado por cambio de cuenta');
  assert.equal(anul.detalle, MENSAJE_IDENTIDAD_OPERACION);
  // Bloqueada: ni cancelar (otra cuenta) ni pedir anulación diferida.
  const a = accionesPesajePendiente({ estado: 'BLOQUEADA_POR_IDENTIDAD', cancelableSeguro: false, posibleEnServidor: true, cuentaOrigenId: CUENTA_B }, { cuentaId: CUENTA_A, puedeRegistrar: true, puedeAnular: true });
  assert.deepEqual([a.cancelar, a.anularDiferida], [false, false]);
  assert.doesNotMatch(pendientesJsx + historialJsx, /syncNow|forzar|reintentar/i, 'sin acción para forzar el envío');
});

test('15/16. conflicto y rechazo: mensajes por código, nunca solo el código', () => {
  const conflicto = estadoAnulacionPendiente({ estado: 'CONFLICTO', pesajeId: '3', ultimoError: { codigo: 'PESAJE_YA_ANULADO' } });
  assert.equal(conflicto.etiqueta, 'Conflicto');
  assert.match(conflicto.detalle, /ya tenía este pesaje anulado por otra solicitud/);
  const reusado = estadoPesajePendiente({ estado: 'CONFLICTO', ultimoError: { codigo: 'CLIENT_OPERATION_ID_REUSED' } });
  assert.equal(reusado.detalle, 'Este registro ya existe en el servidor con otros datos.');
  const rechazo = estadoAnulacionPendiente({ estado: 'RECHAZADO', pesajeId: '3', ultimoError: { codigo: 'ROLE_FORBIDDEN' } });
  assert.equal(rechazo.etiqueta, 'Rechazado');
  assert.doesNotMatch(rechazo.detalle, /ROLE_FORBIDDEN/);
  for (const code of ['PESAJE_YA_ANULADO', 'CLIENT_OPERATION_ID_REUSED', 'INVALID_MOTIVO', 'ROLE_FORBIDDEN', 'PESAJE_ENVIO_INCIERTO', 'PESAJE_CANCELABLE_LOCALMENTE', 'OPERACION_ADMINISTRATIVA_PENDIENTE', 'X_DESCONOCIDO']) {
    const m = mensajeAccionOffline({ code });
    assert.ok(m.length > 10, code);
    assert.doesNotMatch(m, /[A-Z]{3,}_[A-Z]{3,}/, `sin código interno: ${code}`);
  }
  assert.equal(estadoPesajePendiente({ estado: 'RECHAZADO', ultimoError: { codigo: 'INVALID_PESO' } }).etiqueta, 'Rechazado');
});

// ---------------------------------------------------------------------------------
// 17-19. Último peso
// ---------------------------------------------------------------------------------

test('17. anular el último: la ficha offline muestra el anterior (provisional) y los KPIs también', async () => {
  const { repo } = await dispositivo(BASE);
  const animal = { animalId: '7', ultimoPeso: { pesoKg: 225, fecha: '2026-10-21', metodo: 'BASCULA' } };
  await anular(repo, { pesajeId: '3' });
  const pesoLocal = { animalId: '7', ...(await repo.ultimoPesoLocal('7')) };
  const ficha = presentarUltimoPesoFicha({ animal, pesoLocal, online: false });
  assert.equal(ficha.ultimoPeso.pesoKg, 210);
  assert.match(ficha.nota, /Provisional/);
  assert.equal(vista(await repo.leerPesajesLocales('7')).resumen.ultimoPesoKg, 210);
  // Con conexión manda la ficha del servidor; nunca se toca animal.updatedAt.
  assert.equal(presentarUltimoPesoFicha({ animal, pesoLocal, online: true }).ultimoPeso.pesoKg, 225);
  assert.doesNotMatch(detalle + panel, /updatedAt/);
});

test('18. mismo día: último por pesajeId (ficha y KPIs coinciden)', async () => {
  const { repo } = await dispositivo([...BASE, { pesajeId: '10', fecha: '2026-10-21', pesoKg: 227 }, { pesajeId: '9', fecha: '2026-10-21', pesoKg: 226 }]);
  const pesoLocal = { animalId: '7', ...(await repo.ultimoPesoLocal('7')) };
  assert.equal(presentarUltimoPesoFicha({ animal: { animalId: '7' }, pesoLocal, online: false }).ultimoPeso.pesoKg, 227);
  assert.equal(vista(await repo.leerPesajesLocales('7')).resumen.ultimoPesoKg, 227);
});

test('19. copia incompleta: sin historial/KPIs locales y respaldo animal.ultimoPeso', async () => {
  const { repo } = await dispositivo(BASE, { completa: false });
  const lectura = await repo.leerPesajesLocales('7');
  assert.equal(lectura.copiaCompleta, false);
  assert.equal(vista(lectura), null, 'no se fabrica historial ni GMD con una copia parcial');
  const animal = { animalId: '7', ultimoPeso: { pesoKg: 999, fecha: '2026-01-01', metodo: 'ESTIMADO' } };
  const ficha = presentarUltimoPesoFicha({ animal, pesoLocal: { animalId: '7', ...lectura.ultimoPeso }, online: false });
  assert.equal(ficha.ultimoPeso.pesoKg, 999);
  assert.match(ficha.nota, /no tiene la copia completa/);
  assert.match(panel, /TEXTO_SIN_COPIA_LOCAL/);
});

// ---------------------------------------------------------------------------------
// 20-24. PDF, transiciones, refresco, ids internos, no regresión online
// ---------------------------------------------------------------------------------

test('20. PDF: deshabilitado sin conexión con el texto acordado; nunca local', () => {
  assert.equal(AVISO_REPORTE_SIN_CONEXION, 'Conéctate a internet para generar el PDF actualizado.');
  assert.match(reporteBoton, /disabled=\{descargando \|\| !online\}/);
  assert.match(panel, /<HatoReporteProductivoBoton animalId=\{animalId\} online=\{online\} \/>/);
  assert.doesNotMatch(panel + src('../pesajesOfflineVista.js'), /jspdf|pdfmake|generarPdf/i);
});

test('21. transición online/offline: sin conexión (o sin respuesta) usa la copia local completa; con conexión, el servidor', () => {
  assert.match(panel, /const usarLocal = Boolean\(vistaLocal\) && \(!online \|\| state\.status === 'error'\);/);
  assert.match(panel, /const datos = usarLocal \? vistaLocal : state\.data;/);
  assert.match(panel, /const anularOffline = !online && Boolean\(repoOffline\);/);
  assert.match(detalle, /if \(offline\.online \|\| esLocal \|\| !repoOrg \|\| !animalIdServidor/);
});

test('22. refresco tras sincronizar: desaparecer CUALQUIER operación (CREATE o ANULAR) recarga sin reload', () => {
  assert.match(panel, /const actuales = idsPendientes\(\[\.\.\.lista, \.\.\.lectura\.anulaciones\]\);/);
  assert.match(panel, /if \(confirmadas\) \{\s*await cargar\(\);\s*onRegistradoRef\.current\?\.\(\);/);
  assert.match(panel, /repoOffline\.subscribe\(/);
  assert.match(panel, /const hayPendientes = pendientes\.length > 0 \|\| \(local\?\.anulaciones\?\.length \?\? 0\) > 0;/);
  assert.match(detalle, /repoOrg\.subscribe\?\.\(leer\)/);
});

test('23. nunca se muestran ids internos ni nombres técnicos', async () => {
  const { repo, storage } = await dispositivo(BASE);
  await crear(repo, 1);
  await createIncierto(repo, storage, 2);
  await anular(repo, { pesajeId: '3' });
  const lectura = await repo.leerPesajesLocales('7');
  const textos = [
    ...lectura.pendientes.flatMap((p) => Object.values(estadoPesajePendiente(p))),
    ...lectura.anulaciones.flatMap((a) => Object.values(estadoAnulacionPendiente(a))),
    ADVERTENCIA_CANCELAR_PENDIENTE,
  ].filter((t) => typeof t === 'string');
  for (const t of textos) {
    assert.doesNotMatch(t, UUID);
    assert.doesNotMatch(t, /posibleEnServidor|operationId|outbox|PESAJE_(CREAR|ANULAR)/);
  }
  // Los componentes solo usan ids como `key`, nunca como texto visible.
  for (const jsx of [pendientesJsx, historialJsx, dialogo]) {
    assert.doesNotMatch(jsx, /(?<!key=)\{\s*\w+\.(clientOperationId|localOperationId|operationId|refClientOperationId|cuentaOrigenId)\s*\}/);
    assert.doesNotMatch(jsx, /posibleEnServidor/);
  }
});

test('24. sin regresión online: historial del servidor intacto sin anulaciones pendientes; POST directo de 5A.2', () => {
  const servidor = [{ pesajeId: '1', estadoRegistro: 'ACTIVO' }];
  assert.equal(marcarAnulacionesPendientes(servidor, []), servidor);
  assert.deepEqual(accionAnularPesaje({ puedeAnular: true, pesaje: { pesajeId: '1', estadoRegistro: 'ACTIVO' } }), { visible: true, habilitado: true, motivoBloqueo: null });
  assert.match(panel, /enviar: \(\{ clientOperationId, motivo \}\) => anularPesaje\(animalId, pesaje\.pesajeId, buildAnularPesajeBody\(\{/);
  assert.match(panel, /if \(!online \|\| pesaje\.pendiente\) \{\s*controladorRef\.current = \{ modo: 'offline', enCurso: false \};/);
  assert.match(dialogo, /offline \? 'Guardar anulación' : 'Anular pesaje'/);
});
