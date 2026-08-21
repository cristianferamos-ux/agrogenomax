// SPRINT-3D6-FICHA-PRODUCTIVA: pruebas arquitectónicas (análisis de texto
// fuente) -- mismo patrón que potreroCardMapArchitecture.test.js. Este
// repo no tiene jsdom/testing-library configurado para render real de
// componentes React en `test:node`.
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

const panelSource = readNormalized(path.join(POTREROS_DIR, 'PotreroFichaProductivaPanel.jsx'));
const apiSource = readNormalized(path.join(POTREROS_DIR, 'ganaderiaFichaProductivaApi.js'));
const listPanelSource = readNormalized(path.join(POTREROS_DIR, 'PotrerosByPredioPanel.jsx'));
const apiCode = stripComments(apiSource);

// ---------------------------------------------------------------------
// §16: nunca "forraje disponible"/"comida disponible" -- siempre
// "BIOMASA FRESCA ESTIMADA" (o su forma sentence-case en la UI).
// ---------------------------------------------------------------------

test('el panel nunca usa el copy "forraje disponible" ni "comida disponible" (§16 del sprint)', () => {
  assert.doesNotMatch(panelSource, /forraje disponible/i);
  assert.doesNotMatch(panelSource, /comida disponible/i);
});

test('el panel rotula la biomasa como "Biomasa fresca estimada" (resumen y preview)', () => {
  const matches = panelSource.match(/Biomasa fresca estimada/g) || [];
  assert.ok(matches.length >= 2, 'se esperaba el copy tanto en el resumen como en el preview');
});

test('el aforo se rotula explícitamente con su unidad "g/m² de materia fresca" (§10 del sprint)', () => {
  assert.match(panelSource, /Aforo promedio \(g\/m² de materia fresca\)/);
});

// ---------------------------------------------------------------------
// §15: area/biomasa nunca calculadas ni enviadas por el cliente como
// valor persistido -- el preview local es solo visual.
// ---------------------------------------------------------------------

test('el body enviado a createFichaProductiva nunca incluye areaHa/biomasaTotalKg/tipoCobertura/nombrePrincipal', () => {
  const bodyBlock = panelSource.match(/const body = \{[\s\S]*?\n {4}\};/)?.[0] ?? '';
  assert.notEqual(bodyBlock, '');
  for (const forbidden of ['areaHa', 'biomasaTotalKg', 'tipoCobertura', 'nombrePrincipal', 'organizacionId', 'potreroId', 'predioId']) {
    assert.doesNotMatch(bodyBlock, new RegExp(forbidden));
  }
});

test('computeBiomasaPreviewKg es puramente presentacional -- nunca se asigna a un campo enviado al backend', () => {
  assert.match(panelSource, /function computeBiomasaPreviewKg\(areaHa, aforoPromedioGM2\)/);
  const usage = panelSource.match(/const biomasaPreview = computeBiomasaPreviewKg\(areaHa, aforo\);/);
  assert.ok(usage);
});

// ---------------------------------------------------------------------
// §24: estado sin ficha -- copy exacto del sprint.
// ---------------------------------------------------------------------

test('estado sin ficha muestra el copy exacto del sprint y el botón "Crear ficha productiva"', () => {
  assert.match(panelSource, /Aún no has registrado información productiva para este potrero\./);
  assert.match(panelSource, />\s*Crear ficha productiva\s*</);
});

// ---------------------------------------------------------------------
// API client: rutas correctas, tenant nunca en el cliente.
// ---------------------------------------------------------------------

test('ganaderiaFichaProductivaApi.js habla exclusivamente con las rutas subordinadas a predio/potrero y el catálogo transversal', () => {
  assert.match(apiSource, /\/api\/ganaderia\/predios\/\$\{predioId\}\/potreros\/\$\{potreroId\}\/ficha-productiva/);
  assert.match(apiSource, /\/api\/ganaderia\/catalogo-pasturas/);
  assert.match(apiSource, /\/api\/ganaderia\/catalogo-pasturas\/personalizadas/);
});

test('ganaderiaFichaProductivaApi.js nunca referencia organizacionId en código (solo en comentario de contrato) ni el router legacy /api/potreros', () => {
  assert.doesNotMatch(apiCode, /organizacionId/);
  assert.doesNotMatch(apiSource, /['"`]\/api\/potreros/);
  assert.doesNotMatch(apiSource, /catastrox/i);
});

test('mutaciones usan CSRF (fetchCsrfToken + X-CSRF-Token), GET no', () => {
  assert.match(apiSource, /fetchCsrfToken/);
  assert.match(apiSource, /X-CSRF-Token/);
});

// ---------------------------------------------------------------------
// Integración en la tarjeta de potrero (§20 del sprint: siempre dentro de
// Predio -> Potrero -> Ficha productiva, nunca un flujo global).
// ---------------------------------------------------------------------

test('PotrerosByPredioPanel.jsx monta PotreroFichaProductivaPanel dentro de la card, con predioId/potreroId/areaHa fijos de ESE potrero', () => {
  assert.match(listPanelSource, /import PotreroFichaProductivaPanel from '\.\/PotreroFichaProductivaPanel\.jsx';/);
  assert.match(
    listPanelSource,
    /<PotreroFichaProductivaPanel\s+predioId=\{predioId\}\s+potreroId=\{potrero\.potreroId\}\s+areaHa=\{potrero\.areaHa\}\s*\/>/,
  );
});

test('el botón "Ficha productiva" alterna un estado local por potrero (openFichaPotreroId), nunca un panel global', () => {
  assert.match(listPanelSource, /openFichaPotreroId/);
  assert.match(listPanelSource, />\s*Ficha productiva\s*</);
});
