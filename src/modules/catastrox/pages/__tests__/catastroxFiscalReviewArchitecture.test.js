// CATX-FISCAL-PROTECTION-001: pruebas arquitectónicas (análisis de texto
// fuente, no en tiempo de ejecución) que garantizan que un predio fiscal,
// posible predio fiscal o de revisión especial nunca llega al flujo de
// compra automática en el frontend -- mismo patrón ya usado en este
// repositorio (ver
// src/modules/catastrox/pages/__tests__/catastroxOfficialPdfArchitecture.test.js
// y server/__tests__/architecture/noSrcImports.test.js). No se monta
// ningún componente (CatastroXPackagePage.jsx importa leaflet vía
// CatastroXMockMap.jsx, que exige un DOM completo para cargar en
// node:test) -- se analiza el código fuente directamente como texto.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = path.resolve(__dirname, '..');
const COMPONENTS_DIR = path.resolve(PAGES_DIR, '..', 'components');
const SERVICES_DIR = path.resolve(PAGES_DIR, '..', 'services');

const packagePageSource = fs.readFileSync(path.join(PAGES_DIR, 'CatastroXPackagePage.jsx'), 'utf8');
const resultPageSource = fs.readFileSync(path.join(PAGES_DIR, 'CatastroXResultPage.jsx'), 'utf8');
const resultSummarySource = fs.readFileSync(path.join(COMPONENTS_DIR, 'CatastroXResultSummary.jsx'), 'utf8');
const whatsAppCtaSource = fs.readFileSync(path.join(COMPONENTS_DIR, 'CatastroXWhatsAppCTA.jsx'), 'utf8');
const catastroxApiSource = fs.readFileSync(path.join(SERVICES_DIR, 'catastroxApi.js'), 'utf8');
const mockMapSource = fs.readFileSync(path.join(COMPONENTS_DIR, 'CatastroXMockMap.jsx'), 'utf8');

test('CatastroXPackagePage.jsx: REQUIRES_ADVISOR_STATES incluye los 4 estados fiscales/de revisión especial', () => {
  const match = packagePageSource.match(/const REQUIRES_ADVISOR_STATES = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(match, 'debe existir REQUIRES_ADVISOR_STATES');
  const body = match[1];
  ['CATASTROX_STATUS.FISCAL', 'CATASTROX_STATUS.INCONSISTENCIA', 'CATASTROX_STATUS.REVISION_ESPECIAL', 'CATASTROX_STATUS.POSIBLE_PREDIO_FISCAL'].forEach(
    (entry) => assert.ok(body.includes(entry), `REQUIRES_ADVISOR_STATES debe incluir ${entry}`),
  );
});

function extractRequiresAdvisorBlock(source) {
  const start = source.indexOf('if (requiresAdvisor) {');
  assert.ok(start > -1, 'debe existir el bloque `if (requiresAdvisor) { ... }`');
  // El bloque termina justo antes del `return (` principal de la página
  // (render normal) -- ese `return (` está a nivel de función (2 espacios
  // de indentación, sin `if`/`}` antes), un ancla estable frente a cambios
  // internos del bloque requiresAdvisor. \r?\n tolera CRLF (Windows).
  const endMatch = source.slice(start).match(/\r?\n {2}return \(\r?\n {4}<section className="catastrox-page">/);
  assert.ok(endMatch, 'no se pudo ubicar el final del bloque requiresAdvisor (return principal de la página)');
  return source.slice(start, start + endMatch.index);
}

test('CatastroXPackagePage.jsx: si requiresAdvisor es true, la función retorna antes de definir ningún handler de compra/checkout', () => {
  const block = extractRequiresAdvisorBlock(packagePageSource);
  assert.ok(block.includes('return ('), 'el bloque requiresAdvisor debe retornar JSX inmediatamente (early return)');
  assert.ok(!block.includes('handleOpenBuyerForm'), 'el bloque requiresAdvisor nunca debe ofrecer el flujo de compra normal');
  assert.ok(!block.includes('Comprar '), 'el bloque requiresAdvisor nunca debe mostrar un botón "Comprar"');
  // El botón real "Comprar {pkg.label}" (con handleOpenBuyerForm) está
  // DESPUÉS de este bloque en el archivo -- confirmamos que el guard
  // aparece antes en el texto fuente (orden de ejecución real de React).
  const advisorIndex = packagePageSource.indexOf('if (requiresAdvisor)');
  const buyButtonIndex = packagePageSource.indexOf('handleOpenBuyerForm}');
  assert.ok(advisorIndex > -1 && buyButtonIndex > -1 && advisorIndex < buyButtonIndex);
});

test('CatastroXPackagePage.jsx: el bloque requiresAdvisor usa AlertTriangle (icono unificado de alerta fiscal)', () => {
  assert.ok(extractRequiresAdvisorBlock(packagePageSource).includes('AlertTriangle'));
});

test('CatastroXPackagePage.jsx: el botón de compra real usa el icono Package', () => {
  assert.ok(packagePageSource.includes('<Package size={18} />'));
  assert.ok(!packagePageSource.includes('<Wallet size={18} />'), 'el icono Wallet debe haber sido reemplazado por Package');
});

test('CatastroXResultSummary.jsx: el CTA "Ver paquetes disponibles" se suprime cuando el predio requiere revisión fiscal', () => {
  assert.ok(resultSummarySource.includes('FISCAL_REVIEW_STATUSES'));
  assert.ok(
    resultSummarySource.includes("mode === 'free' && !requiresFiscalReview"),
    'el CTA de compra normal debe excluir explícitamente los estados fiscales/de revisión especial',
  );
});

test('CatastroXWhatsAppCTA.jsx: para estados fiscales muestra el mensaje y el CTA exactos pedidos (limpieza visual), con icono MessageCircle', () => {
  assert.ok(whatsAppCtaSource.includes('FISCAL_REVIEW_STATUSES'));
  assert.ok(
    whatsAppCtaSource.includes(
      'La información consultada presenta características que requieren revisión especializada antes de generar entregables comerciales. Para continuar, comuníquese con el equipo de CatastroX y reciba asesoría personalizada.',
    ),
  );
  assert.ok(whatsAppCtaSource.includes("'Solicitar asesoría personalizada'"));
  assert.ok(whatsAppCtaSource.includes('MessageCircle'));
});

test('CatastroXResultPage.jsx: encabezado compacto -- título corto, subtítulo y mensaje breve (sin repetir el texto completo de asesoría)', () => {
  // Limpieza visual (revisión post-implementación): el texto largo con el
  // llamado a comunicarse con el equipo de CatastroX vive únicamente en el
  // bloque inferior (CatastroXWhatsAppCTA) -- el encabezado usa una versión
  // corta para no repetirlo.
  assert.ok(resultPageSource.includes("title: 'Predio de gran extensión'"));
  assert.ok(resultPageSource.includes("subtitle: 'Revisión especializada requerida'"));
  assert.ok(
    resultPageSource.includes(
      'La información consultada requiere validación técnica, catastral y jurídica antes de generar entregables comerciales.',
    ),
  );
  assert.ok(
    !resultPageSource.includes('Para continuar, comuníquese con el equipo de CatastroX y reciba asesoría personalizada.'),
    'el texto completo de asesoría no debe repetirse en el encabezado -- vive solo en el bloque inferior',
  );
});

test('CatastroXResultPage.jsx: el párrafo redundante bajo los datos del predio (specialCopy.detail) se retiró para revisión especial, y su render ahora es condicional', () => {
  assert.ok(resultPageSource.includes('detail: null'), 'REVISION_ESPECIAL debe declarar detail: null');
  assert.ok(
    resultPageSource.includes('{specialCopy.detail ? <p className="catastrox-copy">{specialCopy.detail}</p> : null}'),
    'el párrafo de detail debe ser condicional -- otros estados (SIN_COBERTURA_CATASTRAL, etc.) conservan su detail y su párrafo',
  );
});

test('catastroxApi.js: buildRealPredio deriva `estado` de payload.status (REVISION_ESPECIAL) en vez de forzar siempre IDENTIFICADO', () => {
  assert.ok(
    catastroxApiSource.includes("payload.status === 'REVISION_ESPECIAL' ? CATASTROX_STATUS.REVISION_ESPECIAL : CATASTROX_STATUS.IDENTIFICADO"),
    'buildRealPredio debe respetar el status que envía el backend, no hardcodear siempre IDENTIFICADO',
  );
});

// --- Revisión legal/comercial: el título exacto pedido reemplaza los ------
// --- títulos provisionales, y ningún copy visible afirma "predio fiscal" -
// --- solo por el umbral de área (revisión post-implementación). ----------

const statusBadgeSource = fs.readFileSync(path.join(COMPONENTS_DIR, 'CatastroXStatusBadge.jsx'), 'utf8');

// CatastroXPackagePage.jsx (pantalla de bloqueo de compra, fuera del
// alcance de la limpieza visual de este ciclo -- ver ARCHIVOS A REVISAR)
// conserva el título largo combinado sin cambios.
test('CatastroXPackagePage.jsx: conserva el título combinado (pantalla de bloqueo de compra, no tocada en la limpieza visual)', () => {
  assert.ok(packagePageSource.includes('Predio de gran extensión — revisión especializada requerida'));
});

test('CatastroXWhatsAppCTA.jsx: el bloque inferior usa un título propio ("Validación técnica, catastral y jurídica requerida"), distinto del encabezado -- ya no repite el mismo título 3 veces', () => {
  assert.ok(whatsAppCtaSource.includes("'Validación técnica, catastral y jurídica requerida'"));
  assert.ok(
    !whatsAppCtaSource.includes('Predio de gran extensión — revisión especializada requerida'),
    'el bloque inferior ya no debe repetir el título del encabezado',
  );
});

test('CatastroXWhatsAppCTA.jsx: el panel de cobertura técnica reduce su protagonismo visual para el caso fiscal (clase is-muted) sin perder su contenido', () => {
  assert.ok(whatsAppCtaSource.includes("`catastrox-inline-panel${isFiscalReview ? ' is-muted' : ''}`"));
  assert.ok(whatsAppCtaSource.includes('Cobertura técnica especializada'), 'el contenido del panel de cobertura se conserva');
});

test('catastrox.css: define los estilos nuevos usados por la limpieza visual (encabezado compacto, subtítulo, panel de cobertura silenciado)', () => {
  const cssSource = fs.readFileSync(path.resolve(PAGES_DIR, '..', 'styles', 'catastrox.css'), 'utf8');
  assert.ok(cssSource.includes('.catastrox-result-hero.is-compact'));
  assert.ok(cssSource.includes('.catastrox-result-hero-subtitle'));
  assert.ok(cssSource.includes('.catastrox-inline-panel.is-muted'));
});

test('ningún archivo revisado afirma "predio fiscal" como copy visible -- la regla de área nunca declara naturaleza/titularidad fiscal', () => {
  // Se excluyen identificadores técnicos (CATASTROX_STATUS.*, nombres de
  // función/constante como FISCAL_REVIEW_STATUSES, checkoutRequiresFiscalReview,
  // el código interno FISCAL_REVIEW_REQUIRED) -- solo interesa texto que un
  // usuario final vería literalmente como "predio fiscal" o "es un predio
  // fiscal". Ninguno de los 4 archivos revisados debe contener esa frase.
  [
    ['CatastroXResultPage.jsx', resultPageSource],
    ['CatastroXPackagePage.jsx', packagePageSource],
    ['CatastroXWhatsAppCTA.jsx', whatsAppCtaSource],
    ['CatastroXStatusBadge.jsx', statusBadgeSource],
  ].forEach(([name, source]) => {
    assert.ok(!/predio fiscal/i.test(source), `${name} no debe contener la frase "predio fiscal"`);
  });
});

test('CatastroXStatusBadge.jsx: las etiquetas de FISCAL/POSIBLE_PREDIO_FISCAL/REVISION_ESPECIAL usan "gran extensión" o "revisión especial", nunca "predio fiscal"', () => {
  assert.ok(statusBadgeSource.includes("label: 'Predio de gran extensión'"));
  assert.ok(statusBadgeSource.includes("label: 'Revisión especial requerida'"));
});

test('server/routes/catastroxPayments.js: el mensaje público de FISCAL_REVIEW_REQUIRED habla de "validación especializada", nunca de "predio fiscal" -- el código interno puede conservar el nombre', () => {
  const catastroxPaymentsSource = fs.readFileSync(path.resolve(PAGES_DIR, '..', '..', '..', '..', 'server', 'routes', 'catastroxPayments.js'), 'utf8');
  assert.ok(catastroxPaymentsSource.includes("code: 'FISCAL_REVIEW_REQUIRED'"), 'el código interno se conserva');
  assert.ok(
    catastroxPaymentsSource.includes('Este predio requiere validación especializada antes de adquirir un paquete.'),
    'el mensaje público debe hablar de validación especializada',
  );
  const publicMessageBlockMatch = catastroxPaymentsSource.match(/code: 'FISCAL_REVIEW_REQUIRED',\s*message: '([^']*)'/);
  assert.ok(publicMessageBlockMatch, 'debe existir el bloque de respuesta 403 con code+message');
  assert.ok(!/fiscal/i.test(publicMessageBlockMatch[1]), 'el mensaje PÚBLICO no debe mencionar "fiscal" en ninguna forma');
});

test('server/routes/catastroxPayments.js: la deuda técnica legacy queda documentada con el identificador CATX-LEGACY-SPECIAL-REVIEW-GUARD-001', () => {
  const catastroxPaymentsSource = fs.readFileSync(path.resolve(PAGES_DIR, '..', '..', '..', '..', 'server', 'routes', 'catastroxPayments.js'), 'utf8');
  assert.ok(catastroxPaymentsSource.includes('CATX-LEGACY-SPECIAL-REVIEW-GUARD-001'));
  assert.ok(catastroxPaymentsSource.includes('fail-open'), 'debe documentar explícitamente el comportamiento fail-open para predios legacy');
});

// --- Ajustes visuales finales (vista satelital + panel izquierdo) --------

test('CatastroXMockMap.jsx: el mensaje de la vista satelital cambia únicamente para estados de revisión especializada -- predios ordinarios conservan el mensaje comercial actual', () => {
  assert.ok(mockMapSource.includes('FISCAL_REVIEW_STATUSES'));
  assert.ok(
    mockMapSource.includes(
      'La información técnica detallada se habilitará únicamente después de la validación especializada del caso.',
    ),
  );
  assert.ok(
    mockMapSource.includes('El área, perímetro, códigos y archivos técnicos se habilitan dentro del paquete seleccionado.'),
    'el mensaje comercial ordinario debe conservarse para predios sin revisión especializada',
  );
});

test('CatastroXResultPage.jsx: el panel izquierdo de revisión especial ya no repite "Predio de gran extensión" -- el encabezado de sección (tag+título) se omite solo para ese estado', () => {
  assert.ok(
    resultPageSource.includes('{!isRevisionEspecial ? (') && resultPageSource.includes('<span>{specialCopy.tag}</span>'),
    'el bloque de encabezado del panel izquierdo debe quedar condicionado a !isRevisionEspecial',
  );
  // El encabezado principal ("Predio de gran extensión" + "Revisión
  // especializada requerida") permanece intacto -- solo se omite la
  // repetición del panel izquierdo, no el título de la página.
  assert.ok(resultPageSource.includes("title: 'Predio de gran extensión'"));
  assert.ok(resultPageSource.includes("subtitle: 'Revisión especializada requerida'"));
});
