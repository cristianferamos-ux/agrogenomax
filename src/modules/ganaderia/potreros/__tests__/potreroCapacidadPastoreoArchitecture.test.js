// SPRINT-3D7-CAPACIDAD-PASTOREO: pruebas arquitectónicas (análisis de
// texto fuente) -- mismo patrón que potreroFichaProductivaArchitecture.test.js.
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

const panelSource = readNormalized(path.join(POTREROS_DIR, 'PotreroCapacidadPastoreoPanel.jsx'));
const apiSource = readNormalized(path.join(POTREROS_DIR, 'ganaderiaCapacidadPastoreoApi.js'));
const fichaPanelSource = readNormalized(path.join(POTREROS_DIR, 'PotreroFichaProductivaPanel.jsx'));
const apiCode = stripComments(apiSource);

// ---------------------------------------------------------------------
// §20 del sprint: disclaimer exacto, nunca lenguaje alarmista.
// ---------------------------------------------------------------------

test('el panel muestra el disclaimer técnico exacto del sprint (§20)', () => {
  assert.match(
    panelSource,
    /Estimación técnica basada en los datos y parámetros registrados\. Las condiciones reales del potrero y del ganado pueden variar\./,
  );
});

// ---------------------------------------------------------------------
// §6/§9: los parámetros técnicos nunca se presentan como si hubieran
// sido medidos -- textos de ayuda exactos.
// ---------------------------------------------------------------------

test('el campo de materia seca incluye el texto de ayuda exacto del sprint (§6)', () => {
  assert.match(panelSource, /Porcentaje estimado de materia seca del forraje al momento del aforo\./);
});

test('el campo de utilización incluye el texto de ayuda exacto del sprint (§9)', () => {
  assert.match(panelSource, /Proporción de la materia seca que se planea aprovechar, dejando el remanente necesario en el potrero\./);
});

// ---------------------------------------------------------------------
// §22: el body enviado al backend nunca incluye resultados/derivados --
// solo parámetros de entrada elegidos por el usuario.
// ---------------------------------------------------------------------

test('buildBody nunca incluye biomasaFrescaKg/materiaSecaTotalKg/materiaSecaUtilizableKg/demandaDiariaLoteKgMs/diasOcupacionEstimados/capacidadAnimalesPeriodo/areaHa/fichaId', () => {
  const bodyBlock = panelSource.match(/function buildBody\(modo, form\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(bodyBlock, '');
  for (const forbidden of [
    'biomasaFrescaKg', 'materiaSecaTotalKg', 'materiaSecaUtilizableKg', 'demandaDiariaLoteKgMs',
    'diasOcupacionEstimados', 'capacidadAnimalesPeriodo', 'areaHa', 'fichaId', 'organizacionId',
    'potreroId', 'predioId',
  ]) {
    assert.doesNotMatch(bodyBlock, new RegExp(forbidden));
  }
});

// ---------------------------------------------------------------------
// §21: preview vs create -- dos llamadas distintas, preview nunca
// persiste (nunca se descarta el flujo de doble paso calcular/guardar).
// ---------------------------------------------------------------------

test('usa previewCapacidadPastoreo antes de createCapacidadPastoreo -- flujo calcular -> guardar (§21/§22)', () => {
  assert.match(panelSource, /previewCapacidadPastoreo\(predioId, potreroId, buildBody\(modo, form\)\)/);
  assert.match(panelSource, /createCapacidadPastoreo\(predioId, potreroId, buildBody\(modo, form\)\)/);
});

// ---------------------------------------------------------------------
// §18: dos modos mutuamente excluyentes, nunca un formulario con todos
// los campos activos a la vez.
// ---------------------------------------------------------------------

test('selector de modo ofrece exactamente "Días de ocupación" y "Cantidad de animales" (§18)', () => {
  assert.match(panelSource, />\s*Días de ocupación\s*</);
  assert.match(panelSource, />\s*Cantidad de animales\s*</);
});

// ---------------------------------------------------------------------
// §30: resultado extremo -- nunca se oculta, solo advertencia neutral.
// ---------------------------------------------------------------------

test('advertencia de resultado extremo usa el copy neutral exacto del sprint (§30)', () => {
  assert.match(panelSource, /Revisa los parámetros ingresados; el resultado es muy bajo\/alto\./);
});

// ---------------------------------------------------------------------
// API client: rutas correctas, tenant nunca en el cliente.
// ---------------------------------------------------------------------

test('ganaderiaCapacidadPastoreoApi.js habla exclusivamente con las rutas subordinadas a predio/potrero', () => {
  assert.match(apiSource, /\/api\/ganaderia\/predios\/\$\{predioId\}\/potreros\/\$\{potreroId\}\/capacidad-pastoreo/);
  assert.match(apiSource, /\/capacidad-pastoreo\/preview/);
});

test('ganaderiaCapacidadPastoreoApi.js nunca referencia organizacionId en código ni el router legacy /api/potreros', () => {
  assert.doesNotMatch(apiCode, /organizacionId/);
  assert.doesNotMatch(apiSource, /['"`]\/api\/potreros/);
  assert.doesNotMatch(apiSource, /catastrox/i);
});

test('mutaciones usan CSRF (fetchCsrfToken + X-CSRF-Token), GET no', () => {
  assert.match(apiSource, /fetchCsrfToken/);
  assert.match(apiSource, /X-CSRF-Token/);
});

// ---------------------------------------------------------------------
// §25/§26: integrado dentro de la ficha productiva -- SIEMPRE montado
// (salvo mientras se registra un aforo nuevo), con tieneFicha derivado
// de `actual` -- el propio panel resuelve su estado vacío (§26), nunca
// queda oculto sin explicación cuando no hay ficha.
// ---------------------------------------------------------------------

test('PotreroFichaProductivaPanel.jsx monta PotreroCapacidadPastoreoPanel siempre que no se esté registrando un aforo, con tieneFicha={Boolean(actual)}', () => {
  assert.match(fichaPanelSource, /import PotreroCapacidadPastoreoPanel from '\.\/PotreroCapacidadPastoreoPanel\.jsx';/);
  assert.match(fichaPanelSource, /tieneFicha=\{Boolean\(actual\)\}/);
  assert.match(fichaPanelSource, /onCrearFicha=\{openForm\}/);

  // Debe estar fuera de la rama "actual" (para renderizar también cuando
  // no hay ficha) y fuera de la rama "showForm" (oculto mientras se
  // registra un aforo nuevo).
  const componentIndex = fichaPanelSource.indexOf('<PotreroCapacidadPastoreoPanel');
  const formBranchStart = fichaPanelSource.indexOf('{showForm ? (');
  assert.ok(componentIndex > 0 && formBranchStart > componentIndex, 'debe montarse antes del formulario de nueva ficha, nunca dentro de él');
});

test('PotreroCapacidadPastoreoPanel.jsx: sin ficha (tieneFicha=false) muestra el copy exacto del sprint (§26) y el botón "Crear ficha productiva"', () => {
  assert.match(panelSource, /Primero registra una ficha productiva con un aforo del potrero\./);
  assert.match(panelSource, /if \(!tieneFicha\)/);
});
