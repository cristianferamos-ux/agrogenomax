// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO: pruebas arquitectónicas
// (análisis de texto fuente) -- mismo patrón que
// potreroCapacidadPastoreoArchitecture.test.js. Este repo no tiene
// jsdom/testing-library configurado para render real de componentes React
// en `test:node`.
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

const panelSource = readNormalized(path.join(POTREROS_DIR, 'PotreroRecomendacionPastoreoPanel.jsx'));
const apiSource = readNormalized(path.join(POTREROS_DIR, 'ganaderiaRecomendacionPastoreoApi.js'));
const apiCode = stripComments(apiSource);

// ---------------------------------------------------------------------
// §10 del sprint: copy obligatorio exacto.
// ---------------------------------------------------------------------

test('muestra el disclaimer técnico exacto del sprint (§10)', () => {
  assert.match(
    panelSource,
    /Estimación técnica basada en la información registrada del potrero, categoría productiva y fuentes agroclimáticas\. Las condiciones reales del ganado y la pastura pueden variar\./,
  );
});

// ---------------------------------------------------------------------
// §20 del sprint: advertencia obligatoria de vacas en producción de leche.
// ---------------------------------------------------------------------

test('muestra la advertencia exacta de suficiencia nutricional para vacas en producción de leche (§20)', () => {
  assert.match(
    panelSource,
    /La estimación de ocupación no sustituye la evaluación de energía, proteína, minerales ni suplementación requerida para la producción de leche\./,
  );
  assert.match(panelSource, /requiereAdvertenciaLeche/);
});

// ---------------------------------------------------------------------
// §11 del sprint: sin fundamento técnico para bandas de peso inventadas
// -- siempre el peso promedio exacto.
// ---------------------------------------------------------------------

test('formatPesoAprox muestra el peso exacto ingresado, nunca una banda inventada (§11)', () => {
  const fnBlock = panelSource.match(/function formatPesoAprox\(value\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(fnBlock, '');
  assert.doesNotMatch(fnBlock, /[-–]\s*\d/); // sin rango tipo "400-440"
  assert.match(fnBlock, /aprox\./);
});

// ---------------------------------------------------------------------
// §7/§17 del sprint: el body enviado al backend nunca incluye
// biomasa/parámetros/resultados derivados server-side -- solo
// categoriaCodigo + inputs mínimos del cliente.
// ---------------------------------------------------------------------

test('buildBody nunca incluye biomasaFrescaKg/materiaSecaPct/utilizacionPct/consumoPctPesoVivo/resultados/fichaId/contextoId/categoriaId', () => {
  const bodyBlock = panelSource.match(/function buildBody\(categoria, form\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(bodyBlock, '');
  for (const forbidden of [
    'biomasaFrescaKg', 'materiaSecaPct', 'utilizacionPct', 'consumoPctPesoVivo',
    'materiaSecaTotalKg', 'materiaSecaUtilizableKg', 'demandaDiariaLoteKgMs', 'diasOcupacionEstimados',
    'fichaId', 'contextoId', 'categoriaId', 'organizacionId', 'potreroId', 'predioId', 'nivelConfianza',
  ]) {
    assert.doesNotMatch(bodyBlock, new RegExp(forbidden));
  }
});

// ---------------------------------------------------------------------
// §16/§7 del sprint: preview vs create -- calcular primero, guardar
// después, nunca se salta el paso de previsualización.
// ---------------------------------------------------------------------

test('usa previewRecomendacionPastoreo antes de createRecomendacionPastoreo -- flujo calcular -> guardar', () => {
  assert.match(panelSource, /previewRecomendacionPastoreo\(predioId, potreroId, buildBody\(categoriaSeleccionada, form\)\)/);
  assert.match(panelSource, /createRecomendacionPastoreo\(predioId, potreroId, buildBody\(categoriaSeleccionada, form\)\)/);
});

// ---------------------------------------------------------------------
// §1 del sprint: NUNCA calcula todas las categorías a la vez -- solo la
// seleccionada por el cliente (selector jerárquico primero, formulario
// condicionado a categoriaSeleccionada después).
// ---------------------------------------------------------------------

test('el formulario de inputs solo se muestra después de elegir una categoría (categoriaSeleccionada)', () => {
  assert.match(panelSource, /!categoriaSeleccionada \? \(/);
  assert.match(panelSource, /buildGruposConCategorias/);
});

// ---------------------------------------------------------------------
// §12 del sprint: sin ficha, mismo copy que "Modo técnico" -- consistente,
// nunca un flujo global desconectado.
// ---------------------------------------------------------------------

test('sin ficha (tieneFicha=false) muestra el copy exacto y el botón "Crear ficha productiva"', () => {
  assert.match(panelSource, /Primero registra una ficha productiva con un aforo del potrero\./);
  assert.match(panelSource, /if \(!tieneFicha\)/);
});

// ---------------------------------------------------------------------
// API client: rutas correctas, tenant nunca en el cliente.
// ---------------------------------------------------------------------

test('ganaderiaRecomendacionPastoreoApi.js habla exclusivamente con las rutas subordinadas a predio/potrero + el catálogo transversal', () => {
  assert.match(apiSource, /\/api\/ganaderia\/predios\/\$\{predioId\}\/potreros\/\$\{potreroId\}\/recomendacion-pastoreo/);
  assert.match(apiSource, /\/recomendacion-pastoreo\/preview/);
  assert.match(apiSource, /\/api\/ganaderia\/categorias-productivas/);
});

test('ganaderiaRecomendacionPastoreoApi.js nunca referencia organizacionId en código ni el router legacy /api/potreros', () => {
  assert.doesNotMatch(apiCode, /organizacionId/);
  assert.doesNotMatch(apiSource, /['"`]\/api\/potreros/);
  assert.doesNotMatch(apiSource, /catastrox/i);
});

test('mutaciones usan CSRF (fetchCsrfToken + X-CSRF-Token), GET no', () => {
  assert.match(apiSource, /fetchCsrfToken/);
  assert.match(apiSource, /X-CSRF-Token/);
});

// ---------------------------------------------------------------------
// Hardening ronda 3 §1/§3/§4/§8: el frontend NUNCA hardcodea un
// coeficiente zootécnico (leche o ternero) -- todo el cálculo es
// server-side. El cliente solo captura los inputs nuevos (diasEnLeche) y
// los envía; nunca calcula ni muestra "0.30 kg MS/L" ni "+1 kg" como si
// fueran reglas del cliente.
// ---------------------------------------------------------------------

test('el panel NUNCA hardcodea un coeficiente "kg MS/L" ni la constante universal de ternero (+1.0 kg) -- todo el cálculo es server-side (hardening rondas 3/4)', () => {
  assert.doesNotMatch(panelSource, /kg\s*MS\s*\/\s*[lL]itro/);
  assert.doesNotMatch(panelSource, /\+\s*1\.0\s*kg/);
  // Litros/grasa se capturan y ENVÍAN al backend, pero el panel nunca
  // calcula FCM/DMI en el cliente (Number(...) es solo parseo de input,
  // nunca una fórmula de Gaines/NRC).
  assert.doesNotMatch(panelSource, /0\.372/);
  assert.doesNotMatch(panelSource, /0\.0968/);
});

test('litros/vaca/día es SIEMPRE obligatorio para categorías lactantes; grasaLechePct es SIEMPRE opcional; diasEnLeche es obligatorio SOLO si se aportó grasa (hardening ronda 4 §1/§2/§4)', () => {
  assert.match(panelSource, /diasEnLeche/);
  assert.match(panelSource, /grasaLechePct/);
  const isFormCompleteBlock = panelSource.match(/function isFormComplete\(categoria, form\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(isFormCompleteBlock, /produccionLecheLDia === ''/);
  assert.match(isFormCompleteBlock, /grasaLechePct !== '' && form\.diasEnLeche === ''/);
});

test('buildBody solo envía diasEnLeche/produccionLecheLDia/grasaLechePct cuando la categoría requiere producción de leche', () => {
  const bodyBlock = panelSource.match(/function buildBody\(categoria, form\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(bodyBlock, /requiereProduccionLeche/);
  assert.match(bodyBlock, /diasEnLeche/);
  assert.match(bodyBlock, /grasaLechePct/);
});

test('el campo de grasa usa el copy exacto pedido y NUNCA se marca required (hardening ronda 4 §4/§8 -- opcional, no obligar al pequeño productor)', () => {
  assert.match(panelSource, /Grasa de la leche \(%\) — opcional/);
  assert.match(panelSource, /Si cuenta con análisis o información del porcentaje\s*\n?\s*de grasa de la leche, AgroGenomaX puede mejorar\s*\n?\s*la estimación de consumo\./);
  const grasaFieldBlock = panelSource.match(/<FormField label="Grasa de la leche[\s\S]*?<\/FormField>/)?.[0] ?? '';
  assert.notEqual(grasaFieldBlock, '');
  assert.doesNotMatch(grasaFieldBlock, /\brequired\b/);
});

test('el campo de días en leche marca required dinámicamente según si ya se aportó grasa (hardening ronda 4 §2)', () => {
  assert.match(panelSource, /required=\{form\.grasaLechePct !== ''\}/);
});

test('provenance muestra dryMatterSource con la taxonomía MEASURED/PASTURE_SPECIFIC_BASELINE/BOTANICAL_TYPE/FALLBACK, nunca falsa precisión (hardening §6)', () => {
  assert.match(panelSource, /DRY_MATTER_SOURCE_LABELS/);
  assert.match(panelSource, /MEASURED/);
  assert.match(panelSource, /PASTURE_SPECIFIC_BASELINE/);
  assert.match(panelSource, /BOTANICAL_TYPE/);
  assert.match(panelSource, /provenance\.dryMatterSource/);
});

test('muestra las limitaciones explícitas (ternero al pie, leche sin grasa) cuando el motor las reporta -- nunca fingir precisión (hardening ronda 3 §4 + ronda 4 §5)', () => {
  assert.match(panelSource, /TERNERO_AL_PIE_DEMANDA_NO_CUANTIFICADA/);
  assert.match(panelSource, /LECHE_SIN_GRASA_PERFIL_GENERICO/);
  assert.match(panelSource, /limitaciones/);
});

test('errores nuevos (MISSING_DIAS_EN_LECHE, INVALID_DIAS_EN_LECHE, INVALID_GRASA_LECHE, PESO_FUERA_DE_RANGO_CATEGORIA) tienen copy amigable mapeado', () => {
  assert.match(panelSource, /MISSING_DIAS_EN_LECHE/);
  assert.match(panelSource, /INVALID_DIAS_EN_LECHE/);
  assert.match(panelSource, /INVALID_GRASA_LECHE/);
  assert.match(panelSource, /PESO_FUERA_DE_RANGO_CATEGORIA/);
});

// ---------------------------------------------------------------------
// Hardening ronda 5 -- corrige un bug real detectado en el primer preview
// de producción: "remanente proyectado" NUNCA debe recalcularse en el
// cliente como materiaSecaTotalKg - materiaSecaUtilizableKg (eso es el
// remanente OBJETIVO, un concepto distinto) -- siempre viene ya calculado
// del backend (resultado.remanenteProyectadoKg).
// ---------------------------------------------------------------------

test('ResultadoBlock NUNCA recalcula remanente/consumo en el cliente -- usa exclusivamente los campos del backend', () => {
  const resultadoBlock = panelSource.match(/function ResultadoBlock\(\{ payload \}\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(resultadoBlock, '');
  assert.doesNotMatch(resultadoBlock, /materiaSecaTotalKg\s*-\s*materiaSecaUtilizableKg/);
  assert.match(resultadoBlock, /resultado\.remanenteProyectadoKg/);
  assert.match(resultadoBlock, /resultado\.remanenteObjetivoKg/);
  assert.match(resultadoBlock, /resultado\.consumoProyectadoKg/);
  assert.match(resultadoBlock, /resultado\.diasOcupacionRecomendados/);
});

test('la permanencia mostrada usa diasOcupacionRecomendados (ya floor en backend), nunca diasOcupacionEstimados directamente', () => {
  const resultadoBlock = panelSource.match(/function ResultadoBlock\(\{ payload \}\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.doesNotMatch(resultadoBlock, /formatDias\(resultado\.diasOcupacionEstimados\)/);
});

test('el historial usa diasOcupacionRecomendados por item, misma semántica que el resultado fresco', () => {
  assert.match(panelSource, /formatDias\(item\.diasOcupacionRecomendados\)/);
});

test('etiquetas exactas preferidas del hotfix: "Consumo estimado en", "Remanente estimado al retiro", "Remanente objetivo protegido"', () => {
  assert.match(panelSource, /Consumo estimado en/);
  assert.match(panelSource, /Remanente estimado al retiro/);
  assert.match(panelSource, /Remanente objetivo protegido/);
});
