// FASE 1D.1: UI de pesajes sin conexión. Modelo puro + invariantes por
// fuente (no hay jsdom en el repo):
//   - online sigue igual (POST directo); offline -> outbox, NUNCA POST;
//   - "Pesaje pendiente de sincronización" (nunca "Pesaje registrado");
//   - formulario limpio solo tras persistir en el outbox;
//   - pendientes APARTE del historial y FUERA de KPIs, gráficas, alertas y PDF;
//   - refresco del historial cuando el motor confirma (sin recargar);
//   - conflictos de pesajes en /ganaderia/sincronizacion (descartar explícito);
//   - sin legacy, sin QR, CatastroX intacto.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ETIQUETA_PENDIENTE,
  MENSAJE_PESAJE_PENDIENTE,
  estadoPesajePendiente,
  huboConfirmaciones,
  idsPendientes,
  mensajeBloqueoPesaje,
  mensajeErrorGuardadoLocal,
  resumenPendientes,
  textoBotonPesaje,
} from '../pesajesOfflineModel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HATO_DIR = path.resolve(__dirname, '..');
const GANADERIA_DIR = path.resolve(HATO_DIR, '..');
const REPO_ROOT = path.resolve(GANADERIA_DIR, '..', '..', '..');

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}
const leer = (...p) => stripComments(fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n'));
const panel = leer(HATO_DIR, 'HatoPesajesPanel.jsx');
const pendientesJsx = leer(HATO_DIR, 'HatoPesajesPendientes.jsx');
const detalle = leer(HATO_DIR, 'HatoDetallePage.jsx');
const syncPage = leer(GANADERIA_DIR, 'offline', 'OfflineSyncPage.jsx');
const css = fs.readFileSync(path.join(GANADERIA_DIR, 'styles', 'ganaderia-hato.css'), 'utf8');

test('M. texto del botón: online igual que antes; offline "Guardar para sincronizar"; guardando', () => {
  assert.equal(textoBotonPesaje({ online: true }), 'Registrar pesaje');
  assert.equal(textoBotonPesaje({ online: true, primerPesaje: true }), 'Registrar primer pesaje');
  assert.equal(textoBotonPesaje({ online: true, saving: true }), 'Guardando pesaje...');
  assert.equal(textoBotonPesaje({ online: false }), 'Guardar para sincronizar');
  assert.equal(textoBotonPesaje({ online: false, primerPesaje: true }), 'Guardar para sincronizar');
  assert.equal(textoBotonPesaje({ online: false, saving: true }), 'Guardando...');
});

test('22. estado de cada pendiente en TEXTO (no solo color)', () => {
  assert.equal(ETIQUETA_PENDIENTE, 'Pendiente');
  assert.deepEqual(estadoPesajePendiente({ estado: 'PENDIENTE' }), { etiqueta: 'Pendiente', detalle: 'Se enviará automáticamente al recuperar la conexión.', bloqueado: false });
  assert.equal(estadoPesajePendiente({ estado: 'ERROR_REINTENTABLE' }).etiqueta, 'Pendiente');
  assert.equal(estadoPesajePendiente({ estado: 'SINCRONIZANDO' }).etiqueta, 'Sincronizando');
  const anulado = estadoPesajePendiente({ estado: 'CONFLICTO', ultimoError: { codigo: 'ANIMAL_ANULADO' } });
  assert.deepEqual(anulado, { etiqueta: 'No sincronizado', detalle: 'El animal fue anulado: el servidor no aceptó este pesaje.', bloqueado: true });
  assert.equal(estadoPesajePendiente({ estado: 'RECHAZADO', ultimoError: { codigo: 'INVALID_PESO' } }).detalle, 'El servidor rechazó los datos de este pesaje.');
  assert.equal(mensajeBloqueoPesaje('CLIENT_OPERATION_ID_REUSED'), 'Este registro ya existe en el servidor con otros datos.');
  assert.equal(mensajeBloqueoPesaje('ANIMAL_NOT_FOUND'), 'El animal ya no está disponible.');
  assert.doesNotMatch(mensajeBloqueoPesaje('XYZ_SQL_ERROR'), /XYZ|SQL/);
  assert.equal(resumenPendientes(1), '1 pesaje pendiente de sincronización');
  assert.equal(resumenPendientes(3), '3 pesajes pendientes de sincronización');
  assert.match(css, /\.gan-pesajes-pendientes \{[\s\S]*?border: 1px dashed/, 'refuerzo visual además del texto');
});

test('27. refresco post-sync: detecta operaciones confirmadas (desaparecen del outbox)', () => {
  const antes = idsPendientes([{ localOperationId: 'a' }, { localOperationId: 'b' }]);
  assert.equal(huboConfirmaciones(antes, idsPendientes([{ localOperationId: 'a' }, { localOperationId: 'b' }])), false);
  assert.equal(huboConfirmaciones(antes, idsPendientes([{ localOperationId: 'b' }])), true);
  assert.equal(huboConfirmaciones(new Set(), idsPendientes([{ localOperationId: 'x' }])), false, 'una nueva no es confirmación');
  assert.match(panel, /const unsubscribe = repoOffline\.subscribe\(\(\) => \{ leerPendientes\(\); \}\);/);
  assert.match(panel, /if \(confirmadas\) \{\s*await cargar\(\);\s*onRegistradoRef\.current\?\.\(\);/);
  assert.match(panel, /window\.addEventListener\('online', alVolver\)/);
  assert.match(panel, /document\.addEventListener\('visibilitychange', alVolver\)/);
  // Otra pestaña o el Service Worker confirman sin notificar a este repo:
  // relectura del outbox LOCAL solo mientras haya pendientes.
  assert.match(panel, /if \(!repoOffline \|\| !hayPendientes\) return undefined;\s*const id = setInterval\(\(\) => \{ leerPendientes\(\); \}, RELECTURA_PENDIENTES_MS\);\s*return \(\) => clearInterval\(id\);/);
  assert.match(panel, /const RELECTURA_PENDIENTES_MS = 4_000;/);
});

test('1/2/3. online sigue con POST directo; sin conexión -> outbox y NUNCA POST', () => {
  const guardar = panel.slice(panel.indexOf('async function guardar(event)'), panel.indexOf('const pesajes = state.data'));
  const ramaOffline = guardar.indexOf('if (!online) {');
  const post = guardar.indexOf('registrarPesaje(animalId');
  assert.ok(ramaOffline > 0 && post > ramaOffline, 'la rama sin conexión va antes del POST');
  assert.match(guardar, /if \(!online\) \{\s*await guardarOffline\(buildPesajeBody\(form, operationIdRef\.current\)\);\s*return;\s*\}/);
  assert.equal((panel.match(/registrarPesaje\(/g) ?? []).length, 1, 'un único POST, solo en la rama online');
  const offline = panel.slice(panel.indexOf('async function guardarOffline(body)'), panel.indexOf('async function guardar(event)'));
  assert.doesNotMatch(offline, /registrarPesaje\(|fetch\(|postJson/);
  assert.match(offline, /await repoOffline\.registrarPesajeLocal\(\{ animalId, body \}\);/);
  assert.ok(panel.indexOf('validatePesajeForm(form') < panel.indexOf('await guardarOffline('), 'valida localmente antes de encolar');
});

test('D. mensaje "pendiente" (nunca "registrado") y formulario limpio SOLO tras persistir', () => {
  assert.equal(MENSAJE_PESAJE_PENDIENTE, 'Pesaje pendiente de sincronización.');
  const offline = panel.slice(panel.indexOf('async function guardarOffline(body)'), panel.indexOf('async function guardar(event)'));
  assert.match(offline, /setMensaje\(\{ type: 'info', text: MENSAJE_PESAJE_PENDIENTE \}\)/);
  assert.doesNotMatch(offline, /Pesaje registrado|success/);
  const persistir = offline.indexOf('registrarPesajeLocal');
  const limpiar = offline.indexOf('setForm(initialPesajeForm(fechaNegocio))');
  const renovar = offline.indexOf('operationIdRef.current = newClientOperationId()');
  assert.ok(persistir < limpiar && persistir < renovar, 'limpia y renueva el id solo después de persistir');
  assert.match(offline, /catch \(error\) \{\s*setMensaje\(\{ type: 'error', text: mensajeErrorGuardadoLocal\(error\) \}\);\s*return;/, 'si falla, el formulario se conserva');
  assert.equal(mensajeErrorGuardadoLocal({ code: 'PESAJE_REQUIERE_ANIMAL_SINCRONIZADO', message: 'Este animal aún no está sincronizado.' }), 'Este animal aún no está sincronizado.');
});

test('M. sin almacenamiento local y sin red: mensaje claro, sin guardar', () => {
  assert.match(panel, /if \(!online && !repoOffline\) \{\s*setMensaje\(\{ type: 'error', text: MENSAJE_SIN_ALMACEN_LOCAL \}\);\s*return;/);
});

test('E/22. pendientes en una sección APARTE con insignia; sin pesajeId de servidor', () => {
  assert.match(panel, /<HatoPesajesPendientes pendientes=\{pendientes\} \/>/);
  assert.match(pendientesJsx, /<strong className="gan-pesajes-pendiente-badge">\{estado\.etiqueta\}<\/strong>/);
  assert.match(pendientesJsx, /key=\{p\.localOperationId\}/);
  assert.doesNotMatch(pendientesJsx, /pesajeId/);
  assert.doesNotMatch(pendientesJsx, /HatoPesajesHistorial/);
});

test('23-26. pendientes FUERA de KPIs, gráficas, alertas y reporte PDF', () => {
  // Los únicos usos de la lista de pendientes son su estado y su sección.
  const usos = [...panel.matchAll(/\bpendientes\b/g)].length;
  const permitidos = (panel.match(/\[pendientes, setPendientes\]|pendientes=\{pendientes\}|const hayPendientes = pendientes\.length > 0;/g) ?? [])
    .reduce((n, m) => n + (m.match(/\bpendientes\b/g) ?? []).length, 0);
  assert.equal(usos, permitidos, 'la lista de pendientes no se usa en ningún cálculo');
  assert.match(panel, /<HatoPesajesKpis resumen=\{state\.data\.resumen\} \/>/);
  assert.match(panel, /<HatoPesajesGrafica pesajes=\{pesajes\} \/>/);
  assert.match(panel, /construirAlertasPesajes\(\{ pesajes, resumen: state\.data\.resumen, fechaReferencia: fechaNegocio \}\)/);
  assert.match(panel, /const pesajes = state\.data\?\.pesajes \?\? \[\];/, '`pesajes` = solo datos confirmados del servidor');
  assert.match(panel, /<HatoReporteProductivoBoton animalId=\{animalId\} online=\{online\} \/>/, 'el PDF lo genera el servidor con datos confirmados');
  const reporte = leer(REPO_ROOT, 'server', 'services', 'ganaderia', 'reporteProductivo', 'reporteProductivoService.js');
  assert.doesNotMatch(reporte, /outbox|pendiente/i);
});

test('el formulario aparece sin conexión aunque el historial del servidor no cargue', () => {
  assert.match(panel, /\) : formulario\}/, 'fuera del bloque de datos confirmados también');
  assert.match(panel, /const puedeGuardarOffline = !online && Boolean\(repoOffline\);/);
});

test('la ficha pasa el repositorio offline al panel', () => {
  assert.match(detalle, /repoOffline=\{offline\.repo\}/);
});

test('conflictos de pesajes en /ganaderia/sincronizacion: descartar explícito, sin reintento automático', () => {
  assert.match(syncPage, /function ConflictoPesajeItem\(/);
  assert.match(syncPage, /repo\.descartarPesajePendiente\(op\.operationId\)/);
  assert.match(syncPage, /op\.tipoOperacion === 'PESAJE_CREAR'\s*\?\s*<ConflictoPesajeItem/);
  assert.match(syncPage, /await offline\.repo\.getAnimal\(op\.payload\?\.animalId\)/);
  assert.doesNotMatch(syncPage.slice(syncPage.indexOf('function ConflictoPesajeItem'), syncPage.indexOf('function ConflictoItem(')), /newClientOperationId|randomUUID|resolverEditando/);
});

test('31-33. sin legacy, sin QR, CatastroX intacto', () => {
  const nuevos = [
    leer(HATO_DIR, 'pesajesOfflineModel.js'), pendientesJsx, panel,
    leer(GANADERIA_DIR, 'offline', 'operationHandlers.js'),
  ];
  for (const code of nuevos) {
    assert.doesNotMatch(code, /ganaderiaApi|\/api\/pesajes|\/api\/animales|catastrox/i);
  }
  const handlers = leer(GANADERIA_DIR, 'offline', 'operationHandlers.js');
  const pesaje = handlers.slice(handlers.indexOf('PESAJE_CREAR: {'));
  assert.doesNotMatch(pesaje, /qr|chapeta/i, 'PESAJE_CREAR no toca QR');
  assert.doesNotMatch(handlers, /organizacionId/);
  const catastroxDir = path.join(REPO_ROOT, 'src', 'modules', 'catastrox');
  const pendientesDir = [catastroxDir];
  while (pendientesDir.length) {
    const dir = pendientesDir.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pendientesDir.push(full);
      else if (/\.(js|jsx|mjs)$/.test(entry.name)) assert.doesNotMatch(fs.readFileSync(full, 'utf8'), /PESAJE_CREAR|registrarPesajeLocal/, full);
    }
  }
});
