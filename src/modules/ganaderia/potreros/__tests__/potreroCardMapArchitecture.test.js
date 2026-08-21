// SPRINT-3D5.3 — POTRERO CARD MAP: pruebas arquitectónicas (análisis de
// texto fuente) -- mismo patrón que predioPotreroUiArchitecture.test.js /
// misPrediosListArchitecture.test.js. Este repo no tiene jsdom/
// testing-library configurado para render real de componentes React en
// `test:node`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POTREROS_DIR = path.resolve(__dirname, '..');
const GANADERIA_DIR = path.resolve(POTREROS_DIR, '..');

function readNormalized(filePath) {
  // CRLF->LF: en checkouts Windows con core.autocrlf=true el archivo se
  // materializa con \r\n -- normalizamos antes de anclar regex en \n
  // literal (mismo criterio que predioPotreroUiArchitecture.test.js).
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function stripComments(text) {
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const listPanelSource = readNormalized(path.join(POTREROS_DIR, 'PotrerosByPredioPanel.jsx'));
const cardMapSource = readNormalized(path.join(POTREROS_DIR, 'GanaderiaPotreroCardMap.jsx'));
const apiSource = readNormalized(path.join(POTREROS_DIR, 'ganaderiaPotrerosApi.js'));
const stylesSource = readNormalized(path.resolve(GANADERIA_DIR, '../..', 'styles.css'));

const listPanelCode = stripComments(listPanelSource);
const cardMapCode = stripComments(cardMapSource);

// ---------------------------------------------------------------------
// Área: ha autoritativo del backend + m² derivado SOLO para presentación.
// ---------------------------------------------------------------------

test('formatAreaHa/formatAreaM2 usan es-CO con 2 decimales', () => {
  const haFn = listPanelCode.match(/function formatAreaHa\(value\)\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  const m2Fn = listPanelCode.match(/function formatAreaM2\(value\)\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(haFn, /toLocaleString\('es-CO', \{ minimumFractionDigits: 2, maximumFractionDigits: 2 \}\)/);
  assert.match(m2Fn, /toLocaleString\('es-CO', \{ minimumFractionDigits: 2, maximumFractionDigits: 2 \}\)/);
});

test('formatAreaM2 deriva m² como areaHa * 10000 (conversión de unidad, nunca un recálculo geométrico)', () => {
  const m2Fn = listPanelCode.match(/function formatAreaM2\(value\)\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(m2Fn, /num \* 10000/);
  assert.doesNotMatch(m2Fn, /turf|ST_Area|geometry/i);
});

test('el área ha (formatAreaHa) y el área m² (formatAreaM2) se muestran ambas dentro de la misma fila "Área" de la card', () => {
  const cardBlock =
    listPanelCode.match(/<div className="gan-ficha-row">\s*<span>Área<\/span>[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.match(cardBlock, /formatAreaHa\(potrero\.areaHa\)/);
  assert.match(cardBlock, /formatAreaM2\(potrero\.areaHa\)/);
});

test('el área NUNCA se recalcula en el frontend desde geometry -- ambas funciones parten de potrero.areaHa (backend)', () => {
  assert.doesNotMatch(listPanelCode, /turf|ST_Area|computeArea/i);
});

// ---------------------------------------------------------------------
// Layout de tarjeta: dos columnas (datos | mapa), mismo patrón que
// .gan-predio-card, con observaciones condicionales.
// ---------------------------------------------------------------------

test('la card de potrero usa el layout de dos columnas gan-potrero-card-body (datos | mapa), no la lista plana anterior', () => {
  assert.match(listPanelCode, /className="gan-potrero-card"/);
  assert.match(listPanelCode, /className="gan-potrero-card-body"/);
  assert.match(listPanelCode, /className="gan-potrero-data"/);
  assert.match(listPanelCode, /className="gan-potrero-map-wrap"/);
});

test('observaciones solo se renderiza si existe (condicional, no fila vacía)', () => {
  assert.match(listPanelCode, /\{potrero\.observaciones \? \(/);
  assert.match(listPanelCode, /<span>Observaciones<\/span>/);
});

test('styles.css define gan-potrero-card-body como grid de dos columnas 40/60 en desktop', () => {
  assert.match(
    stylesSource,
    /\.gan-potrero-card-body\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*minmax\(200px,\s*0\.4fr\)\s*minmax\(260px,\s*0\.6fr\);/,
  );
});

test('mobile (<=900px, mismo breakpoint que gan-predio-card-body): gan-potrero-card-body colapsa a 1 columna y el mapa mantiene 280-320px de alto', () => {
  const afterBreakpoint = stylesSource.split('@media (max-width: 900px)')[1] ?? '';
  const scoped = afterBreakpoint.slice(0, 8000);
  assert.match(scoped, /\.gan-potrero-card-body\s*\{\s*grid-template-columns:\s*1fr;/);
  assert.match(scoped, /\.gan-potrero-card-map,\s*\n\s*\.gan-potrero-card-map-canvas\s*\{\s*height:\s*300px;/);
});

// ---------------------------------------------------------------------
// Mapa: fuente de geometría, aislamiento predioId+potreroId, fitBounds al
// potrero (nunca solo al predio), predio como contexto sin relleno,
// solo lectura, y manejo de error contenido al área del mapa.
// ---------------------------------------------------------------------

test('GanaderiaPotreroCardMap es un componente PROPIO -- no reutiliza GanaderiaPotreroPreviewMap (evita mezclar lógica de preview/registro con la de solo lectura)', () => {
  assert.doesNotMatch(cardMapCode, /GanaderiaPotreroPreviewMap/);
  assert.match(listPanelCode, /import GanaderiaPotreroCardMap from '\.\/GanaderiaPotreroCardMap\.jsx';/);
  assert.match(
    listPanelCode,
    /<GanaderiaPotreroCardMap\s+predioId=\{predioId\}\s+potreroId=\{potrero\.potreroId\}\s+predioGeometry=\{predioGeometry\}\s*\/>/,
  );
});

test('la geometría del potrero viene EXCLUSIVAMENTE del detalle tenant-safe getPotreroByPredio(predioId, potreroId) -- nunca de la lista (que no trae geometry)', () => {
  assert.match(cardMapCode, /getPotreroByPredio\(predioId, potreroId\)/);
  assert.match(
    apiSource.replace(/\/\/.*$/gm, ''),
    /export function getPotreroByPredio\(predioId, potreroId\) \{\s*return getJson\(`\/api\/ganaderia\/predios\/\$\{predioId\}\/potreros\/\$\{potreroId\}`\);/,
  );
});

test('el useEffect de GanaderiaPotreroCardMap depende de [predioId, potreroId] -- un fetch de detalle por potrero por montaje, nunca mezcla entre predios', () => {
  assert.match(cardMapCode, /useEffect\(\(\) => \{[\s\S]*?\n {2}\}, \[predioId, potreroId\]\);/);
});

test('fitBounds usa la geometría del POTRERO (potreroBounds), nunca únicamente la del predio', () => {
  assert.match(cardMapCode, /bounds=\{potreroBounds\}/);
  assert.doesNotMatch(cardMapCode, /bounds=\{predioBounds\}/);
});

test('el predio base se dibuja sin relleno (contexto) y el potrero con contorno cian y relleno tenue', () => {
  assert.match(cardMapCode, /PREDIO_STYLE = \{ color: '#9cff1a', weight: 3, fillOpacity: 0 \}/);
  assert.match(cardMapCode, /POTRERO_STYLE = \{ color: '#00d8ff', weight: 3, fillColor: '#00d8ff', fillOpacity: 0\.12 \}/);
});

test('el mapa es de SOLO LECTURA -- interacciones deshabilitadas (dragging/scrollWheelZoom/doubleClickZoom/touchZoom/zoomControl en false)', () => {
  assert.match(cardMapCode, /dragging=\{false\}/);
  assert.match(cardMapCode, /scrollWheelZoom=\{false\}/);
  assert.match(cardMapCode, /doubleClickZoom=\{false\}/);
  assert.match(cardMapCode, /touchZoom=\{false\}/);
  assert.match(cardMapCode, /zoomControl=\{false\}/);
});

test('si la geometría del potrero no carga, se muestra el mensaje de error dentro del área del mapa (nunca un throw ni una card rota)', () => {
  assert.match(cardMapCode, /No fue posible cargar el mapa del potrero\./);
  const errorBranch =
    cardMapCode.match(/if \(potreroStatus !== 'ready'[\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.match(errorBranch, /MAP_ERROR_MESSAGE/);
});

test('un fallo al cargar el mapa del potrero NUNCA oculta los datos de la card -- el mapa vive en un sub-árbol propio (gan-potrero-map-wrap), separado de gan-potrero-data', () => {
  const bodyBlock = listPanelCode.match(/<div className="gan-potrero-card-body">[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? '';
  const dataIndex = bodyBlock.indexOf('gan-potrero-data');
  const mapIndex = bodyBlock.indexOf('gan-potrero-map-wrap');
  assert.ok(dataIndex >= 0 && mapIndex >= 0 && dataIndex < mapIndex);
});

// ---------------------------------------------------------------------
// No legacy, no CatastroX, tenant isolation.
// ---------------------------------------------------------------------

test('GanaderiaPotreroCardMap nunca llama a /api/potreros legacy ni importa ganaderiaApi.js/CatastroX', () => {
  assert.doesNotMatch(cardMapCode, /['"`]\/api\/potreros/);
  assert.doesNotMatch(cardMapCode, /from ['"].*\/api\/ganaderiaApi\.js['"]/);
  assert.doesNotMatch(cardMapCode, /catastrox/i);
});

test('GanaderiaPotreroCardMap nunca referencia organizacionId client-side (el tenant se resuelve server-side vía sesión)', () => {
  assert.doesNotMatch(cardMapCode, /organizacionId/);
});

test('el único fetch directo restante en GanaderiaPotreroCardMap.jsx está subordinado a /api/ganaderia/predios/:predioId (vía getPotreroByPredio, sin literal propio)', () => {
  const apiCalls = cardMapCode.match(/`\/api\/[a-zA-Z0-9/_${}-]+`/g) || [];
  for (const call of apiCalls) {
    assert.match(call, /\/api\/ganaderia\/predios\/\$\{predioId\}/, `ruta inesperada: ${call}`);
  }
});

// ---------------------------------------------------------------------
// SPRINT-3D5.3-PERF §1/§2/§6: la geometry del predio se resuelve UNA sola
// vez por predioId en PotrerosByPredioPanel.jsx -- nunca por card. Con N
// potreros montados el conteo esperado de requests es: 1 GET lista +
// 1 GET detalle predio + N GET detalle potrero (nunca N GET predio).
// ---------------------------------------------------------------------

test('§1/§2: GanaderiaPotreroCardMap.jsx YA NO pide la geometry del predio -- ningún fetch/GET a /api/ganaderia/predios/:predioId dentro de este archivo (solo getPotreroByPredio, subordinado a :potreroId)', () => {
  assert.doesNotMatch(cardMapCode, /fetch\(`\/api\/ganaderia\/predios\/\$\{predioId\}`/);
  assert.doesNotMatch(cardMapCode, /`\/api\/ganaderia\/predios\/\$\{predioId\}`(?!\/potreros)/);
});

test('§2: PotrerosByPredioPanel.jsx resuelve la geometry del predio EXACTAMENTE una vez por render de módulo -- un único literal fetch(`/api/ganaderia/predios/${predioId}`) en todo el archivo (no uno por card/potrero)', () => {
  const predioFetchLiterals = listPanelCode.match(/fetch\(`\/api\/ganaderia\/predios\/\$\{predioId\}`/g) || [];
  assert.equal(predioFetchLiterals.length, 1, `se esperaba exactamente 1 fetch de detalle de predio, se encontraron ${predioFetchLiterals.length}`);
});

test('§2: el fetch de geometry del predio vive en su propio useEffect con dependencia [predioId] -- se dispara una vez por predioId, nunca se re-dispara por N potreros ni por refreshKey', () => {
  const fn = listPanelCode.match(/useEffect\(\(\) => \{\s*let active = true;\s*setPredioGeometry\(null\);[\s\S]*?\n {2}\}, \[predioId\]\);/)?.[0] ?? '';
  assert.notEqual(fn, '', 'no se encontró el useEffect de predioGeometry con dependencia [predioId]');
  assert.match(fn, /fetch\(`\/api\/ganaderia\/predios\/\$\{predioId\}`, \{ credentials: 'include' \}\)/);
});

test('§2: predioGeometry se pasa como PROP compartida a cada GanaderiaPotreroCardMap dentro del .map() de potreros -- una sola fuente de verdad, nunca recalculada/refetcheada por card', () => {
  const mapBlock = listPanelCode.match(/\{potreros\.map\(\(potrero\) => \([\s\S]*?\)\)\}/)?.[0] ?? '';
  assert.match(mapBlock, /predioGeometry=\{predioGeometry\}/);
  // Un único componente GanaderiaPotreroCardMap dentro del loop -- N potreros
  // producen N instancias (N GET detalle potrero), pero comparten la misma
  // prop predioGeometry (1 GET detalle predio total).
  assert.equal((mapBlock.match(/<GanaderiaPotreroCardMap/g) || []).length, 1);
});

test('§4: predioGeometry ausente/null (aún no cargó o el GET falló) nunca oculta la card ni el mapa del potrero -- solo se omite el layer verde de contexto', () => {
  assert.match(cardMapCode, /const predioLatLngs = extractRingLatLngs\(predioGeometry\);/);
  assert.match(cardMapCode, /const predioFeature = predioLatLngs \? \{ type: 'Feature', properties: \{\}, geometry: predioGeometry \} : null;/);
  // El render del potrero (bounds/feature) no depende de predioFeature/predioLatLngs.
  const readyReturn = cardMapCode.match(/return \(\s*<div className="gan-potrero-card-map">[\s\S]*?\n {2}\);\s*\n\}/)?.[0] ?? '';
  assert.match(readyReturn, /\{predioFeature \? <GeoJSON key="predio-base" data=\{predioFeature\} style=\{PREDIO_STYLE\} \/> : null\}/);
  assert.match(readyReturn, /<GeoJSON key="potrero" data=\{potreroFeature\} style=\{POTRERO_STYLE\} \/>/);
});

test('§6: dos predios distintos -- el useEffect de predioGeometry depende de [predioId] (no de un id fijo/global), así que cada panel resuelve únicamente el predio que le corresponde sin mezclar geometry entre predios', () => {
  // setPredioGeometry(null) al inicio del efecto: si predioId cambia (dos
  // paneles con predios distintos, o el mismo panel remontado con otro
  // predioId), el estado se limpia antes de pedir la geometry correcta --
  // nunca se reutiliza involuntariamente la del predio anterior.
  const fn = listPanelCode.match(/useEffect\(\(\) => \{\s*let active = true;\s*setPredioGeometry\(null\);[\s\S]*?\n {2}\}, \[predioId\]\);/)?.[0] ?? '';
  assert.notEqual(fn, '');
  assert.match(fn, /setPredioGeometry\(null\);/);
  assert.match(fn, /setPredioGeometry\(data\?\.geometry \|\| null\);/);
});
