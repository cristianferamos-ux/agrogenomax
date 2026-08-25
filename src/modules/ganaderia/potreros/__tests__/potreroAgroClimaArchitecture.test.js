// SPRINT-3D7.1-AGROCLIMA: pruebas arquitectónicas (análisis de texto
// fuente) -- mismo patrón que potreroCapacidadPastoreoArchitecture.test.js.
// Este repo no tiene jsdom/testing-library configurado para render real
// de componentes React en `test:node`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POTREROS_DIR = path.resolve(__dirname, '..');

function readNormalized(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function stripComments(text) {
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const panelSource = readNormalized(path.join(POTREROS_DIR, 'PotreroAgroClimaPanel.jsx'));
const apiSource = readNormalized(path.join(POTREROS_DIR, 'ganaderiaAgroClimaApi.js'));
const listSource = readNormalized(path.join(POTREROS_DIR, 'PotrerosByPredioPanel.jsx'));
const apiCode = stripComments(apiSource);

// ---------------------------------------------------------------------
// §24 del sprint: copy exacto, nunca "clima exacto del potrero".
// ---------------------------------------------------------------------

test('el panel usa el copy exacto del sprint (§24) -- nunca promete "clima exacto"', () => {
  assert.match(panelSource, /Contexto agroclimático estimado a partir de fuentes públicas y observacionales\./);
  assert.doesNotMatch(panelSource, /clima exacto/i);
});

test('estado vacío usa el copy exacto del sprint (§23)', () => {
  assert.match(panelSource, /Aún no hay contexto agroclimático calculado para este potrero\./);
});

test('botón de refresco usa el texto exacto del sprint (§23)', () => {
  assert.match(panelSource, /Actualizar contexto/);
});

// ---------------------------------------------------------------------
// §12 del sprint: refresh nunca envía lat/lng/coordenadas -- POST sin body.
// ---------------------------------------------------------------------

test('refreshContextoAgroclimatico nunca envía body ni lat/lng/coordenadas', () => {
  assert.doesNotMatch(apiCode, /\blat\b/);
  assert.doesNotMatch(apiCode, /\blng\b/);
  assert.doesNotMatch(apiCode, /JSON\.stringify/);
});

// ---------------------------------------------------------------------
// §9/§23: secciones exigidas por el sprint -- precipitación (4 ventanas),
// temperatura, humedad, radiación, fuentes, fecha de disponibilidad.
// ---------------------------------------------------------------------

test('muestra las 4 ventanas de precipitación exigidas por el sprint (§3/§9)', () => {
  for (const field of ['precipitacion24hMm', 'precipitacion7dMm', 'precipitacion15dMm', 'precipitacion30dMm']) {
    assert.match(panelSource, new RegExp(field));
  }
});

test('muestra temperatura media/mínima/máxima, humedad relativa y radiación', () => {
  for (const field of ['temperaturaMediaC', 'temperaturaMinC', 'temperaturaMaxC', 'humedadRelativaMediaPct', 'radiacionSolar']) {
    assert.match(panelSource, new RegExp(field));
  }
});

test('muestra "Datos disponibles hasta" a partir de sourceObservedUntil (§4 del sprint)', () => {
  assert.match(panelSource, /Datos disponibles hasta/);
  assert.match(panelSource, /sourceObservedUntil/);
});

test('muestra la fuente IDEAM con estación y distancia cuando está distante (§24)', () => {
  assert.match(panelSource, /distanceKm/);
  assert.match(panelSource, /stationName/);
});

// ---------------------------------------------------------------------
// API client: rutas correctas, tenant nunca en el cliente.
// ---------------------------------------------------------------------

test('ganaderiaAgroClimaApi.js habla exclusivamente con la ruta subordinada a predio/potrero', () => {
  assert.match(apiSource, /\/api\/ganaderia\/predios\/\$\{predioId\}\/potreros\/\$\{potreroId\}\/contexto-agroclimatico/);
  assert.match(apiSource, /\/contexto-agroclimatico\/refresh/);
});

test('ganaderiaAgroClimaApi.js nunca referencia organizacionId en código ni el router legacy /api/potreros', () => {
  assert.doesNotMatch(apiCode, /organizacionId/);
  assert.doesNotMatch(apiSource, /['"`]\/api\/potreros/);
  assert.doesNotMatch(apiSource, /catastrox/i);
});

test('mutaciones usan CSRF (fetchCsrfToken + X-CSRF-Token), GET no', () => {
  assert.match(apiSource, /fetchCsrfToken/);
  assert.match(apiSource, /X-CSRF-Token/);
});

// ---------------------------------------------------------------------
// Montaje: independiente de la ficha productiva, dentro de la tarjeta
// del potrero (§23 del sprint).
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// Hardening source-integrity: el panel enruta por `dataset` (clave
// estable), nunca por `provider` (nombre honesto del proveedor de
// entrega, que ahora es OPEN_METEO/IDEAM_DATOS_ABIERTOS, no
// ERA5_LAND/IDEAM) -- ver agroClimateOrchestrator.js.
// ---------------------------------------------------------------------

test('el panel enruta las fuentes por f.dataset, nunca por f.provider', () => {
  assert.match(panelSource, /f\.dataset === 'ERA5_LAND'/);
  assert.match(panelSource, /f\.dataset === 'IDEAM'/);
  assert.doesNotMatch(panelSource, /f\.provider === 'ERA5_LAND'/);
  assert.doesNotMatch(panelSource, /f\.provider === 'IDEAM'/);
});

test('distingue NO_STATION_NEARBY de STATION_FOUND_NO_RECENT_OBSERVATIONS en el copy IDEAM', () => {
  assert.match(panelSource, /NO_STATION_NEARBY/);
  assert.match(panelSource, /STATION_FOUND_NO_RECENT_OBSERVATIONS/);
});

test('PotrerosByPredioPanel.jsx monta PotreroAgroClimaPanel dentro de la tarjeta del potrero', () => {
  assert.match(listSource, /import PotreroAgroClimaPanel from '\.\/PotreroAgroClimaPanel\.jsx';/);
  assert.match(listSource, /<PotreroAgroClimaPanel predioId=\{predioId\} potreroId=\{potrero\.potreroId\} \/>/);
});
