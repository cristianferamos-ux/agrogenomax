// SPRINT-3C4.3: pruebas arquitectónicas (análisis de texto fuente) --
// mismo patrón que prediosPageArchitecture.test.js. Este repo no tiene
// jsdom/testing-library configurado para render real de componentes React
// en `test:node`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = path.resolve(__dirname, '..');
const API_DIR = path.resolve(PAGES_DIR, '..', 'api');

// Normaliza CRLF->LF: en checkouts Windows con core.autocrlf=true el
// archivo se materializa con \r\n. El contenido lógico es idéntico.
const dashboardSource = fs
  .readFileSync(path.join(PAGES_DIR, 'GanaderiaDashboard.jsx'), 'utf8')
  .replace(/\r\n/g, '\n');
const apiSource = fs.readFileSync(path.join(API_DIR, 'ganaderiaApi.js'), 'utf8').replace(/\r\n/g, '\n');

function stripComments(text) {
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const dashboardCode = stripComments(dashboardSource);
const apiCode = stripComments(apiSource);

// ---------------------------------------------------------------------
// A/B/C. Predios: consume /api/ganaderia/predios (ganaderiaApi.listGanaderiaPredios),
// nunca /api/predios (listPredios) para el indicador del dashboard.
// ---------------------------------------------------------------------

test('ganaderiaApi.js: listGanaderiaPredios() apunta a /ganaderia/predios (resuelve a /api/ganaderia/predios)', () => {
  assert.match(apiCode, /listGanaderiaPredios:\s*\(\)\s*=>\s*request\(['"]\/ganaderia\/predios['"]\)/);
});

test('GanaderiaDashboard.jsx: usa ganaderiaApi.listGanaderiaPredios() para el indicador de Predios', () => {
  assert.match(dashboardCode, /ganaderiaApi\s*\n?\s*\.listGanaderiaPredios\(\)/);
});

test('GanaderiaDashboard.jsx: NUNCA llama a ganaderiaApi.listPredios() (endpoint legacy /api/predios)', () => {
  assert.doesNotMatch(dashboardCode, /ganaderiaApi\.listPredios\(\)/);
});

// ---------------------------------------------------------------------
// C/D/E. Parser: solo una respuesta con predios como array real es válida.
// Cualquier otra forma ({}, {predios:null}, {predios:{}}, undefined) es
// un error -- NUNCA se degrada silenciosamente a count 0.
// ---------------------------------------------------------------------

test('GanaderiaDashboard.jsx: valida explícitamente Array.isArray(response?.predios) antes de aceptar la respuesta', () => {
  assert.match(dashboardCode, /if \(!Array\.isArray\(response\?\.predios\)\) \{/);
});

test('GanaderiaDashboard.jsx: shape inválido ({}, predios:null, predios:{}, undefined) pasa a status error, NUNCA a count 0', () => {
  const fn = dashboardCode.match(/\.then\(\(response\) => \{[\s\S]*?\n      \}\)/)?.[0] ?? '';
  const guardBlock = fn.match(/if \(!Array\.isArray\(response\?\.predios\)\) \{[\s\S]*?\n {8}\}/)?.[0] ?? '';
  assert.ok(guardBlock, 'debe existir un guard temprano para shape inválido');
  assert.match(guardBlock, /setPrediosState\(\{\s*status:\s*'error',\s*count:\s*null\s*\}\)/);
  assert.match(guardBlock, /return;/);
});

test('GanaderiaDashboard.jsx: count real solo se calcula DESPUÉS del guard de shape válido (response.predios.length, no un fallback [])', () => {
  const fn = dashboardCode.match(/\.then\(\(response\) => \{[\s\S]*?\n      \}\)/)?.[0] ?? '';
  assert.match(fn, /setPrediosState\(\{\s*status:\s*'ok',\s*count:\s*response\.predios\.length\s*\}\)/);
  // Nunca debe existir un fallback "predios = [] si no es array" -- eso
  // convertiría una respuesta inválida en count 0 (regresión prohibida).
  assert.doesNotMatch(dashboardCode, /Array\.isArray\(response\?\.predios\)\s*\?\s*response\.predios\s*:\s*\[\]/);
});

// ---------------------------------------------------------------------
// D/E/F. Semántica: 0 es un valor real, error nunca se confunde con array vacío.
// ---------------------------------------------------------------------

test('GanaderiaDashboard.jsx: nunca usa summary.predios.length || "Sin datos" (0 nunca cae a un placeholder)', () => {
  assert.doesNotMatch(dashboardCode, /\.length \|\| 'Sin datos'/);
  assert.doesNotMatch(dashboardCode, /\.length \|\| "Sin datos"/);
});

test('GanaderiaDashboard.jsx: el estado de Predios distingue ok/error explícitamente (status, no un array vacío)', () => {
  assert.match(dashboardCode, /setPrediosState\(\{\s*status:\s*'ok',\s*count:\s*response\.predios\.length\s*\}\)/);
  assert.match(dashboardCode, /setPrediosState\(\{\s*status:\s*'error',\s*count:\s*null\s*\}\)/);
});

test('GanaderiaDashboard.jsx: count=0 (status ok) renderiza "0", nunca "No disponible" ni "Sin datos"', () => {
  const fn = dashboardCode.match(/const prediosValue =\s*[\s\S]*?String\(prediosState\.count\);/)?.[0] ?? '';
  assert.match(fn, /String\(prediosState\.count\)/);
});

test('GanaderiaDashboard.jsx: status error renderiza "No disponible" para Predios', () => {
  const fn = dashboardCode.match(/const prediosValue =\s*[\s\S]*?String\(prediosState\.count\);/)?.[0] ?? '';
  assert.match(fn, /'error'\s*\n?\s*\?\s*'No disponible'/);
});

// ---------------------------------------------------------------------
// G/H. Potreros y Animales: nunca consultan endpoints legacy, siempre
// "No disponible".
// ---------------------------------------------------------------------

test('GanaderiaDashboard.jsx: NUNCA llama a ganaderiaApi.listPotreros() ni ganaderiaApi.listAnimales()', () => {
  assert.doesNotMatch(dashboardCode, /ganaderiaApi\.listPotreros\(/);
  assert.doesNotMatch(dashboardCode, /ganaderiaApi\.listAnimales\(/);
});

test('GanaderiaDashboard.jsx: los indicadores de Potreros y Animales son literalmente "No disponible"', () => {
  const potrerosIndicator = dashboardCode.match(/label:\s*'Potreros registrados'[\s\S]*?icon:\s*Sprout,\s*\}/)?.[0] ?? '';
  const animalesIndicator = dashboardCode.match(/label:\s*'Animales registrados'[\s\S]*?icon:\s*Beef,\s*\}/)?.[0] ?? '';
  assert.match(potrerosIndicator, /value:\s*'No disponible'/);
  assert.match(animalesIndicator, /value:\s*'No disponible'/);
});

// ---------------------------------------------------------------------
// I/J/K. Copy del dashboard.
// ---------------------------------------------------------------------

test('GanaderiaDashboard.jsx: copy del botón principal es "Registrar predio" (sin "y propietario")', () => {
  assert.match(dashboardSource, /Registrar predio <MapPin/);
  assert.doesNotMatch(dashboardSource, /Registrar predio y propietario/);
});

test('GanaderiaDashboard.jsx: paso del flujo es "Predio" (sin "y propietario")', () => {
  assert.match(dashboardSource, /const flowSteps = \['Predio', 'Potrero', 'Animal \/ QR', 'Ficha animal'\];/);
  assert.doesNotMatch(dashboardSource, /'Predio y propietario'/);
});

test('GanaderiaDashboard.jsx: texto descriptivo actualizado del panel operativo', () => {
  assert.match(
    dashboardSource,
    /Primero registra el predio y completa su información básica\. Luego registra los potreros\./,
  );
  assert.doesNotMatch(dashboardSource, /Primero registra el predio con los datos de su propietario/);
});

// ---------------------------------------------------------------------
// L. CatastroX intacto -- el dashboard de Ganadería no debe tocar CatastroX.
// ---------------------------------------------------------------------

test('GanaderiaDashboard.jsx: no importa ni referencia módulos de CatastroX', () => {
  assert.doesNotMatch(dashboardCode, /catastrox/i);
});

// ---------------------------------------------------------------------
// M. organizacionId nunca viaja desde el cliente.
// ---------------------------------------------------------------------

test('GanaderiaDashboard.jsx: nunca envía/lee organizacionId desde el cliente', () => {
  assert.doesNotMatch(dashboardCode, /organizacionId/);
});

test('ganaderiaApi.js: listGanaderiaPredios() no agrega ni envía organizacionId (server-side desde la sesión)', () => {
  const fn = apiCode.match(/listGanaderiaPredios:\s*\(\)\s*=>\s*request\([^)]*\)/)?.[0] ?? '';
  assert.doesNotMatch(fn, /organizacionId/);
});
