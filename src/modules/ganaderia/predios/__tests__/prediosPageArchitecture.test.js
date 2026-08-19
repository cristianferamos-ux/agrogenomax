// SPRINT-3C3.2 §15: pruebas arquitectónicas (análisis de texto fuente) --
// mismo patrón que ganaderiaAdminCrearCuentaArchitecture.test.js /
// agxAdmin001Architecture.test.js. Este repo no tiene jsdom/testing-library
// configurado para render real de componentes React en `test:node`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREDIOS_DIR = path.resolve(__dirname, '..');

const source = fs.readFileSync(path.join(PREDIOS_DIR, 'PrediosPage.jsx'), 'utf8');

function stripComments(text) {
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const codeOnly = stripComments(source);

// ---------------------------------------------------------------------
// 1. Nunca habla con el router legacy /api/predios ni con ganaderiaApi.js
// ---------------------------------------------------------------------

test('PrediosPage.jsx: nunca importa ganaderiaApi.js (ese router es legacy, sin CSRF, sin aislamiento por organización)', () => {
  assert.doesNotMatch(codeOnly, /from ['"]\.\.\/api\/ganaderiaApi\.js['"]/);
});

test('PrediosPage.jsx: todas las rutas usadas están bajo /api/ganaderia/predios, nunca /api/predios', () => {
  const apiCalls = codeOnly.match(/['"]\/api\/[a-zA-Z0-9/_-]+['"]/g) || [];
  assert.ok(apiCalls.length > 0, 'debe haber al menos una llamada a la API');
  for (const call of apiCalls) {
    assert.match(call, /\/api\/ganaderia\/predios/, `ruta inesperada: ${call}`);
  }
});

// ---------------------------------------------------------------------
// 2. Campos eliminados del formulario (§1)
// ---------------------------------------------------------------------

test('PrediosPage.jsx: NUNCA pide código interno, propietario, documento/NIT, teléfono ni correo -- la identidad viene de la sesión', () => {
  // Se revisa el código real (sin comentarios) -- este archivo SÍ
  // documenta la regla en sus propios comentarios ("nunca pide
  // propietario/documento/teléfono/correo"), lo cual es correcto y no
  // debe hacer fallar la prueba.
  assert.doesNotMatch(codeOnly, /Código interno/i);
  assert.doesNotMatch(codeOnly, /Propietario/i);
  assert.doesNotMatch(codeOnly, /Documento\s*\/\s*NIT/i);
  assert.doesNotMatch(codeOnly, /Teléfono/i);
  assert.doesNotMatch(codeOnly, /\bCorreo\b/i);
  assert.doesNotMatch(codeOnly, /\bpropietario\b/);
  assert.doesNotMatch(codeOnly, /\bdocumento\b/);
  assert.doesNotMatch(codeOnly, /\btelefono\b/);
});

// ---------------------------------------------------------------------
// 3. CSRF + credentials (mismo patrón que GanaderiaAdminCrearCuenta.jsx)
// ---------------------------------------------------------------------

test('PrediosPage.jsx: usa fetchCsrfToken + credentials include + X-CSRF-Token en cada POST', () => {
  assert.match(source, /import\s*\{\s*fetchCsrfToken\s*\}\s*from\s*['"]\.\.\/auth\/GanaderiaAuthContext\.jsx['"]/);
  assert.match(source, /fetchCsrfToken\(\)/);
  assert.match(source, /credentials:\s*'include'/);
  assert.match(source, /'X-CSRF-Token':\s*csrfToken/);
});

// ---------------------------------------------------------------------
// 4. Render de datos CatastroX + vereda null/vacía (§3, §15.1/§15.2)
// ---------------------------------------------------------------------

test('ResultScreen: muestra nombrePredio, departamento, municipio, areaCatastral y codigoPredial del predio', () => {
  assert.match(source, /predio\.nombrePredio/);
  assert.match(source, /predio\.departamento/);
  assert.match(source, /predio\.municipio/);
  assert.match(source, /predio\.areaCatastralHa/);
  assert.match(source, /predio\.codigoPredial/);
});

test('ResultScreen: vereda ausente cae a un placeholder visual, nunca al objeto de presentación ni a undefined', () => {
  assert.match(source, /predio\.vereda \|\| '—'/);
});

// ---------------------------------------------------------------------
// 5. Área formateada a 2 decimales (§12, §15.3)
// ---------------------------------------------------------------------

test('formatAreaHa: usa toLocaleString es-CO con 2 decimales fijos, sufijo " ha"', () => {
  const fn = source.match(/function formatAreaHa[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /toLocaleString\('es-CO',\s*\{\s*minimumFractionDigits:\s*2,\s*maximumFractionDigits:\s*2\s*\}\)/);
  assert.match(fn, /\$\{.*\}\s*ha`/);
});

test('roundAreaHa: redondea a 2 decimales para precargar el campo editable (Math.round(num * 100) / 100)', () => {
  const fn = source.match(/function roundAreaHa[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /Math\.round\(num \* 100\) \/ 100/);
});

// ---------------------------------------------------------------------
// 6. Modo verificación por defecto -- campos catastrales SIEMPRE
// readOnly, operativos readOnly hasta entrar a edición (§5, §15.4)
// ---------------------------------------------------------------------

test('PrediosPage.jsx: editing arranca en false (verificación por defecto)', () => {
  assert.match(codeOnly, /const \[editing, setEditing\] = useState\(false\)/);
});

test('ResultScreen: los 6 campos catastrales son SIEMPRE readOnly, nunca dependen de `editing`', () => {
  const catastralBlock = source.match(/<FormField label="Nombre">[\s\S]*?<FormField label="Código predial">[\s\S]*?<\/FormField>/)?.[0] ?? '';
  const readOnlyOccurrences = catastralBlock.match(/readOnly/g) || [];
  assert.ok(readOnlyOccurrences.length >= 6, 'los 6 campos catastrales (nombre/departamento/municipio/vereda/área catastral/código predial) deben ser readOnly');
  assert.doesNotMatch(catastralBlock, /readOnly=\{!editing\}/, 'los campos catastrales nunca deben depender de `editing` -- son SIEMPRE de solo lectura');
});

test('ResultScreen: los campos operativos (nombre/área declarada/observaciones) usan readOnly={!editing}', () => {
  const operativeBlock = source.match(/Nombre con el que quieres registrarlo[\s\S]*?Observaciones[\s\S]{0,300}/)?.[0] ?? '';
  const readOnlyEditingOccurrences = operativeBlock.match(/readOnly=\{!editing\}/g) || [];
  assert.equal(readOnlyEditingOccurrences.length, 3, 'nombreOperativo, areaDeclarada y observaciones deben ser readOnly={!editing}');
});

// ---------------------------------------------------------------------
// 7. Entrar a edición / cancelar edición (§7, §8, §15.5/§15.6)
// ---------------------------------------------------------------------

test('startEditing: toma un snapshot de los valores operativos antes de habilitar edición', () => {
  const fn = codeOnly.match(/function startEditing\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(fn, /setEditSnapshot\(\{\s*nombreOperativo,\s*areaDeclarada,\s*observaciones\s*\}\)/);
  assert.match(fn, /setEditing\(true\)/);
});

test('cancelEditing: restaura los 3 valores operativos desde el snapshot y vuelve a verificación, SIN llamar a fetch/postGanaderiaPredios', () => {
  const fn = codeOnly.match(/function cancelEditing\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(fn, /setNombreOperativo\(editSnapshot\.nombreOperativo\)/);
  assert.match(fn, /setAreaDeclarada\(editSnapshot\.areaDeclarada\)/);
  assert.match(fn, /setObservaciones\(editSnapshot\.observaciones\)/);
  assert.match(fn, /setEditing\(false\)/);
  assert.doesNotMatch(fn, /fetch\(/);
  assert.doesNotMatch(fn, /postGanaderiaPredios/);
});

// ---------------------------------------------------------------------
// 8. Confirmación directa / guardar tras editar -- MISMO handler,
// MISMO body exacto (§6, §8, §15.7/§15.8/§15.9)
// ---------------------------------------------------------------------

test('ResultScreen: tanto en verificación como en edición el botón principal llama a onConfirm (mismo handler)', () => {
  const actionsBlock = source.match(/\{editing \? \(([\s\S]*?)\n {6}\)\}/)?.[0] ?? '';
  assert.ok(actionsBlock, 'debe existir el bloque condicional {editing ? (...) : (...)}');
  const [editingBranch = '', verificationBranch = ''] = actionsBlock.split(/\n {6}\) : \(\n/);
  assert.match(editingBranch, /onClick=\{onConfirm\}/, 'el branch de edición debe usar onConfirm');
  assert.match(verificationBranch, /onClick=\{onConfirm\}/, 'el branch de verificación debe usar onConfirm');
  assert.match(editingBranch, /Cancelar edición/);
  assert.match(verificationBranch, /Los datos son correctos/);
});

test('handleConfirm: el body enviado a POST /api/ganaderia/predios es exactamente {mode, candidateId, nombrePersonalizado, areaDeclaradaHa, observaciones}', () => {
  const fn = codeOnly.match(/async function handleConfirm\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  const bodyBlock = fn.match(/const body = \{[\s\S]*?\};/)?.[0] ?? '';
  assert.match(bodyBlock, /mode:\s*'catastrox'/);
  assert.match(bodyBlock, /candidateId,/);
  assert.match(bodyBlock, /nombrePersonalizado:/);
  assert.match(bodyBlock, /areaDeclaradaHa:/);
  assert.match(bodyBlock, /observaciones:/);
  // Exactamente 5 claves -- ninguna adicional.
  // Cuenta tanto `clave: valor,` como propiedades abreviadas `clave,`
  // (p.ej. `candidateId,` sin `: candidateId`).
  const keyCount = (bodyBlock.match(/^\s*[a-zA-Z]+[,:]/gm) || []).length;
  assert.equal(keyCount, 5, `el body debe tener exactamente 5 claves, se encontraron ${keyCount}`);
});

test('handleConfirm: el body NUNCA incluye datos catastrales/oficiales -- ni organizacionId, geometry, codigoPredial, área catastral, fuente, versionFuente, snapshot, departamento, municipio ni vereda', () => {
  const fn = codeOnly.match(/async function handleConfirm\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  const bodyBlock = fn.match(/const body = \{[\s\S]*?\};/)?.[0] ?? '';
  const forbidden = [
    'organizacionId',
    'geometry',
    'codigoPredial',
    'codigoAnterior',
    'areaCatastralHa',
    'areaCatastralM2',
    'fuente',
    'versionFuente',
    'snapshot',
    'departamento',
    'municipio',
    'vereda',
  ];
  for (const field of forbidden) {
    assert.doesNotMatch(bodyBlock, new RegExp(`\\b${field}\\b\\s*:`), `el body de confirmación no debe incluir "${field}"`);
  }
});

test('handleConfirm: areaDeclaradaHa enviado es el valor ACTUAL del campo (state), nunca predio.areaCatastralHa directamente', () => {
  const fn = codeOnly.match(/async function handleConfirm\(\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.doesNotMatch(fn, /predio\.areaCatastralHa/, 'handleConfirm no debe leer predio.areaCatastralHa -- solo el state areaDeclarada, que el usuario puede haber editado');
  assert.match(fn, /Number\(areaDeclarada\)/);
});

// ---------------------------------------------------------------------
// 9. Formulario manual: solo los 6 campos aprobados (§14)
// ---------------------------------------------------------------------

test('ManualScreen: body de registro manual es exactamente {mode, nombrePredio, departamento, municipio, vereda, areaDeclaradaHa, observaciones} -- sin geometry/snapshot/codigoPredial', () => {
  const fn = codeOnly.match(/async function handleManualSubmit[\s\S]*?\n  \}/)?.[0] ?? '';
  const bodyBlock = fn.match(/const body = \{[\s\S]*?\};/)?.[0] ?? '';
  assert.match(bodyBlock, /mode:\s*'manual'/);
  assert.match(bodyBlock, /nombrePredio:/);
  assert.match(bodyBlock, /departamento:/);
  assert.match(bodyBlock, /municipio:/);
  assert.match(bodyBlock, /vereda:/);
  assert.match(bodyBlock, /areaDeclaradaHa:/);
  assert.match(bodyBlock, /observaciones:/);
  assert.doesNotMatch(bodyBlock, /geometry/);
  assert.doesNotMatch(bodyBlock, /snapshot/);
  assert.doesNotMatch(bodyBlock, /codigoPredial/);
  // Cuenta tanto `clave: valor,` como propiedades abreviadas `clave,`
  // (p.ej. `candidateId,` sin `: candidateId`).
  const keyCount = (bodyBlock.match(/^\s*[a-zA-Z]+[,:]/gm) || []).length;
  assert.equal(keyCount, 7, `el body manual debe tener exactamente 7 claves, se encontraron ${keyCount}`);
});

test('ManualScreen: nombrePredio/departamento/municipio son required, vereda/área/observaciones son opcionales', () => {
  const manualScreenSource = source.match(/function ManualScreen[\s\S]*$/)?.[0] ?? '';
  const nombreField = manualScreenSource.match(/Nombre del predio[\s\S]{0,150}/)?.[0] ?? '';
  const deptoField = manualScreenSource.match(/Departamento" required[\s\S]{0,150}/)?.[0] ?? '';
  const municipioField = manualScreenSource.match(/Municipio" required[\s\S]{0,150}/)?.[0] ?? '';
  const veredaField = manualScreenSource.match(/Vereda">[\s\S]{0,150}/)?.[0] ?? '';
  assert.match(nombreField, /required/);
  assert.ok(deptoField, 'Departamento debe ser required');
  assert.ok(municipioField, 'Municipio debe ser required');
  assert.doesNotMatch(veredaField, /required/);
});

// ---------------------------------------------------------------------
// 10. Mapa: reutiliza CatastroXMap, geometry viene SOLO del candidate
// (§4, §15.15)
// ---------------------------------------------------------------------

test('PrediosPage.jsx: importa CatastroXMap (reutiliza infraestructura visual de CatastroX), no consulta geometría adicional', () => {
  assert.match(source, /import CatastroXMap from ['"]\.\.\/\.\.\/catastrox\/components\/CatastroXMap\.jsx['"]/);
});

test('buildMapPredio: construye polygonGeoJson/referencePoint exclusivamente desde predio.geometry/predio.centroide (el candidate ya resuelto), nunca desde una llamada adicional', () => {
  const fn = codeOnly.match(/function buildMapPredio[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /predio\?\.geometry/);
  assert.match(fn, /predio\?\.centroide/);
  assert.match(fn, /geometry:\s*predio\.geometry/);
  assert.match(fn, /referencePoint:\s*predio\.centroide/);
});

test('PrediosPage.jsx: ninguna función hace fetch a un endpoint de geometría separado (solo buscar-por-coordenadas/buscar-por-codigo/POST raíz)', () => {
  const fetchPaths = codeOnly.match(/fetch\(path/g) || [];
  assert.ok(fetchPaths.length >= 1);
  assert.doesNotMatch(codeOnly, /\/geometry['"]/);
  assert.doesNotMatch(codeOnly, /\/geometria['"]/);
});

// ---------------------------------------------------------------------
// 11. Estados UX: buscando/sin resultado/error/guardando/éxito (§9, §15.10)
// ---------------------------------------------------------------------

test('SearchScreen: muestra "Buscando..." mientras searchStatus=searching, deshabilita el botón', () => {
  assert.match(source, /\{searching \? 'Buscando\.\.\.' : 'Buscar predio'\}/);
  assert.match(source, /disabled=\{searching\}/);
});

test('ResultScreen: muestra "Guardando..." mientras saving=true, deshabilita ambos botones principales', () => {
  const occurrences = source.match(/\{saving \? 'Guardando\.\.\.' : /g) || [];
  assert.ok(occurrences.length >= 2, 'debe mostrar "Guardando..." tanto en el botón de confirmación directa como en el de edición');
});

test('ManualScreen: muestra "Guardando..." mientras manualSaving=true', () => {
  const manualScreenSource = source.match(/function ManualScreen[\s\S]*$/)?.[0] ?? '';
  assert.match(manualScreenSource, /\{saving \? 'Guardando\.\.\.' : 'Guardar predio'\}/);
});

test('Mensaje de error genérico exacto pedido para fallas técnicas de búsqueda y guardado, nunca detalles técnicos', () => {
  assert.match(
    source,
    /const GENERIC_SEARCH_ERROR = 'No fue posible consultar el predio en este momento\. Intenta nuevamente\.'/,
  );
  assert.match(
    source,
    /const GENERIC_SAVE_ERROR = 'No fue posible registrar el predio en este momento\. Intenta nuevamente\.'/,
  );
  // Se revisa solo el copy visible al usuario (JSX de texto/mensajes),
  // nunca comentarios de código -- este mismo archivo documenta la regla
  // "nunca mostrar backend/túnel/API caída" en sus propios comentarios,
  // lo cual es correcto y no debe hacer fallar la prueba.
  const codeOnlyLower = codeOnly.toLowerCase();
  assert.doesNotMatch(codeOnlyLower, /backend/);
  assert.doesNotMatch(codeOnlyLower, /túnel/);
  assert.doesNotMatch(codeOnlyLower, /tunnel/);
  assert.doesNotMatch(codeOnlyLower, /stack trace/);
  assert.doesNotMatch(codeOnlyLower, /api caída/);
});

test('Guardado exitoso: mensaje exacto pedido, renderizado en la pantalla `saved`', () => {
  assert.match(source, /const SUCCESS_MESSAGE = 'Predio registrado correctamente\.'/);
  assert.match(codeOnly, /screen === 'saved'[\s\S]{0,200}SUCCESS_MESSAGE/);
});

// ---------------------------------------------------------------------
// 12. Protección contra doble envío (§11, §15.11)
// ---------------------------------------------------------------------

test('Doble envío: búsqueda, confirmación y registro manual cortan temprano si ya están en curso', () => {
  assert.match(codeOnly, /if \(searchStatus === 'searching'\) return;/);
  assert.match(codeOnly, /if \(saving\) return;/);
  assert.match(codeOnly, /if \(manualSaving\) return;/);
});

// ---------------------------------------------------------------------
// 13. Nunca guarda automáticamente durante la búsqueda
// ---------------------------------------------------------------------

test('handleSearchSubmit: solo guarda candidateId/predio en state -- nunca llama a POST /api/ganaderia/predios (la creación real)', () => {
  const fn = codeOnly.match(/async function handleSearchSubmit[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.doesNotMatch(fn, /postGanaderiaPredios\('\/api\/ganaderia\/predios'/);
  assert.match(fn, /setCandidateId\(data\.candidateId\)/);
  assert.match(fn, /setPredio\(data\.predio\)/);
});
