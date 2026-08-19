// SPRINT-3C4 — MIS PREDIOS REGISTRADOS: pruebas arquitectónicas (análisis
// de texto fuente) -- mismo patrón que prediosPageArchitecture.test.js.
// Este repo no tiene jsdom/testing-library configurado para render real
// de componentes React en `test:node`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREDIOS_DIR = path.resolve(__dirname, '..');

const source = fs.readFileSync(path.join(PREDIOS_DIR, 'PrediosPage.jsx'), 'utf8');
const miniMapSource = fs.readFileSync(path.join(PREDIOS_DIR, 'GanaderiaPredioMiniMap.jsx'), 'utf8');

function stripComments(text) {
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const codeOnly = stripComments(source);

// ---------------------------------------------------------------------
// 1. GET al montar
// ---------------------------------------------------------------------

test('PrediosPage.jsx: useEffect con deps [] llama a reloadRegisteredPredios al montar', () => {
  assert.match(
    codeOnly,
    /useEffect\(\(\) => \{\s*reloadRegisteredPredios\(\);\s*\}, \[\]\);/,
  );
});

test('fetchRegisteredPrediosList: hace GET a /api/ganaderia/predios con credentials include, nunca al router legacy /api/predios', () => {
  const fn = codeOnly.match(/async function fetchRegisteredPrediosList\(\)\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /fetch\('\/api\/ganaderia\/predios',\s*\{\s*credentials:\s*'include'\s*\}\)/);
});

// ---------------------------------------------------------------------
// 2. Loading
// ---------------------------------------------------------------------

test('PrediosPage.jsx: prediosListLoading arranca en true (no parpadeo de "vacío" antes del primer fetch)', () => {
  assert.match(codeOnly, /const \[prediosListLoading, setPrediosListLoading\] = useState\(true\)/);
});

test('MisPrediosSection: si loading=true, muestra StatusMessage de carga antes que vacío/error/listado', () => {
  const fn = source.match(/function MisPrediosSection\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /if \(loading\) \{\s*return <StatusMessage>Cargando tus predios registrados\.\.\.<\/StatusMessage>;/);
});

// ---------------------------------------------------------------------
// 3. Vacío
// ---------------------------------------------------------------------

test('MisPrediosSection: lista vacía muestra el mensaje "Aún no tienes predios registrados."', () => {
  assert.match(source, /const LIST_EMPTY_MESSAGE = 'Aún no tienes predios registrados\.'/);
  const fn = source.match(/function MisPrediosSection\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /predios\.length === 0/);
  assert.match(fn, /\{LIST_EMPTY_MESSAGE\}/);
});

// ---------------------------------------------------------------------
// 4. Render de predio + 5. nulls
// ---------------------------------------------------------------------

test('PredioCard: usa nombrePredio, departamento, municipio, vereda, areaDeclaradaHa y codigoPredial del GET -- ningún otro campo del row', () => {
  const fn = source.match(/function PredioCard\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /predio\.nombrePredio/);
  assert.match(fn, /predio\.departamento/);
  assert.match(fn, /predio\.municipio/);
  assert.match(fn, /predio\.vereda/);
  assert.match(fn, /predio\.areaDeclaradaHa/);
  assert.match(fn, /predio\.codigoPredial/);
});

test('PredioCard: nunca renderiza predioId, organizacionId, geometry cruda ni snapshot como texto visible -- predioId solo se usa como key/prop del mini-mapa', () => {
  const fn = source.match(/function PredioCard\([\s\S]*?\n\}/)?.[0] ?? '';
  // predioId puede pasarse como prop a GanaderiaPredioMiniMap (predioId={predio.predioId})
  // o como React key, pero nunca debe imprimirse como texto visible en un nodo de contenido.
  assert.doesNotMatch(fn, /<strong>\{predio\.predioId\}<\/strong>/);
  assert.doesNotMatch(fn, /<span>\{predio\.predioId\}<\/span>/);
  assert.doesNotMatch(fn, /organizacionId/);
  assert.doesNotMatch(fn, /\{predio\.geometry\}/);
  assert.doesNotMatch(fn, /snapshot/i);
});

test('displayOrDash: null/undefined/"" caen a "—"', () => {
  const fn = codeOnly.match(/function displayOrDash\(value\)\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /value === null \|\| value === undefined \|\| value === ''/);
  assert.match(fn, /'—'/);
});

test('PredioCard: código predial null cae a "Registro manual" (nunca a "—")', () => {
  const fn = source.match(/function PredioCard\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /predio\.codigoPredial \|\| 'Registro manual'/);
});

test('PredioCard: área declarada null cae a "—", si no formatAreaHa (reutiliza el mismo formateador que el resultado CatastroX)', () => {
  const fn = source.match(/function PredioCard\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /predio\.areaDeclaradaHa === null \? '—' : formatAreaHa\(predio\.areaDeclaradaHa\)/);
});

test('PredioCard: mini-mapa (con su GET de detalle) solo se monta si tieneGeometria es true; si es false muestra un estado visual limpio sin disparar fetch', () => {
  const fn = source.match(/function PredioCard\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /predio\.tieneGeometria \? \(\s*<GanaderiaPredioMiniMap predioId=\{predio\.predioId\} \/>/);
  // El branch "sin geometría" no debe montar GanaderiaPredioMiniMap (ese
  // componente es el único que hace el GET de detalle) -- solo un div de
  // estado vacío, sin fetch propio.
  const noGeometryBranch = fn.match(/\) : \(([\s\S]*?)\)\}/)?.[1] ?? '';
  assert.doesNotMatch(noGeometryBranch, /GanaderiaPredioMiniMap/);
  assert.match(noGeometryBranch, /gan-predio-map-empty/);
});

// ---------------------------------------------------------------------
// 6. Error amigable
// ---------------------------------------------------------------------

test('reloadRegisteredPredios: en catch, setPrediosListError(LIST_ERROR_MESSAGE) -- copy exacto pedido, nunca detalle técnico', () => {
  assert.match(
    source,
    /const LIST_ERROR_MESSAGE = 'No fue posible cargar tus predios registrados\. Intenta nuevamente\.'/,
  );
  const fn = codeOnly.match(/async function reloadRegisteredPredios\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(fn, /catch \{\s*setPrediosListError\(LIST_ERROR_MESSAGE\);/);
});

test('MisPrediosSection: si error, muestra StatusMessage type="error" con el mensaje, antes de intentar listar', () => {
  const fn = source.match(/function MisPrediosSection\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /if \(error\) \{\s*return <StatusMessage type="error">\{error\}<\/StatusMessage>;/);
});

// ---------------------------------------------------------------------
// 7. Registro sigue disponible si GET falla
// ---------------------------------------------------------------------

test('PrediosPage.jsx: el panel "Registrar nuevo predio" se renderiza incondicionalmente -- nunca detrás de un guard de prediosListError/prediosListLoading', () => {
  const registerPanel = source.match(/<span className="gan-eyebrow">Registrar nuevo predio<\/span>[\s\S]*?<\/div>\s*<\/div>\s*\);/)?.[0] ?? '';
  assert.ok(registerPanel, 'debe existir el panel de registro');
  assert.doesNotMatch(registerPanel.slice(0, 50), /prediosListError/);
  // El bloque que envuelve el heading no depende de {!prediosListError && ...}
  assert.doesNotMatch(source, /\{!prediosListError[\s\S]{0,80}Registrar nuevo predio/);
  assert.doesNotMatch(source, /\{!prediosListLoading[\s\S]{0,80}Registrar nuevo predio/);
});

// ---------------------------------------------------------------------
// 8. Refetch después de POST + 9. nuevo predio aparece tras refetch
// ---------------------------------------------------------------------

test('handleConfirm: tras guardado exitoso llama a reloadRegisteredPredios() (refetch real, no copia optimista)', () => {
  const fn = codeOnly.match(/async function handleConfirm\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  const successBlock = fn.match(/if \(ok\) \{[\s\S]*?\n      \}/)?.[0] ?? '';
  assert.match(successBlock, /setScreen\('saved'\)/);
  assert.match(successBlock, /reloadRegisteredPredios\(\)/);
});

test('handleManualSubmit: tras guardado exitoso llama a reloadRegisteredPredios() (refetch real, no copia optimista)', () => {
  const fn = codeOnly.match(/async function handleManualSubmit[\s\S]*?\n  \}/)?.[0] ?? '';
  const successBlock = fn.match(/if \(ok\) \{[\s\S]*?\n      \}/)?.[0] ?? '';
  assert.match(successBlock, /setScreen\('saved'\)/);
  assert.match(successBlock, /reloadRegisteredPredios\(\)/);
});

test('reloadRegisteredPredios: setRegisteredPredios recibe EXCLUSIVAMENTE el resultado del GET (fetchRegisteredPrediosList) -- nunca un spread/insert optimista sobre el state previo', () => {
  assert.doesNotMatch(codeOnly, /setRegisteredPredios\(\[\.\.\.registeredPredios/);
  assert.match(codeOnly, /setRegisteredPredios\(predios\)/);
});

// ---------------------------------------------------------------------
// 10. Nunca /api/predios legacy + 11. nunca organizacionId client-side
// ---------------------------------------------------------------------

test('PrediosPage.jsx: todas las rutas usadas (incluida la lista) están bajo /api/ganaderia/predios, nunca /api/predios legacy', () => {
  const apiCalls = codeOnly.match(/['"`]\/api\/[a-zA-Z0-9/_${}-]+['"`]/g) || [];
  assert.ok(apiCalls.length > 0, 'debe haber al menos una llamada a la API');
  for (const call of apiCalls) {
    assert.match(call, /\/api\/ganaderia\/predios/, `ruta inesperada: ${call}`);
  }
});

test('PrediosPage.jsx: nunca referencia organizacionId -- el tenant se resuelve server-side desde la sesión', () => {
  assert.doesNotMatch(codeOnly, /organizacionId/);
});

test('GanaderiaPredioMiniMap.jsx: fetch de detalle bajo /api/ganaderia/predios/:id, credentials include, sin organizacionId client-side', () => {
  const miniMapCodeOnly = stripComments(miniMapSource);
  assert.match(miniMapCodeOnly, /fetch\(`\/api\/ganaderia\/predios\/\$\{predioId\}`,\s*\{\s*credentials:\s*'include'\s*\}\)/);
  assert.doesNotMatch(miniMapCodeOnly, /organizacionId/);
});

// ---------------------------------------------------------------------
// SPRINT-3C4.1 §2/§3/§4/§7: layout de dos columnas + label/valor
// separados + polígono sin relleno -- exclusivo de Ganadería.
// ---------------------------------------------------------------------

test('PredioCard: el nombre del predio es el elemento principal (clase dedicada gan-predio-card-name), y el cuerpo separa datos/mapa en gan-predio-data/gan-predio-map-wrap', () => {
  const fn = source.match(/function PredioCard\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /className="gan-predio-card-name"/);
  assert.match(fn, /className="gan-predio-card-body"/);
  assert.match(fn, /className="gan-predio-data"/);
  assert.match(fn, /className="gan-predio-map-wrap"/);
});

test('PredioCard: cada dato usa gan-ficha-row con label (span) y valor (strong) en filas separadas -- nunca texto concatenado', () => {
  const fn = source.match(/function PredioCard\([\s\S]*?\n\}/)?.[0] ?? '';
  const ganFichaRowCount = (fn.match(/className="gan-ficha-row"/g) || []).length;
  assert.equal(ganFichaRowCount, 5, 'departamento, municipio, vereda, área declarada y código predial deben usar gan-ficha-row');
});

test('styles.css: .gan-predio-card ocupa el ancho completo de la grilla (grid-column: 1 / -1), no 1/3 columna', () => {
  const stylesSource = fs.readFileSync(path.resolve(PREDIOS_DIR, '../../..', 'styles.css'), 'utf8');
  const rule = stylesSource.match(/\.gan-predio-card\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(rule, /grid-column:\s*1\s*\/\s*-1/);
});

test('styles.css: .gan-predio-card-body usa dos columnas en desktop y colapsa a una en la media query de 900px (tablet/móvil)', () => {
  const stylesSource = fs.readFileSync(path.resolve(PREDIOS_DIR, '../../..', 'styles.css'), 'utf8');
  const desktopRule = stylesSource.match(/\.gan-predio-card-body\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(desktopRule, /grid-template-columns:\s*minmax/);
  const afterBreakpoint = stylesSource.split('@media (max-width: 900px)')[1] ?? '';
  assert.match(afterBreakpoint.slice(0, 4000), /\.gan-predio-card-body\s*\{\s*grid-template-columns:\s*1fr;/);
});

test('GanaderiaPredioMiniMap.jsx: el polígono no tiene relleno (fillOpacity: 0) -- solo contorno verde AGX', () => {
  assert.match(miniMapSource, /fillOpacity:\s*0\b/);
  assert.doesNotMatch(miniMapSource, /fillOpacity:\s*0\.\d/);
});

test('GanaderiaPredioMiniMap.jsx: nunca importa CatastroXMap ni nada de src/modules/catastrox -- componente propio de Ganadería (solo puede documentarlo en comentarios)', () => {
  const miniMapCodeOnly = stripComments(miniMapSource);
  assert.doesNotMatch(miniMapCodeOnly, /CatastroXMap/);
  assert.doesNotMatch(miniMapCodeOnly, /from ['"].*catastrox/i);
});
