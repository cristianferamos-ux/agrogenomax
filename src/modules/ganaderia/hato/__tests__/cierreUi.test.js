// FASE 2B: UI de salidas/muertes, situación del animal y RBAC en la ficha.
// Modelo puro + invariantes por fuente (no hay jsdom en el repo), como el
// resto de pruebas de hato/. Cubre: visibilidad de botones (4 roles, ejes,
// offline), textos exactos, validaciones, idempotencia, 403 ROLE_FORBIDDEN,
// listado + fallback offline, pesajes y QR en animales cerrados, QR
// NO_OPERATIVO, timeline y outbox ANIMAL_YA_*.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CIERRE_CONFIG,
  ERRORES_CIERRE,
  MENSAJE_CIERRE_OFFLINE,
  MENSAJE_QR_HISTORICA,
  TEXTO_SIN_ALERTAS_CERRADO,
  accionesCierre,
  bloqueSituacion,
  buildCierreBody,
  chapetaHistoricaDeCierre,
  crearControlOperacion,
  firmaCierre,
  mensajePesajesCerrado,
  resultadoCierre,
  situacionDe,
  textoAlertaCierre,
  validarCierre,
  FILTROS_SITUACION,
  FILTROS_ESTADO_REGISTRO,
  FILTROS_LISTADO_DEFAULT,
} from '../cierreModel.js';
import { resultadoRegistro } from '../pesajesModel.js';
import { mensajeBloqueoPesaje, estadoPesajePendiente } from '../pesajesOfflineModel.js';
import { etiquetaTipoEvento } from '../actividadModel.js';
import { qrResolutionOutcome } from '../qrToken.js';
import { classifyResult } from '../../offline/syncEngine.js';
import { createMemoryStorage } from '../../offline/storage.js';
import { createLocalRepo } from '../../offline/localRepo.js';
import { ORG_STORES } from '../../offline/offlineSchema.js';
import { etiquetaEstadoOperativoAnimal } from '../../admin/adminQrModel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HATO_DIR = path.resolve(__dirname, '..');
const GANADERIA_DIR = path.resolve(HATO_DIR, '..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const leer = (...p) => strip(fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n'));
const cierre = leer(HATO_DIR, 'HatoCierreAnimal.jsx');
const detalle = leer(HATO_DIR, 'HatoDetallePage.jsx');
const pesajesPanel = leer(HATO_DIR, 'HatoPesajesPanel.jsx');
const qrPanel = leer(HATO_DIR, 'HatoQrPanel.jsx');
const lista = leer(HATO_DIR, 'HatoListaPage.jsx');
const resolver = leer(HATO_DIR, 'HatoQrResolverPage.jsx');
// hatoApi.js menciona "/api/ganaderia/*" en un comentario: se lee sin strip.
const api = fs.readFileSync(path.join(HATO_DIR, 'hatoApi.js'), 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(path.join(GANADERIA_DIR, 'styles', 'ganaderia-hato.css'), 'utf8');

const ANIMAL = Object.freeze({ animalId: '7', estado: 'ACTIVO', estadoOperativo: 'EN_HATO', fechaNacimiento: '2024-01-10', fechaIngreso: '2024-03-01', ultimoPeso: { pesoKg: 360, fecha: '2026-10-01' } });
const HOY = '2026-10-30';
const FORM_OK = Object.freeze({ fecha: '2026-10-20', causa: 'VENTA', observaciones: '' });

// ---------------------------------------------------------------------------
// F. Visibilidad de botones
// ---------------------------------------------------------------------------

test('botones: solo ACTIVO + EN_HATO + owner|admin; operador/lector/sin rol nunca', () => {
  for (const rol of ['owner', 'admin']) {
    assert.deepEqual(accionesCierre({ animal: ANIMAL, rol, online: true }), { visible: true, habilitado: true, aviso: null }, rol);
  }
  for (const rol of ['operador', 'lector', null, undefined, 'super_admin']) {
    assert.equal(accionesCierre({ animal: ANIMAL, rol, online: true }).visible, false, String(rol));
  }
});

test('botones: ANULADO, SALIDO, MUERTO o registro local -> ocultos (ACTIVO no implica EN_HATO)', () => {
  assert.equal(accionesCierre({ animal: { ...ANIMAL, estado: 'ANULADO' }, rol: 'owner', online: true }).visible, false);
  assert.equal(accionesCierre({ animal: { ...ANIMAL, estadoOperativo: 'SALIDO' }, rol: 'owner', online: true }).visible, false);
  assert.equal(accionesCierre({ animal: { ...ANIMAL, estadoOperativo: 'MUERTO' }, rol: 'admin', online: true }).visible, false);
  assert.equal(accionesCierre({ animal: ANIMAL, rol: 'owner', online: true, esLocal: true }).visible, false);
});

test('botones offline: visibles pero deshabilitados con el copy exacto', () => {
  assert.equal(MENSAJE_CIERRE_OFFLINE, 'Registrar salida o muerte requiere conexión.');
  assert.deepEqual(accionesCierre({ animal: ANIMAL, rol: 'owner', online: false }), { visible: true, habilitado: false, aviso: MENSAJE_CIERRE_OFFLINE });
  assert.match(cierre, /disabled=\{!acciones\.habilitado\}/);
  assert.match(cierre, />\s*Registrar salida\s*</);
  assert.match(cierre, />\s*Registrar muerte\s*</);
});

test('la ficha toma el rol de la organización activa (sesión) y nunca muestra cierres para registros locales', () => {
  assert.match(detalle, /auth\?\.organizacionActiva\?\.rol/);
  assert.match(detalle, /<HatoCierreAnimal[\s\S]*?rol=\{rol\}[\s\S]*?online=\{offline\.online\}/);
  assert.match(detalle, /\{!esLocal \? \(\s*<HatoCierreAnimal/);
});

// ---------------------------------------------------------------------------
// D/E. Dos ejes y bloque Situación
// ---------------------------------------------------------------------------

test('situación con fallback EN_HATO; nunca se deriva de estado ACTIVO', () => {
  assert.equal(situacionDe({ estado: 'ACTIVO' }), 'EN_HATO');
  assert.equal(situacionDe({ estado: 'ANULADO', estadoOperativo: 'SALIDO' }), 'SALIDO');
  assert.equal(situacionDe({ estadoOperativo: 'X' }), 'EN_HATO');
  assert.match(detalle, /label="Estado del registro"/);
  assert.match(detalle, /label="Situación del animal"/);
});

test('bloque Situación: En hato / Salido (fecha, motivo, obs) / Muerto (fecha, causa, obs), también ANULADO', () => {
  assert.deepEqual(bloqueSituacion(ANIMAL), { situacion: 'EN_HATO', titulo: 'En hato', filas: [] });
  const salido = bloqueSituacion({ ...ANIMAL, estado: 'ANULADO', estadoOperativo: 'SALIDO', cierre: { tipo: 'SALIDA', fecha: '2026-10-20', causa: 'VENTA', observaciones: 'Feria' } });
  assert.equal(salido.titulo, 'Salido');
  assert.deepEqual(salido.filas, [['Fecha', '20/10/2026'], ['Motivo', 'Venta'], ['Observaciones', 'Feria']]);
  const muerto = bloqueSituacion({ ...ANIMAL, estadoOperativo: 'MUERTO', cierre: { tipo: 'MUERTE', fecha: '2026-10-21', causa: 'DEPREDACION', observaciones: null } });
  assert.equal(muerto.titulo, 'Muerto');
  assert.deepEqual(muerto.filas, [['Fecha', '21/10/2026'], ['Causa', 'Depredación']]);
});

// ---------------------------------------------------------------------------
// G/H/I. Formularios y confirmación
// ---------------------------------------------------------------------------

test('catálogos y textos de botones exactos', () => {
  assert.deepEqual(CIERRE_CONFIG.SALIDA.opciones.map((o) => o.value), ['VENTA', 'TRASLADO', 'DONACION', 'INTERCAMBIO', 'DEVOLUCION', 'OTRA']);
  assert.deepEqual(CIERRE_CONFIG.MUERTE.opciones.map((o) => o.value), ['MUERTE_NATURAL', 'ENFERMEDAD', 'ACCIDENTE', 'SACRIFICIO', 'DEPREDACION', 'DESCONOCIDA', 'OTRA']);
  assert.equal(CIERRE_CONFIG.SALIDA.textoConfirmar, 'Confirmar salida');
  assert.equal(CIERRE_CONFIG.MUERTE.textoConfirmar, 'Confirmar muerte');
  assert.equal(CIERRE_CONFIG.SALIDA.textoEnviando, 'Registrando salida...');
  assert.equal(CIERRE_CONFIG.MUERTE.textoEnviando, 'Registrando muerte...');
});

test('alertdialog: textos exactos; sin QR activa se omite la frase de la chapeta', () => {
  assert.equal(textoAlertaCierre('SALIDA', { tieneQrActiva: true }), 'Esta acción registrará que el animal salió del hato y dejará su chapeta QR fuera de operación. El historial del animal se conservará. Esta acción no puede revertirse en esta versión.');
  assert.equal(textoAlertaCierre('SALIDA', { tieneQrActiva: false }), 'Esta acción registrará que el animal salió del hato. El historial del animal se conservará. Esta acción no puede revertirse en esta versión.');
  assert.equal(textoAlertaCierre('MUERTE'), 'Esta acción registrará al animal como muerto. No podrán registrarse nuevos pesajes ni asignarse nuevas chapetas QR. La chapeta actual quedará fuera de operación y el historial se conservará. Esta acción no puede revertirse en esta versión.');
});

test('alertdialog accesible: aria-modal, foco inicial en Cancelar, focus trap, ESC, retorno de foco, aria-live', () => {
  assert.match(cierre, /role="alertdialog"/);
  assert.match(cierre, /aria-modal="true"/);
  assert.match(cierre, /aria-labelledby="cierre-dialog-titulo"/);
  assert.match(cierre, /aria-describedby="cierre-dialog-texto"/);
  assert.match(cierre, /cancelarRef\.current\?\.focus\(\)/);
  assert.match(cierre, /<button ref=\{cancelarRef\}[^>]*>\s*Cancelar/);
  assert.match(cierre, /event\.key === 'Escape'/);
  assert.match(cierre, /event\.key !== 'Tab'/);
  assert.match(cierre, /abridorRef\.current/);
  assert.match(cierre, /aria-live="polite"/);
  assert.match(cierre, /aria-invalid=\{err\('fecha'\)/);
  assert.match(cierre, /aria-describedby=\{describedBy\('causa'\)\}/);
  assert.match(cierre, /htmlFor="cierre-observaciones"/);
});

test('flujo en dos pasos: formulario -> Revisar -> diálogo; doble submit bloqueado', () => {
  assert.match(cierre, /<button type="submit" className="gan-submit">Revisar<\/button>/);
  assert.match(cierre, /setPaso\('revisar'\)/);
  assert.match(cierre, /onClick=\{abrirDialogo\}/);
  assert.match(cierre, /if \(enviandoRef\.current \|\| !online\) return;/);
  assert.match(cierre, /disabled=\{enviando\}/);
});

// ---------------------------------------------------------------------------
// K. Validaciones de cliente
// ---------------------------------------------------------------------------

test('validaciones: textos exactos', () => {
  const v = (form, animal = ANIMAL, tipo = 'SALIDA') => validarCierre(tipo, { ...FORM_OK, ...form }, { hoy: HOY, animal }).errores;
  assert.deepEqual(v({}), {});
  assert.equal(v({ fecha: '2026-10-31' }).fecha, 'La fecha no puede ser futura.');
  assert.equal(v({ fecha: '2024-01-01' }).fecha, 'La fecha no puede ser anterior a la fecha de nacimiento.');
  assert.equal(v({ fecha: '2024-02-01' }).fecha, 'La fecha no puede ser anterior a la fecha de ingreso.');
  assert.equal(v({ fecha: '2026-09-30' }).fecha, 'La fecha no puede ser anterior al último pesaje registrado.');
  assert.equal(v({ causa: '' }).causa, 'Selecciona un motivo.');
  assert.equal(v({ causa: 'VENTA' }, ANIMAL, 'MUERTE').causa, 'Selecciona una causa.');
  assert.equal(v({ observaciones: 'a'.repeat(501) }).observaciones, 'Las observaciones admiten máximo 500 caracteres.');
  assert.deepEqual(v({ observaciones: `  ${'a'.repeat(500)}  ` }), {}, 'se cuentan sin espacios de borde, como el servidor');
  assert.equal(ERRORES_CIERRE.FECHA_FUTURA, 'La fecha no puede ser futura.');
});

test('body: campos por tipo; OTRA usa observaciones (sin campo extra); sin organizacionId', () => {
  assert.deepEqual(buildCierreBody('SALIDA', { fecha: '2026-10-20', causa: 'OTRA', observaciones: ' Permuta \r\n' }, 'op-1'), {
    fechaSalida: '2026-10-20', motivoSalida: 'OTRA', clientOperationId: 'op-1', observaciones: 'Permuta',
  });
  assert.deepEqual(buildCierreBody('MUERTE', { fecha: '2026-10-20', causa: 'ENFERMEDAD', observaciones: '' }, 'op-2'), {
    fechaMuerte: '2026-10-20', causaMuerte: 'ENFERMEDAD', clientOperationId: 'op-2',
  });
});

// ---------------------------------------------------------------------------
// J. Idempotencia de la UI
// ---------------------------------------------------------------------------

test('idempotencia: el id nace en Revisar y se conserva en reintento / incierto / 5xx', () => {
  let n = 0;
  const control = crearControlOperacion(() => `op-${++n}`);
  const firma = firmaCierre('SALIDA', FORM_OK);
  assert.equal(control.id, null);
  assert.equal(control.revisar(firma), 'op-1');
  for (const r of [null, { ok: false, status: 0, data: { error: 'NETWORK_ERROR' } }, { ok: false, status: 502, data: null }, { ok: false, status: 0, data: { error: 'CSRF_UNAVAILABLE' }, failure: 'REQUEST_NOT_SENT' }]) {
    const resultado = resultadoCierre('SALIDA', r);
    assert.equal(resultado.exito, false);
    assert.equal(resultado.descartarOperacion, false, resultado.tipo);
    assert.equal(control.revisar(firma), 'op-1', `se conserva tras ${resultado.tipo}`);
  }
});

test('idempotencia: id nuevo solo tras éxito confirmado (también 200 yaExistia), cancelación o cambio de datos', () => {
  let n = 0;
  const control = crearControlOperacion(() => `op-${++n}`);
  const firma = firmaCierre('SALIDA', FORM_OK);
  control.revisar(firma);
  assert.equal(control.revisar(firmaCierre('SALIDA', { ...FORM_OK, causa: 'TRASLADO' })), 'op-2', 'cambio de datos');
  control.descartar();
  assert.equal(control.revisar(firma), 'op-3', 'cancelación');
  const yaExistia = resultadoCierre('SALIDA', { ok: true, status: 200, data: { ok: true, yaExistia: true, animal: { animalId: '7' } } });
  assert.equal(yaExistia.exito, true);
  assert.equal(yaExistia.descartarOperacion, true);
  assert.equal(resultadoCierre('SALIDA', { ok: true, status: 201, data: { ok: true, yaExistia: false, animal: {} } }).tipo, 'CREADO');
  control.descartar();
  assert.equal(control.revisar(firma), 'op-4', 'tras éxito');
  // El componente sigue exactamente estas reglas.
  assert.match(cierre, /if \(resultado\.descartarOperacion\) controlRef\.current\.descartar\(\);/);
  assert.match(cierre, /function cancelarDialogo\(\) \{[\s\S]*?controlRef\.current\.descartar\(\);/);
  assert.match(cierre, /function update\(campo, valor\) \{[\s\S]*?controlRef\.current\.descartar\(\);/);
  assert.match(cierre, /controlRef\.current\.revisar\(firmaCierre\(tipo, form\)\)/);
});

// ---------------------------------------------------------------------------
// C. 403 ROLE_FORBIDDEN vs 401 sesión vs 403 CSRF
// ---------------------------------------------------------------------------

test('403 ROLE_FORBIDDEN -> "No tienes permisos..." (nunca sesión expirada); 401 -> sesión; 403 CSRF -> validación', () => {
  const permisos = resultadoCierre('SALIDA', { ok: false, status: 403, data: { error: 'ROLE_FORBIDDEN' }, failure: 'ROLE_FORBIDDEN' });
  assert.equal(permisos.tipo, 'PERMISOS');
  assert.equal(permisos.mensaje, 'No tienes permisos para realizar esta acción.');
  assert.doesNotMatch(permisos.mensaje, /sesión/i);
  assert.equal(resultadoCierre('SALIDA', { ok: false, status: 401, data: { error: 'SESSION_REQUIRED' }, failure: 'SESSION_EXPIRED' }).tipo, 'SESION');
  assert.equal(resultadoCierre('SALIDA', { ok: false, status: 403, data: { error: 'CSRF_INVALID' }, failure: 'CSRF_REJECTED' }).tipo, 'CSRF');
  const pesaje = resultadoRegistro({ ok: false, status: 403, data: { error: 'ROLE_FORBIDDEN' }, failure: 'ROLE_FORBIDDEN' });
  assert.equal(pesaje.mensaje, 'No tienes permisos para realizar esta acción.');
});

test('409 del cierre: ya salido / ya muerto / anulado recargan la ficha; REUSED descarta el id', () => {
  for (const code of ['ANIMAL_YA_SALIDO', 'ANIMAL_YA_MUERTO', 'ANIMAL_ANULADO']) {
    const r = resultadoCierre('MUERTE', { ok: false, status: 409, data: { error: code } });
    assert.equal(r.recargarFicha, true, code);
  }
  assert.equal(resultadoCierre('MUERTE', { ok: false, status: 409, data: { error: 'CLIENT_OPERATION_ID_REUSED' } }).descartarOperacion, true);
  assert.equal(resultadoCierre('SALIDA', { ok: false, status: 400, data: { error: 'INVALID_FECHA' } }).campo, 'fecha');
});

// ---------------------------------------------------------------------------
// L/M/N. Listado y fallback offline
// ---------------------------------------------------------------------------

test('filtros del listado: Situación (En hato por defecto) y Estado del registro (Activos por defecto)', () => {
  assert.deepEqual(FILTROS_SITUACION.map((f) => f.label), ['En hato', 'Salidos', 'Muertos', 'Todos']);
  assert.deepEqual(FILTROS_ESTADO_REGISTRO.map((f) => f.label), ['Activos', 'Anulados', 'Todos']);
  assert.deepEqual(FILTROS_LISTADO_DEFAULT, { estado: 'ACTIVO', estadoOperativo: 'EN_HATO' });
  assert.match(lista, /id="filtro-situacion"/);
  assert.match(lista, /id="filtro-estado-registro"/);
  assert.match(lista, /getResumenAnimales\(\)/);
  assert.match(api, /if \(estadoOperativo\) params\.set\('estadoOperativo', estadoOperativo\);/);
  assert.match(api, /\/animales\/resumen/);
});

test('localRepo.listAnimales: default EN_HATO, SALIDO, MUERTO, TODOS; sin estadoOperativo en caché = EN_HATO', async () => {
  const storage = createMemoryStorage(ORG_STORES);
  const animal = (id, extra) => ({ key: `srv:${id}`, animalId: id, estado: 'ACTIVO', numeroVisual: id, fechaCreacion: `2026-10-0${id}`, ...extra });
  await storage.batch([
    { op: 'put', store: 'animales', value: animal('1', {}) },
    { op: 'put', store: 'animales', value: animal('2', { estadoOperativo: 'EN_HATO' }) },
    { op: 'put', store: 'animales', value: animal('3', { estadoOperativo: 'SALIDO' }) },
    { op: 'put', store: 'animales', value: animal('4', { estadoOperativo: 'MUERTO' }) },
    { op: 'put', store: 'animales', value: animal('5', { estado: 'ANULADO', estadoOperativo: 'SALIDO' }) },
  ]);
  const repo = createLocalRepo(storage, { organizacionId: 'org', deviceId: 'dev' });
  const ids = async (f) => (await repo.listAnimales(f)).map((a) => a.animalId).sort();
  assert.deepEqual(await ids(), ['1', '2'], 'default: ACTIVO + EN_HATO (1 sin campo = fallback)');
  assert.deepEqual(await ids({ estadoOperativo: 'SALIDO' }), ['3']);
  assert.deepEqual(await ids({ estadoOperativo: 'MUERTO' }), ['4']);
  assert.deepEqual(await ids({ estadoOperativo: 'TODOS' }), ['1', '2', '3', '4']);
  assert.deepEqual(await ids({ estado: 'ANULADO', estadoOperativo: 'SALIDO' }), ['5']);
  assert.deepEqual(await ids({ estado: 'TODOS', estadoOperativo: 'TODOS' }), ['1', '2', '3', '4', '5']);
});

test('registro offline: la unicidad del número visual mira también SALIDO/MUERTO (numero_visual reservado)', () => {
  const registro = leer(HATO_DIR, 'HatoRegistroPage.jsx');
  assert.match(registro, /local\.listAnimales\(\{ estado: 'ACTIVO', estadoOperativo: 'TODOS' \}\)/);
});

// ---------------------------------------------------------------------------
// O. Pesajes en animales cerrados
// ---------------------------------------------------------------------------

test('pesajes cerrados: mensajes exactos, sin alertas de atraso, sin formulario', () => {
  assert.equal(mensajePesajesCerrado('SALIDO'), 'Este animal salió del hato y no admite nuevos pesajes.');
  assert.equal(mensajePesajesCerrado('MUERTO'), 'Este animal está registrado como muerto y no admite nuevos pesajes.');
  assert.equal(mensajePesajesCerrado('EN_HATO'), null);
  assert.equal(TEXTO_SIN_ALERTAS_CERRADO, 'Sin alertas: el animal ya no está en el hato.');
  assert.match(pesajesPanel, /const admitePesajes = animalActivo && !anuladoEnServidor && !cerrado;/);
  assert.match(pesajesPanel, /const mostrarFormulario = admitePesajes &&/);
  assert.match(pesajesPanel, /\{admitePesajes \? \(\s*<HatoPesajesAlertas/);
  assert.match(pesajesPanel, /\{cerrado \? \([\s\S]*?TEXTO_SIN_ALERTAS_CERRADO/);
  assert.match(pesajesPanel, /<HatoPesajesKpis resumen=\{state\.data\.resumen\} \/>/, 'KPIs siguen visibles');
  assert.match(pesajesPanel, /<HatoPesajesGrafica pesajes=\{pesajes\} \/>/, 'gráfica sigue visible');
  assert.match(detalle, /estadoOperativo=\{situacion\}/);
});

test('pesaje online con 409 ANIMAL_YA_*: estado CERRADO con su mensaje', () => {
  assert.deepEqual(resultadoRegistro({ ok: false, status: 409, data: { error: 'ANIMAL_YA_SALIDO' } }), { tipo: 'CERRADO', estadoOperativo: 'SALIDO', mensaje: 'Este animal salió del hato y no admite nuevos pesajes.' });
  assert.equal(resultadoRegistro({ ok: false, status: 409, data: { error: 'ANIMAL_YA_MUERTO' } }).estadoOperativo, 'MUERTO');
});

// ---------------------------------------------------------------------------
// P. Outbox
// ---------------------------------------------------------------------------

test('outbox ANIMAL_YA_*: mensajes exactos, CONFLICTO (sin reintentos en bucle)', () => {
  assert.equal(mensajeBloqueoPesaje('ANIMAL_YA_SALIDO'), 'Este pesaje no se sincronizó porque el animal salió del hato.');
  assert.equal(mensajeBloqueoPesaje('ANIMAL_YA_MUERTO'), 'Este pesaje no se sincronizó porque el animal está registrado como muerto.');
  for (const code of ['ANIMAL_YA_SALIDO', 'ANIMAL_YA_MUERTO']) {
    assert.equal(classifyResult({ ok: false, status: 409, data: { error: code } }), 'CONFLICTO', code);
    const e = estadoPesajePendiente({ estado: 'CONFLICTO', ultimoError: { codigo: code } });
    assert.equal(e.bloqueado, true);
    assert.equal(e.detalle, mensajeBloqueoPesaje(code));
  }
});

// ---------------------------------------------------------------------------
// Q/R. QR en animales cerrados y QR_NO_OPERATIVO
// ---------------------------------------------------------------------------

test('QR de animal cerrado: histórica "No operativa", mensaje exacto y sin asociar/reemplazar/baja', () => {
  assert.equal(MENSAJE_QR_HISTORICA, 'Esta chapeta está vinculada históricamente a este animal y no puede reasignarse.');
  const historial = [
    { qrId: '2', codigoVisible: 'AGX-NEW', estado: 'REVOCADO', motivo: 'Animal salió del hato', revocadoAt: '2026-10-20T10:00:00Z' },
    { qrId: '1', codigoVisible: 'AGX-OLD', estado: 'REEMPLAZADO', motivo: 'Rota', revocadoAt: '2026-01-01T10:00:00Z' },
  ];
  assert.equal(chapetaHistoricaDeCierre(historial, 'SALIDO').qrId, '2');
  assert.equal(chapetaHistoricaDeCierre([historial[1]], 'MUERTO').qrId, '1');
  assert.equal(chapetaHistoricaDeCierre([], 'MUERTO'), null);
  assert.match(qrPanel, /<strong>No operativa<\/strong>/);
  assert.match(qrPanel, /Causa de baja/);
  assert.match(qrPanel, /\{animalActivo && !cerrado \? \(/);
  assert.match(detalle, /animalActivo=\{animal\.estado === 'ACTIVO' && enHato\}/);
});

test('QR_NO_OPERATIVO: "Ver ficha" solo con animalId válido del servidor (misma organización); sin él, sin pista', () => {
  assert.deepEqual(qrResolutionOutcome({ ok: false, status: 410, data: { error: 'QR_NO_OPERATIVO', estado: 'REVOCADO', animalId: '7' } }), { status: 'no_operativa', estado: 'Revocada', animalId: '7' });
  assert.equal(qrResolutionOutcome({ ok: false, status: 410, data: { error: 'QR_NO_OPERATIVO', estado: 'REVOCADO' } }).animalId, null);
  assert.equal(qrResolutionOutcome({ ok: false, status: 410, data: { estado: 'REVOCADO', animalId: '../x' } }).animalId, null);
  assert.equal(qrResolutionOutcome({ ok: false, status: 410, data: { estado: 'REVOCADO', animalId: '1234' } }).animalId, '1234');
  assert.equal(qrResolutionOutcome({ ok: false, status: 410, data: { estado: 'REVOCADO', animalId: '1ddd' } }).animalId, null);
  assert.match(resolver, /\/\^\[1-9\]\\d\{0,17\}\$\/\.test\(String\(localResult\.animalId/);
  assert.deepEqual(qrResolutionOutcome({ ok: false, status: 404, data: { error: 'QR_NOT_FOUND' } }), { status: 'not_found' });
  assert.match(resolver, /outcome\.animalId \? \([\s\S]*?Ver ficha del animal/);
});

// ---------------------------------------------------------------------------
// S. Timeline / V. Super Admin / W. Responsive
// ---------------------------------------------------------------------------

test('timeline: etiquetas Salida y Muerte (nunca "Actividad")', () => {
  assert.equal(etiquetaTipoEvento('ANIMAL_SALIDO'), 'Salida');
  assert.equal(etiquetaTipoEvento('ANIMAL_MUERTO'), 'Muerte');
  assert.equal(etiquetaTipoEvento('QR_DESASIGNADO'), 'Chapeta QR');
});

test('Super Admin QR: situación del animal en texto (fallback En hato)', () => {
  assert.equal(etiquetaEstadoOperativoAnimal('SALIDO'), 'Salido');
  assert.equal(etiquetaEstadoOperativoAnimal('MUERTO'), 'Muerto');
  assert.equal(etiquetaEstadoOperativoAnimal(undefined), 'En hato');
});

test('responsive: diálogo con ancho fluido, formularios verticales y botones full-width en móvil', () => {
  assert.match(css, /\.gan-cierre-dialog \{[\s\S]*?width: 100%;[\s\S]*?max-width: 32rem;/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*?\.gan-cierre-dialog-acciones > \* \{[\s\S]*?width: 100%;/);
  assert.match(css, /\.gan-hato-resumen \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
});

test('listado: respuestas fuera de orden se descartan (solo aplica la consulta vigente)', () => {
  assert.match(lista, /const consultaRef = useRef\(0\);/);
  assert.match(lista, /const consulta = \+\+consultaRef\.current;\s*const vigente = \(\) => consulta === consultaRef\.current;/);
  // Servidor: nada se aplica tras el await sin comprobar vigencia.
  assert.match(lista, /await listAnimales\(\{ \.\.\.filtros, limit: PAGE_SIZE, offset: 0 \}\);\s*if \(!vigente\(\)\) return;/);
  assert.match(lista, /if \(vigente\(\)\) setState\(\{ status: 'ok', animales, total: animales\.length, origen: 'local' \}\);/);
  assert.match(lista, /catch \{\s*if \(vigente\(\)\) setState\(\{ status: 'error'/);
  // Cambio de filtros / desmontaje invalida lo que esté en vuelo.
  assert.match(lista, /return \(\) => \{\s*consultaRef\.current \+= 1;\s*unsubscribe\?\.\(\);\s*\};/);
  // "Ver más" de una lista ya reemplazada no se mezcla con la actual.
  assert.match(lista, /const consulta = consultaRef\.current;\s*setLoadingMore\(true\);/);
  assert.match(lista, /offset: state\.animales\.length \}\);\s*if \(consulta !== consultaRef\.current\) return;/);
});
