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
  assert.match(apiCode, /export function listPotrerosByPredio\(predioId, \{ incluirArchivados = false \} = \{\}\) \{/);
  assert.match(apiCode, /getJson\(`\/api\/ganaderia\/predios\/\$\{predioId\}\/potreros\$\{query\}`\)/);
  assert.match(listPanelCode, /listPotrerosByPredio\(predioId, \{ incluirArchivados: mostrarArchivados \}\)/);
});

test('F: el useEffect de PotrerosByPredioPanel refetch al cambiar predioId (predioId es parte de la dependencia) -- nunca mezcla potreros entre predios', () => {
  assert.match(listPanelCode, /useEffect\(\(\) => \{[\s\S]*?\n {2}\}, \[predioId, refreshKey, mostrarArchivados, internalRefreshKey\]\);/);
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
// K/Z: SPRINT-3D5 -- KML/KMZ habilitado. El parseo/seguridad (togeojson/
// xmldom/jszip) vive EXCLUSIVAMENTE en el backend
// (server/services/ganaderia/potreroKmlImport.js); el frontend nunca
// convierte geometry por su cuenta (ni FileReader, ni las libs server-side).
// ---------------------------------------------------------------------

test('K: la opción KML/KMZ está habilitada -- ya no muestra "Próximamente" ni queda disabled', () => {
  const methodGrid = registrationSource.match(/<div className="gan-potrero-method-grid"[\s\S]*?<\/div>\s*\n\n\s*<button\s+type="button"\s+className="gan-submit"/)?.[0] ?? '';
  assert.doesNotMatch(methodGrid, /Próximamente/);
  assert.match(methodGrid, /onClick=\{\(\) => setMetodo\('kml'\)\}[\s\S]*?KML\/KMZ/);
  assert.doesNotMatch(methodGrid, /<button[^>]*className="gan-potrero-method-card"[^>]*disabled/);
});

test('Z1: el frontend nunca parsea/convierte geometry por su cuenta -- ni FileReader ni las libs de parseo server-side (togeojson/xmldom/jszip)', () => {
  for (const code of [registrationCode, apiCode]) {
    assert.doesNotMatch(code, /togeojson|xmldom|jszip|FileReader/i);
  }
});

test('Z2: el input file solo acepta .kml/.kmz', () => {
  assert.match(registrationCode, /<input[^>]*type="file"[^>]*accept="\.kml,\.kmz"/);
});

test('Z3: previewPotreroFile (ganaderiaPotrerosApi.js) llama a POST .../potreros/preview-file bajo /api/ganaderia/predios/:predioId/potreros, y el archivo viaja como body crudo (nunca JSON.stringify del archivo)', () => {
  assert.match(
    apiCode,
    /export async function previewPotreroFile\(predioId, file\) \{[\s\S]*?\/api\/ganaderia\/predios\/\$\{predioId\}\/potreros\/preview-file[\s\S]*?\n\}/,
  );
  const fn = apiCode.match(/export async function previewPotreroFile\(predioId, file\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /body:\s*file/);
  assert.doesNotMatch(fn, /JSON\.stringify\(file\)/);
});

test('Z4: la subida usa previewPotreroFile (handleFileChange), y candidateId proviene EXCLUSIVAMENTE de la respuesta del backend -- nunca generado en el cliente', () => {
  const fn = registrationCode.match(/async function handleFileChange\(event\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(fn, /previewPotreroFile\(predioId, file\)/);
  assert.doesNotMatch(registrationCode, /randomUUID|crypto\.random|Math\.random\(\).*candidateId/i);
  const applyFn = registrationCode.match(/function applyFileCandidate\(candidate\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(applyFn, /candidateId:\s*candidate\.candidateId/);
});

test('Z5: múltiples candidates del mismo archivo se muestran SEPARADOS (lista), nunca se registran todos automáticamente', () => {
  const fn = registrationCode.match(/async function handleFileChange\(event\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  // Un único candidate salta directo a preview; con más de uno, se guardan
  // en fileCandidates para que el usuario elija -- nunca un bucle que
  // llame applyFileCandidate/createPotrero por cada uno automáticamente.
  assert.match(fn, /candidates\.length === 1/);
  assert.match(fn, /setFileCandidates\(candidates\)/);
  assert.doesNotMatch(fn, /candidates\.forEach\(.*applyFileCandidate/);
  assert.doesNotMatch(fn, /candidates\.forEach\(.*createPotrero/);
  assert.match(registrationCode, /fileCandidates\.map\(\(candidate, index\) =>/);
});

test('Z6: la selección de un candidate KML reutiliza el mismo shape de previewData que coordenadas/gps -- el paso preview y handleCreate no tienen lógica separada por método', () => {
  const applyFn = registrationCode.match(/function applyFileCandidate\(candidate\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(applyFn, /setPreviewData\(\{\s*candidateId:\s*candidate\.candidateId,\s*areaHa:\s*candidate\.areaHa,\s*geometry:\s*candidate\.geometry,\s*metodoDelimitacion:\s*candidate\.metodoDelimitacion,\s*validacion:\s*candidate\.validacion,\s*\}\);/);
  assert.match(applyFn, /setStep\('preview'\)/);
});

test('Z7: previewPotreroFile siempre recibe predioId de la prop del componente (nunca un id distinto/seleccionable) -- misma garantía de aislamiento entre predios que coordenadas/gps', () => {
  const fn = registrationCode.match(/async function handleFileChange\(event\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(fn, /previewPotreroFile\(predioId, file\)/);
  assert.doesNotMatch(registrationCode, /previewPotreroFile\([^p][\s\S]*?\)/);
});

// ---------------------------------------------------------------------
// SPRINT-3D5-CIERRE-SEMANTICO: geometrías no poligonales nunca se
// procesan en silencio (§1); KMZ con >1 .kml es ambiguo y se rechaza con
// copy propio (§2).
// ---------------------------------------------------------------------

test('G: si preview-file devuelve elementos ignorados, el frontend muestra un aviso amigable con las cantidades -- nunca en silencio', () => {
  assert.match(registrationCode, /function describeIgnoredElements\(ignorados\)/);
  const fn = registrationCode.match(/function describeIgnoredElements\(ignorados\)\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /ignorados\.points/);
  assert.match(fn, /ignorados\.lineStrings/);
  assert.match(fn, /ignorados\.multiLineStrings/);

  const handleFn = registrationCode.match(/async function handleFileChange\(event\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(handleFn, /setFileIgnoredNotice\(describeIgnoredElements\(data\?\.ignorados\)/);

  // El aviso debe seguir visible tanto en la lista de candidates como en
  // el paso preview (el caso de 1 solo candidate salta directo a preview).
  assert.match(registrationCode, /fileIgnoredNotice \? <StatusMessage type="info">\{fileIgnoredNotice\}<\/StatusMessage> : null/);
  assert.match(registrationCode, /metodo === 'kml' && fileIgnoredNotice/);
});

// ---------------------------------------------------------------------
// SPRINT-3D5.1-KML-CLOSED-LINESTRING §10/§J: si preview-file reporta un
// LineString cerrado convertido a Polygon (convertidos.closedLineStrings),
// el frontend muestra un aviso amigable propio, nunca en silencio, sin
// bloquear el preview ni cambiar el flujo final de candidateId.
// ---------------------------------------------------------------------

test('J: si preview-file convirtió un LineString cerrado en Polygon, el frontend muestra un aviso amigable de conversión -- nunca en silencio', () => {
  assert.match(registrationCode, /function describeConversionNotice\(convertidos\)/);
  const fn = registrationCode.match(/function describeConversionNotice\(convertidos\)\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /convertidos\?\.closedLineStrings/);
  assert.match(fn, /interpretó como polígono del potrero/);

  const handleFn = registrationCode.match(/async function handleFileChange\(event\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(handleFn, /setFileConversionNotice\(describeConversionNotice\(data\?\.convertidos\)/);

  // Mismo criterio que fileIgnoredNotice: visible tanto en la lista de
  // candidates como en el paso preview.
  assert.match(
    registrationCode,
    /fileConversionNotice \? <StatusMessage type="info">\{fileConversionNotice\}<\/StatusMessage> : null/,
  );
  assert.match(registrationCode, /metodo === 'kml' && fileConversionNotice/);
});

test('H: KMZ con varios .kml (KMZ_MULTIPLE_KML_FILES) muestra copy amigable propio, distinto del resto de errores de archivo', () => {
  assert.match(
    registrationSource,
    /KMZ_MULTIPLE_KML_FILES:\s*\n?\s*'El archivo KMZ contiene varios archivos KML\. Exporta el potrero en un KMZ con un solo archivo KML principal\.'/,
  );
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
  assert.match(listPanelCode, /useEffect\(\(\) => \{[\s\S]*?\n {2}\}, \[predioId, refreshKey, mostrarArchivados, internalRefreshKey\]\);/);
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

// SPRINT-3D5.2 §12: POTRERO_OUTSIDE_PREDIO ahora significa "más allá del
// margen de tolerancia operacional" (una diferencia pequeña se acepta
// como TOLERANCE_OK sin llegar a este código) -- el copy exacto del
// sprint 3D4 queda reemplazado por el copy exacto pedido en 3D5.2 §12.
test('S: POTRERO_OUTSIDE_PREDIO -> copy exacto pedido (§12, sprint 3D5.2)', () => {
  assert.match(
    registrationSource,
    /POTRERO_OUTSIDE_PREDIO:\s*\n?\s*'Una parte importante del potrero se encuentra fuera del límite registrado del predio\. Revisa la delimitación antes de continuar\.'/,
  );
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

// ---------------------------------------------------------------------
// SPRINT-3D5.2-OPERATIONAL-SPATIAL-TOLERANCE: aviso TOLERANCE_OK (§11),
// preview de solo lectura para OUTSIDE (§13), accuracy GPS (§7/§19), y
// "nunca ajuste de geometría client-side" (regla crítica del sprint).
// ---------------------------------------------------------------------

test('§11: aviso TOLERANCE_OK -- copy exacto pedido, mostrado como StatusMessage type="info" (nunca error)', () => {
  assert.match(
    registrationCode,
    /const TOLERANCE_OK_NOTICE =\s*\n?\s*'El potrero presenta una pequeña diferencia respecto al límite registrado del predio\. Se considera una delimitación operativa válida\.'/,
  );
  assert.match(
    registrationCode,
    /previewData\.validacion\?\.estado === 'TOLERANCE_OK'[\s\S]{0,80}<StatusMessage type="info">\{TOLERANCE_OK_NOTICE\}<\/StatusMessage>/,
  );
});

test('§13: OUTSIDE (rejected) se renderiza en GanaderiaPotreroPreviewMap vía la prop rejectedGeometry -- nunca como candidate/preview normal', () => {
  assert.match(registrationCode, /rejectedGeometry=\{rejectedPreview\.geometry\}/);
  // El estado rejectedPreview nunca trae candidateId -- solo geometry de
  // solo lectura (comentario junto a la declaración del state, ver arriba).
  assert.match(registrationCode, /const \[rejectedPreview, setRejectedPreview\] = useState\(null\)/);
});

test('§13: GanaderiaPotreroPreviewMap acepta rejectedGeometry con estilo distinto (rojo) del potrero aceptado -- nunca el mismo estilo', () => {
  assert.match(previewMapCode, /POTRERO_REJECTED_STYLE = \{ color: '#ff4d4d'/);
  assert.doesNotMatch(previewMapCode, /POTRERO_REJECTED_STYLE = \{ color: '#00d8ff'/);
});

test('§7/§19: cada punto GPS capturado guarda accuracy (navigator.geolocation.coords.accuracy) -- coordenadas manuales nunca la reportan', () => {
  assert.match(registrationCode, /const accuracy = Number\.isFinite\(position\.coords\.accuracy\) \? position\.coords\.accuracy : null/);
  // El body de coordenadas (emptyPoint) nunca incluye accuracy.
  assert.match(registrationCode, /function emptyPoint\(\)\s*\{\s*return \{ latitud: '', longitud: '' \};\s*\}/);
});

test('§7: accuracy por encima de GPS_MAX_ACCURACY_M se rechaza client-side ANTES de agregar el punto -- pide recaptura, nunca inventa/recorta el valor', () => {
  assert.match(registrationCode, /const GPS_MAX_ACCURACY_M = 100;/);
  assert.match(
    registrationCode,
    /accuracy !== null && accuracy > GPS_MAX_ACCURACY_M[\s\S]{0,80}setGpsStatus\('low_accuracy'\)[\s\S]{0,20}return;/,
  );
});

test('§7: accuracy viaja en el body de preview-gps SOLO para método gps -- nunca para coordenadas', () => {
  const fn = registrationCode.match(/async function handlePreview\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(fn, /metodo === 'gps' && point\.accuracy !== null && point\.accuracy !== undefined/);
});

test('§13/§23: OUTSIDE en coordenadas/gps nunca llama setStep(\'preview\') -- sin candidate no hay nada que confirmar, el botón "Registrar potrero" no puede aparecer', () => {
  const fn = registrationCode.match(/async function handlePreview\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  const outsideBranch = fn.match(/if \(data\?\.error === 'POTRERO_OUTSIDE_PREDIO'[\s\S]*?setPreviewLoading\(false\);/)?.[0] ?? '';
  assert.notEqual(outsideBranch, '');
  assert.doesNotMatch(outsideBranch, /setStep\(/);
  // setStep('preview') solo debe aparecer UNA vez en todo handlePreview
  // -- la rama de éxito (ok && candidateId && preview), nunca la de error.
  assert.equal((fn.match(/setStep\('preview'\)/g) || []).length, 1);
});

test('Regla crítica del sprint: PotreroRegistrationPanel/GanaderiaPotreroPreviewMap NUNCA ajustan/recortan la geometría en el cliente (sin turf, sin buffer/snap/clip, sin recalcular vértices)', () => {
  for (const code of [registrationCode, previewMapCode]) {
    assert.doesNotMatch(code, /turf\./);
    assert.doesNotMatch(code, /\bbuffer\(/i);
    assert.doesNotMatch(code, /\bsnap\(/i);
    assert.doesNotMatch(code, /ST_(Buffer|Snap|Clip|Intersection|MakeValid|Union|Difference)/);
  }
});

// ---------------------------------------------------------------------
// SPRINT-3D9.2 (PRE-COMMIT FINAL ROUND, punto 2/3/4): archivar/restaurar
// potrero -- reemplaza el hard DELETE (nunca existió). "Eliminar potrero"
// archiva (motivo obligatorio); "Restaurar potrero" reactiva y maneja
// explícitamente el 409 PREDIO_ARCHIVADO (predio padre aún archivado).
// Listado por defecto solo ACTIVO, con "Ver archivados" como único
// punto de acceso explícito.
// ---------------------------------------------------------------------

function extractPotreroCardFn() {
  // Greedy (no "?") a propósito: la firma de PotreroCard desestructura
  // props en múltiples líneas (`}) {` cierra esa desestructuración antes
  // del cuerpo real) -- un match no-greedy se detendría ahí. PotreroCard
  // es la última función del archivo, así que greedy captura hasta el
  // cierre real de la función (fin de archivo), sin sobrepasarlo.
  return listPanelCode.match(/function PotreroCard\([\s\S]*\n\}/)?.[0] ?? '';
}

test('PotreroCard: "Eliminar potrero" solo se muestra cuando el potrero NO está archivado; "Restaurar potrero" solo cuando SÍ lo está', () => {
  const fn = extractPotreroCardFn();
  assert.notEqual(fn, '');
  assert.match(fn, /const archivado = potrero\.estado === 'ARCHIVADO';/);
  assert.match(fn, /\{!archivado \? \(/);
  assert.match(fn, /Eliminar potrero/);
  assert.match(fn, /\) : \(/);
  assert.match(fn, /Restaurar potrero/);
});

test('PotreroCard: archivar exige motivo no vacío antes de llamar al endpoint', () => {
  const fn = extractPotreroCardFn();
  const handler = fn.match(/async function handleConfirmarArchivar\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(handler, /if \(motivoArchivar\.trim\(\) === ''\)/);
  assert.match(handler, /setArchivoError\('Escribe el motivo\.'\)/);
  assert.match(handler, /return;/);
});

test('PotreroCard: archivar/restaurar usan archivarPotrero/restaurarPotrero de ganaderiaPotrerosApi.js (endpoints POST .../archivar y .../restaurar ya probados server-side)', () => {
  const fn = extractPotreroCardFn();
  assert.match(fn, /archivarPotrero\(predioId, potrero\.potreroId, motivoArchivar\.trim\(\)\)/);
  assert.match(fn, /restaurarPotrero\(predioId, potrero\.potreroId\)/);
  assert.match(apiCode, /export function archivarPotrero\(predioId, potreroId, motivo\) \{\s*return postJson\(`\/api\/ganaderia\/predios\/\$\{predioId\}\/potreros\/\$\{potreroId\}\/archivar`, \{ motivo \}\);/);
  assert.match(apiCode, /export function restaurarPotrero\(predioId, potreroId\) \{\s*return postJson\(`\/api\/ganaderia\/predios\/\$\{predioId\}\/potreros\/\$\{potreroId\}\/restaurar`, \{\}\);/);
});

test('PotreroCard: restaurarPotrero maneja explícitamente el 409 PREDIO_ARCHIVADO -- mensaje claro, nunca un error genérico ni un código expuesto sin traducir', () => {
  const fn = extractPotreroCardFn();
  const handler = fn.match(/async function handleRestaurar\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(handler, /data\?\.error === 'PREDIO_ARCHIVADO'/);
  assert.match(handler, /No se puede restaurar: el predio de este potrero sigue archivado/);
});

test('PotreroCard: tras archivar/restaurar exitoso invoca onArchivoChanged() -- refetch real, nunca insert optimista', () => {
  const fn = extractPotreroCardFn();
  const archivarFn = fn.match(/async function handleConfirmarArchivar\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  const restaurarFn = fn.match(/async function handleRestaurar\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(archivarFn, /onArchivoChanged\?\.\(\);/);
  assert.match(restaurarFn, /onArchivoChanged\?\.\(\);/);
});

test('PotrosByPredioPanel: "Ver archivados" es el único punto de acceso explícito para ver potreros ARCHIVADO -- alterna mostrarArchivados, dispara refetch vía el useEffect', () => {
  assert.match(listPanelCode, /const \[mostrarArchivados, setMostrarArchivados\] = useState\(false\)/);
  assert.match(listPanelCode, /setMostrarArchivados\(\(current\) => !current\)/);
  assert.match(listPanelCode, /\{mostrarArchivados \? 'Ver activos' : 'Ver archivados'\}/);
});

test('PotrerosByPredioPanel: el botón "Ver archivados" se renderiza en TODOS los estados (loading/error/vacío/lista) -- el usuario puede alternar incluso si la vista activa está vacía', () => {
  assert.match(listPanelCode, /const toggleArchivadosButton = \(/);
  const occurrences = (listPanelCode.match(/\{toggleArchivadosButton\}/g) || []).length;
  assert.equal(occurrences, 4, `se esperaban 4 usos de toggleArchivadosButton (loading/error/vacío/lista), se encontraron ${occurrences}`);
});

test('Ninguno de los archivos de Potreros/Predios declara o llama un hard DELETE (sin fetch method DELETE, sin ruta /eliminar-definitivamente)', () => {
  for (const code of [apiCode, listPanelCode, prediosPageCode]) {
    assert.doesNotMatch(code, /method:\s*'DELETE'/);
    assert.doesNotMatch(code, /eliminar-definitivamente/i);
  }
});
