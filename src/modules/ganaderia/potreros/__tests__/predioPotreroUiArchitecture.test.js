// SPRINT-3D4 — PREDIO -> POTRERO UI: pruebas arquitectónicas (análisis de
// texto fuente) -- mismo patrón que prediosPageArchitecture.test.js /
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
  // literal (mismo criterio que prediosPageArchitecture.test.js).
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function stripComments(text) {
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const apiSource = readNormalized(path.join(POTREROS_DIR, 'ganaderiaPotrerosApi.js'));
const registrationSource = readNormalized(path.join(POTREROS_DIR, 'PotreroRegistrationPanel.jsx'));
const listPanelSource = readNormalized(path.join(POTREROS_DIR, 'PotrerosByPredioPanel.jsx'));
const previewMapSource = readNormalized(path.join(POTREROS_DIR, 'GanaderiaPotreroPreviewMap.jsx'));
const prediosPageSource = readNormalized(path.join(GANADERIA_DIR, 'predios', 'PrediosPage.jsx'));

const apiCode = stripComments(apiSource);
const registrationCode = stripComments(registrationSource);
const listPanelCode = stripComments(listPanelSource);
const previewMapCode = stripComments(previewMapSource);
const prediosPageCode = stripComments(prediosPageSource);

// ---------------------------------------------------------------------
// A/B/C/D/Y: el botón "Registrar potrero" vive en CADA card y usa el
// predioId de ESA card -- nunca un selector global ni estado compartido.
// ---------------------------------------------------------------------

test('A: PredioCard renderiza el botón "Registrar potrero" dentro de la card individual', () => {
  const fn = prediosPageSource.match(/function PredioCard\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /Registrar potrero/);
});

test('B/C: el botón usa predioId de ESA card -- PotreroRegistrationPanel y PotrerosByPredioPanel reciben predioId={predio.predioId} (prop del predio de la card, no una variable compartida)', () => {
  const fn = prediosPageSource.match(/function PredioCard\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /<PotreroRegistrationPanel\s+predioId=\{predio\.predioId\}/);
  assert.match(fn, /<PotrerosByPredioPanel\s+predioId=\{predio\.predioId\}/);
});

test('D: PrediosPage.jsx nunca declara un selector global de predio para potreros (sin state selectedPredioId/potreroPredioId a nivel de página)', () => {
  assert.doesNotMatch(prediosPageCode, /selectedPredioId/);
  assert.doesNotMatch(prediosPageCode, /potreroPredioId/);
  assert.doesNotMatch(prediosPageCode, /Seleccionar predio/i);
});

test('Y: activePanel (registrar/ver) es state LOCAL de cada PredioCard -- no vive en PrediosPage ni se comparte entre cards', () => {
  const cardFn = prediosPageSource.match(/function PredioCard\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(cardFn, /const \[activePanel, setActivePanel\] = useState\(null\)/);
  // El componente padre (PrediosPage) no declara ningún state de panel de
  // potreros -- cada card lo posee de forma aislada.
  const outsideCard = prediosPageSource.replace(cardFn, '');
  assert.doesNotMatch(outsideCard, /activePanel/);
});

// ---------------------------------------------------------------------
// E/F: "Ver potreros" consulta el endpoint subordinado al predio --
// nunca una lista plana que mezcle potreros de otros predios.
// ---------------------------------------------------------------------

test('E: PotrerosByPredioPanel.jsx consulta GET /api/ganaderia/predios/:predioId/potreros (subordinado, nunca /api/potreros plano)', () => {
  assert.match(apiCode, /export function listPotrerosByPredio\(predioId\) \{\s*return getJson\(`\/api\/ganaderia\/predios\/\$\{predioId\}\/potreros`\);/);
  assert.match(listPanelCode, /listPotrerosByPredio\(predioId\)/);
});

test('F: el useEffect de PotrerosByPredioPanel refetch al cambiar predioId (predioId es parte de la dependencia) -- nunca mezcla potreros entre predios', () => {
  assert.match(listPanelCode, /useEffect\(\(\) => \{[\s\S]*?\n {2}\}, \[predioId, refreshKey\]\);/);
});

// ---------------------------------------------------------------------
// G/H: coordenadas -> preview-coordinates, GPS -> preview-gps.
// ---------------------------------------------------------------------

test('G: previewPotreroCoordinates llama a POST .../potreros/preview-coordinates', () => {
  assert.match(
    apiCode,
    /export function previewPotreroCoordinates\(predioId, puntos\) \{\s*return postJson\(`\/api\/ganaderia\/predios\/\$\{predioId\}\/potreros\/preview-coordinates`, \{ puntos \}\);/,
  );
});

test('H: previewPotreroGps llama a POST .../potreros/preview-gps', () => {
  assert.match(
    apiCode,
    /export function previewPotreroGps\(predioId, puntos\) \{\s*return postJson\(`\/api\/ganaderia\/predios\/\$\{predioId\}\/potreros\/preview-gps`, \{ puntos \}\);/,
  );
});

test('PotreroRegistrationPanel: método coordenadas usa previewPotreroCoordinates, método gps usa previewPotreroGps', () => {
  const fn = registrationCode.match(/async function handlePreview\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(fn, /metodo === 'coordenadas'\s*\?\s*await previewPotreroCoordinates\(predioId, puntos\)\s*:\s*await previewPotreroGps\(predioId, puntos\)/);
});

// ---------------------------------------------------------------------
// I/J: GPS solo bajo acción explícita -- nunca al montar, nunca
// watchPosition.
// ---------------------------------------------------------------------

test('I: captureGpsPoint nunca se dispara en un useEffect al montar -- solo desde onClick del botón "Capturar punto GPS"', () => {
  assert.doesNotMatch(registrationCode, /useEffect\(\(\) => \{\s*captureGpsPoint/);
  assert.match(registrationCode, /onClick=\{captureGpsPoint\}/);
});

test('J: PotreroRegistrationPanel.jsx nunca usa watchPosition (sin tracking continuo, solo getCurrentPosition puntual)', () => {
  assert.doesNotMatch(registrationCode, /watchPosition/);
  assert.match(registrationCode, /navigator\.geolocation\.getCurrentPosition\(/);
});

// ---------------------------------------------------------------------
// K: KML/KMZ deshabilitado/"Próximamente" -- nunca conectado a nada falso.
// ---------------------------------------------------------------------

test('K: la opción KML/KMZ se muestra deshabilitada con copy "Próximamente" -- ningún parser/handler frontend la conecta', () => {
  const methodGrid = registrationSource.match(/<div className="gan-potrero-method-grid"[\s\S]*?<\/div>\s*\n\n\s*<button type="button" className="gan-submit"/)?.[0] ?? '';
  assert.match(methodGrid, /KML\/KMZ · Próximamente/);
  const kmlButton = methodGrid.match(/<button type="button" className="gan-potrero-method-card" disabled>\s*KML\/KMZ · Próximamente\s*<\/button>/);
  assert.ok(kmlButton, 'el botón KML/KMZ debe estar disabled');
  assert.doesNotMatch(registrationCode, /togeojson|xmldom|jszip/i);
});

// ---------------------------------------------------------------------
// L/M/N/O/P/Q: preview muestra área del backend; create usa candidateId
// y NUNCA envía geometry/areaHa/organizacionId/predioId en el body.
// ---------------------------------------------------------------------

test('L: el paso preview muestra previewData.areaHa (calculada server-side), nunca un área calculada en el cliente', () => {
  assert.match(registrationCode, /previewData\.areaHa\.toFixed\(2\)/);
  assert.doesNotMatch(registrationCode, /turf|ST_Area|computeArea/i);
});

test('M/N/O/P/Q: el body de creación es exactamente {candidateId, nombre, capacidadAnimales, observaciones} -- candidateId del candidate, nunca geometry/areaHa/metodoDelimitacion/organizacionId/predioId', () => {
  const fn = registrationCode.match(/async function handleCreate\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  const bodyBlock = fn.match(/const body = \{[\s\S]*?\};/)?.[0] ?? '';
  assert.match(bodyBlock, /candidateId:\s*previewData\.candidateId/);
  assert.match(bodyBlock, /nombre:\s*nombre\.trim\(\)/);
  assert.match(bodyBlock, /capacidadAnimales:/);
  assert.match(bodyBlock, /observaciones:/);
  const forbidden = ['geometry', 'areaHa', 'metodoDelimitacion', 'organizacionId', 'predioId'];
  for (const field of forbidden) {
    assert.doesNotMatch(bodyBlock, new RegExp(`\\b${field}\\b\\s*:`), `el body de creación no debe incluir "${field}"`);
  }
  // Exactamente 4 claves.
  const keyCount = (bodyBlock.match(/^\s*[a-zA-Z]+:/gm) || []).length;
  assert.equal(keyCount, 4, `el body debe tener exactamente 4 claves, se encontraron ${keyCount}`);
});

test('Q (predioId en path, no en body): createPotrero recibe predioId como parámetro de ruta separado del payload', () => {
  assert.match(
    apiCode,
    /export function createPotrero\(predioId, payload\) \{\s*return postJson\(`\/api\/ganaderia\/predios\/\$\{predioId\}\/potreros`, payload\);/,
  );
});

// ---------------------------------------------------------------------
// R: post-save refetch real -- mecanismo EXPLÍCITO y determinístico
// (refreshKey incrementado en un callback síncrono), nunca optimistic
// insert, nunca reload, nunca depende de un cierre/reapertura manual ni
// de que predioId cambie.
// ---------------------------------------------------------------------

test('R.1: handleCreate invoca onCreated() de forma SÍNCRONA justo tras un POST create exitoso (ok === true) -- nunca un setStep intermedio que dependa de una acción manual posterior', () => {
  const fn = registrationCode.match(/async function handleCreate\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  const successBlock = fn.match(/if \(ok\) \{[\s\S]*?\n      \}/)?.[0] ?? '';
  assert.match(successBlock, /setCreating\(false\)/);
  assert.match(successBlock, /onCreated\(\);/);
  assert.match(successBlock, /return;/);
});

test('R.2: PotreroRegistrationPanel.jsx nunca usa window.location.reload ni recarga la página como mecanismo de refetch', () => {
  assert.doesNotMatch(registrationCode, /window\.location\.reload/);
  assert.doesNotMatch(registrationCode, /location\.reload/);
});

test('R.3: PredioCard.handlePotreroCreated incrementa potrerosRefreshKey mediante actualización funcional (determinístico incluso ante llamadas encoladas), fija el mensaje de éxito y cambia a la vista "ver" -- todo en el mismo callback, sin pasos manuales adicionales', () => {
  const cardFn = prediosPageSource.match(/function PredioCard\([\s\S]*?\n\}/)?.[0] ?? '';
  const fn = cardFn.match(/function handlePotreroCreated\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(fn, /setPotrerosRefreshKey\(\(key\) => key \+ 1\)/);
  assert.match(fn, /setPotreroSuccessMessage\('Potrero registrado correctamente\.'\)/);
  assert.match(fn, /setActivePanel\('ver'\)/);
});

test('R.4: PotreroRegistrationPanel recibe onCreated={handlePotreroCreated} -- el mismo callback que orquesta el refreshKey (no una función distinta/no cableada)', () => {
  const cardFn = prediosPageSource.match(/function PredioCard\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(cardFn, /onCreated=\{handlePotreroCreated\}/);
});

test('R.5: PotrerosByPredioPanel recibe refreshKey={potrerosRefreshKey} desde la card -- el mismo state que handlePotreroCreated incrementa (no un valor fijo/no una prop distinta)', () => {
  const cardFn = prediosPageSource.match(/function PredioCard\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(cardFn, /<PotrerosByPredioPanel[\s\S]*?refreshKey=\{potrerosRefreshKey\}/);
});

test('R.6: el useEffect de PotrerosByPredioPanel que hace el GET depende explícitamente de [predioId, refreshKey] -- el refetch NO depende únicamente de que predioId cambie ni de que el componente se desmonte/remonte', () => {
  assert.match(listPanelCode, /useEffect\(\(\) => \{[\s\S]*?\n {2}\}, \[predioId, refreshKey\]\);/);
});

test('R.7: setPotreros SOLO recibe el resultado del GET real (data.potreros) -- nunca un spread/insert optimista sobre el state previo ni sobre el body enviado al crear', () => {
  assert.doesNotMatch(registrationCode, /setPotreros/);
  assert.doesNotMatch(listPanelCode, /setPotreros\(\[\.\.\.potreros/);
  assert.match(listPanelCode, /setPotreros\(data\.potreros\)/);
});

test('R.8: ningún archivo de Potreros usa window.location.reload en ningún punto (list panel, preview map, api client)', () => {
  for (const code of [apiCode, listPanelCode, previewMapCode, prediosPageCode]) {
    assert.doesNotMatch(code, /window\.location\.reload/);
  }
});

// ---------------------------------------------------------------------
// S/T/U: copy amigable exacto para los errores semánticos del backend.
// ---------------------------------------------------------------------

test('S: POTRERO_OUTSIDE_PREDIO -> copy exacto pedido', () => {
  assert.match(registrationSource, /POTRERO_OUTSIDE_PREDIO: 'El potrero debe quedar completamente dentro del predio\.'/);
});

test('T: PREDIO_WITHOUT_GEOMETRY -> copy exacto pedido', () => {
  assert.match(registrationSource, /PREDIO_WITHOUT_GEOMETRY: 'Este predio no tiene un polígono disponible para registrar potreros\.'/);
});

test('INVALID_POTRERO_GEOMETRY -> copy exacto pedido', () => {
  assert.match(registrationSource, /INVALID_POTRERO_GEOMETRY: 'Los puntos ingresados no forman un polígono válido\.'/);
});

test('U: CANDIDATE_EXPIRED -> copy amigable, sin exponer códigos internos', () => {
  assert.match(registrationSource, /CANDIDATE_EXPIRED: 'La vista previa expiró\. Genera una nueva\.'/);
});

test('Ningún mensaje de error expone detalles técnicos (backend/stack/SQL/excepción)', () => {
  const lower = registrationCode.toLowerCase();
  assert.doesNotMatch(lower, /stack trace/);
  assert.doesNotMatch(lower, /\bsql\b/);
  assert.doesNotMatch(lower, /exception/);
});

// ---------------------------------------------------------------------
// V: nunca /api/potreros legacy, nunca ganaderiaApi.js legacy.
// ---------------------------------------------------------------------

test('V: ninguno de los archivos nuevos de Potreros llama a /api/potreros legacy ni importa ganaderiaApi.js', () => {
  const sources = [apiCode, registrationCode, listPanelCode, previewMapCode];
  for (const code of sources) {
    assert.doesNotMatch(code, /['"`]\/api\/potreros/);
    assert.doesNotMatch(code, /from ['"].*\/api\/ganaderiaApi\.js['"]/);
  }
});

test('V: todas las rutas de ganaderiaPotrerosApi.js están bajo /api/ganaderia/predios/:predioId/potreros', () => {
  const apiCalls = apiCode.match(/`\/api\/[a-zA-Z0-9/_${}-]+`/g) || [];
  assert.ok(apiCalls.length >= 5, 'debe haber al menos 5 endpoints (list/get/preview-coordinates/preview-gps/create)');
  for (const call of apiCalls) {
    assert.match(call, /\/api\/ganaderia\/predios\/\$\{predioId\}\/potreros/, `ruta inesperada: ${call}`);
  }
});

test('V: PotreroRegistrationPanel/PotrerosByPredioPanel nunca referencian organizacionId client-side (el tenant se resuelve server-side)', () => {
  assert.doesNotMatch(registrationCode, /organizacionId/);
  assert.doesNotMatch(listPanelCode, /organizacionId/);
});

// ---------------------------------------------------------------------
// W: no toca CatastroX -- componente propio de mapa para Potreros.
// ---------------------------------------------------------------------

test('W: GanaderiaPotreroPreviewMap.jsx nunca importa CatastroXMap ni nada de src/modules/catastrox', () => {
  assert.doesNotMatch(previewMapCode, /CatastroXMap/);
  assert.doesNotMatch(previewMapCode, /from ['"].*catastrox/i);
});

test('W: ningún archivo nuevo de Potreros importa desde src/modules/catastrox', () => {
  const sources = [apiCode, registrationCode, listPanelCode, previewMapCode];
  for (const code of sources) {
    assert.doesNotMatch(code, /catastrox/i);
  }
});

// ---------------------------------------------------------------------
// X: protección responsive/overflow -- método y filas de puntos colapsan
// a 1 columna bajo 900px (mismo criterio que gan-predio-card-body).
// ---------------------------------------------------------------------

test('X: styles.css colapsa gan-potrero-method-grid y gan-potrero-point-row a 1 columna en la media query de 900px', () => {
  const stylesSource = fs.readFileSync(path.resolve(GANADERIA_DIR, '../..', 'styles.css'), 'utf8');
  const afterBreakpoint = stylesSource.split('@media (max-width: 900px)')[1] ?? '';
  const scoped = afterBreakpoint.slice(0, 6000);
  assert.match(scoped, /\.gan-potrero-method-grid\s*\{\s*grid-template-columns:\s*1fr;/);
  assert.match(scoped, /\.gan-potrero-point-row\s*\{\s*grid-template-columns:\s*1fr;/);
});

// ---------------------------------------------------------------------
// Preview map: contorno del predio sin relleno, potrero diferenciado con
// relleno tenue (§11).
// ---------------------------------------------------------------------

test('GanaderiaPotreroPreviewMap.jsx: el contorno del predio no tiene relleno (fillOpacity: 0), el potrero usa un estilo visualmente distinto con relleno tenue', () => {
  assert.match(previewMapSource, /PREDIO_STYLE = \{ color: '#9cff1a', weight: 3, fillOpacity: 0 \}/);
  assert.match(previewMapSource, /POTRERO_STYLE = \{ color: '#00d8ff', weight: 3, fillColor: '#00d8ff', fillOpacity: 0\.12 \}/);
});

// ---------------------------------------------------------------------
// Privacidad GPS (§9): idle al montar, sin captura automática.
// ---------------------------------------------------------------------

test('gpsStatus arranca en "idle" -- nunca se solicita ubicación al montar la vista', () => {
  assert.match(registrationCode, /const \[gpsStatus, setGpsStatus\] = useState\('idle'\)/);
});

// ---------------------------------------------------------------------
// Puntos: mínimo 3, eliminar deshabilitado por debajo del mínimo (§7).
// ---------------------------------------------------------------------

test('MIN_POINTS = 3 y removeCoordPoint nunca reduce por debajo del mínimo', () => {
  assert.match(registrationCode, /const MIN_POINTS = 3;/);
  const fn = registrationCode.match(/function removeCoordPoint\(index\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(fn, /current\.length <= MIN_POINTS \? current : current\.filter/);
});
