// FASE 1D.2: pestaña "Actividad" de la ficha. Modelo puro + invariantes por
// fuente (no hay jsdom en el repo): pestaña accesible, carga diferida,
// estados, render por tipo, refresco/stale sin polling, responsive.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TEXTO_CARGANDO_ACTIVIDAD,
  TEXTO_ERROR_ACTIVIDAD,
  TEXTO_SIN_ACTIVIDAD,
  detallesEvento,
  estadoActividad,
  etiquetaTipoEvento,
  fechaEvento,
} from '../actividadModel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HATO_DIR = path.resolve(__dirname, '..');
const GANADERIA_DIR = path.resolve(HATO_DIR, '..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const leer = (...p) => strip(fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n'));
const panel = leer(HATO_DIR, 'HatoActividadPanel.jsx');
const detalle = leer(HATO_DIR, 'HatoDetallePage.jsx');
const api = leer(HATO_DIR, 'hatoApi.js');
const qr = leer(HATO_DIR, 'HatoQrPanel.jsx');
const css = fs.readFileSync(path.join(GANADERIA_DIR, 'styles', 'ganaderia-hato.css'), 'utf8');

const pesaje = (datos) => ({ id: 'pesaje:3', tipo: 'PESAJE_REGISTRADO', fecha: '2026-10-20', hora: null, fechaHora: null, titulo: 'Pesaje registrado', descripcion: '360 kg · Pesado en báscula', datos });

test('textos de estado', () => {
  assert.equal(TEXTO_CARGANDO_ACTIVIDAD, 'Cargando actividad…');
  assert.equal(TEXTO_SIN_ACTIVIDAD, 'No hay actividad registrada.');
  assert.equal(TEXTO_ERROR_ACTIVIDAD, 'No fue posible cargar la actividad.');
});

test('categoría del evento en texto (no solo color) y fecha/hora', () => {
  assert.equal(etiquetaTipoEvento('PESAJE_REGISTRADO'), 'Pesaje');
  assert.equal(etiquetaTipoEvento('ANIMAL_CORREGIDO'), 'Corrección');
  assert.equal(etiquetaTipoEvento('ANIMAL_ANULADO'), 'Anulación');
  assert.equal(etiquetaTipoEvento('ANIMAL_REGISTRADO'), 'Registro');
  for (const t of ['QR_ASIGNADO', 'QR_DESASIGNADO', 'QR_REEMPLAZADO']) assert.equal(etiquetaTipoEvento(t), 'Chapeta QR');
  assert.equal(etiquetaTipoEvento('OTRO'), 'Actividad');
  assert.equal(fechaEvento({ fecha: '2026-10-18', hora: '07:20' }), '18/10/2026 · 07:20');
  assert.equal(fechaEvento({ fecha: '2026-10-20', hora: null }), '20/10/2026', 'pesaje: solo su fecha efectiva');
});

test('render de pesaje: diferencia, días, GMD ("Sin dato" el mismo día) y observaciones', () => {
  assert.deepEqual(detallesEvento(pesaje({ diferenciaKg: 5, diasDesdeAnterior: 0, gmdKgDia: null, observaciones: 'QA' })), [
    'Diferencia: +5 kg', 'Días desde el anterior: 0 días', 'GMD: Sin dato', 'Observaciones: QA',
  ]);
  assert.deepEqual(detallesEvento(pesaje({ diferenciaKg: 5, diasDesdeAnterior: 1, gmdKgDia: 5, observaciones: null })), [
    'Diferencia: +5 kg', 'Días desde el anterior: 1 día', 'GMD: +5 kg/día',
  ]);
  assert.deepEqual(detallesEvento(pesaje({ diferenciaKg: null, diasDesdeAnterior: null, gmdKgDia: null })), ['Primer peso registrado']);
  assert.deepEqual(detallesEvento({ tipo: 'ANIMAL_ANULADO', datos: { motivo: 'x' } }), [], 'anulación/corrección/QR: título + descripción del servidor');
});

test('estados: ok, vacío, 404 y error', () => {
  assert.equal(estadoActividad({ ok: true, data: { eventos: [{ id: 'a' }], total: 1, truncado: false } }).status, 'ok');
  assert.equal(estadoActividad({ ok: true, data: { eventos: [], total: 0 } }).status, 'vacio');
  assert.equal(estadoActividad({ ok: false, status: 404, data: { error: 'ANIMAL_NOT_FOUND' } }).status, 'not_found');
  assert.equal(estadoActividad({ ok: false, status: 500 }).status, 'error');
  assert.equal(estadoActividad(undefined).status, 'error');
});

test('pestaña accesible "Actividad" en la ficha (tablist con teclado)', () => {
  assert.match(detalle, /\{ id: 'actividad', label: 'Actividad' \}/);
  assert.match(detalle, /<FichaTabs activa=\{pestana\} onChange=\{cambiarPestana\} \/>/);
  assert.match(detalle, /role="tabpanel" id="ficha-panel-actividad" aria-labelledby="ficha-tab-actividad"/);
  assert.match(detalle, /ArrowRight:/);
  assert.match(panel, /<section className="gan-actividad" aria-labelledby="actividad-titulo">/);
  assert.match(panel, /<h3 id="actividad-titulo">Actividad del animal<\/h3>/);
  assert.match(panel, /<ol className="gan-actividad-lista"/);
  assert.match(panel, /<span className="gan-actividad-tipo">\{etiquetaTipoEvento\(evento\.tipo\)\}<\/span>/);
  assert.match(panel, /<time className="gan-actividad-fecha"/);
});

test('carga diferida: el panel se monta al abrir la pestaña y solo pide si está visible', () => {
  assert.match(detalle, /if \(id === 'actividad'\) setActividadAbierta\(true\);/);
  assert.match(detalle, /\{modo === 'ver' && !esLocal && actividadAbierta \? \(/);
  assert.match(detalle, /hidden=\{pestana !== 'actividad'\}/, 'al volver se reutiliza el estado cargado');
  assert.match(panel, /if \(visible && versionCargadaRef\.current !== clave\) cargar\(clave\);/);
  assert.match(panel, /const clave = `\$\{animalId\}:\$\{version\}:\$\{confirmacionesLocales\}`;/, 'la clave incluye el animal');
  assert.match(api, /export function getTimelineAnimal\(animalId, \{ limit \} = \{\}\)/);
  assert.match(api, /\/animales\/\$\{encodeURIComponent\(animalId\)\}\/timeline/);
});

test('loading, vacío, error y reintentar', () => {
  assert.match(panel, /\{TEXTO_CARGANDO_ACTIVIDAD\}/);
  assert.match(panel, /\{TEXTO_SIN_ACTIVIDAD\}/);
  assert.match(panel, /\{TEXTO_ERROR_ACTIVIDAD\}/);
  assert.match(panel, />Reintentar<\/button>/);
});

test('refresco/stale sin polling: pesaje confirmado, corrección, anulación, chapeta QR y outbox local', () => {
  assert.match(detalle, /const marcarActividad = useCallback\(\(\) => setActividadVersion\(\(v\) => v \+ 1\), \[\]\);/);
  assert.match(detalle, /load\(\{ silencioso: true \}\);\s*marcarActividad\(\);/);
  assert.match(detalle, /if \(!data\.sinCambios\) marcarActividad\(\);/);
  assert.match(detalle, /if \(!data\.yaAnulado\) marcarActividad\(\);/);
  assert.match(detalle, /<HatoQrPanel\s[^>]*onCambio=\{marcarActividad\}[^>]*\/>/);
  assert.match(qr, /await load\(\);\s*onCambio\?\.\(\);/);
  assert.match(panel, /repoOffline\.subscribe\(\(\) => \{ revisar\(\); \}\)/);
  assert.match(panel, /if \(huboConfirmaciones\(pendientesRef\.current, actuales\)\) setConfirmacionesLocales/);
  assert.doesNotMatch(panel, /setInterval|setTimeout/, 'sin polling');
});

test('los pendientes del outbox NO entran en la actividad (solo datos del servidor)', () => {
  assert.doesNotMatch(panel, /listPesajesPendientes\(animalId\)\)\.map|pendientes\.map|estado === 'PENDIENTE'/);
  assert.match(panel, /setState\(estadoActividad\(await getTimelineAnimal\(animalId\)\)\)/);
});

test('responsive: línea vertical, sin anchos fijos, palabras largas partidas, más aire en escritorio', () => {
  const bloque = css.slice(css.indexOf('.gan-actividad {'));
  assert.match(bloque, /\.gan-actividad-lista \{[\s\S]*?list-style: none;/);
  assert.match(bloque, /overflow-wrap: anywhere;/);
  assert.match(bloque, /@media \(min-width: 768px\)/);
  assert.doesNotMatch(bloque, /^\s*(min-|max-)?width:\s*\d{3,}px/m);
  assert.match(css, /@media \(max-width: 479px\) \{\s*\.gan-hato-tabs \{\s*gap: 0;[\s\S]*?flex: 1 1 auto;\s*min-width: 0;/, 'tres pestañas sin desbordar en 320px');
});

test('sin legacy ni tokens en la UI de actividad', () => {
  for (const code of [panel, leer(HATO_DIR, 'actividadModel.js')]) {
    assert.doesNotMatch(code, /ganaderiaApi|\/api\/animales|catastrox|token|qrId/i);
  }
});
