// SPRINT-3D10.4 FASE 4: pruebas arquitectónicas (análisis de texto fuente)
// de PotreroPlanPastoreoSmart.jsx -- mismo patrón que
// potreroRecomendacionPastoreoArchitecture.test.js. Este repo no tiene
// jsdom/testing-library configurado para render real de componentes React
// en `test:node`.
//
// Además incluye pruebas de EJECUCIÓN real (no solo texto) de las
// funciones puras exportadas (buildBodyAuto/isFormComplete) -- §33 del
// sprint: contrato de API exacto, nunca campos derivados server-side.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBodyAuto, isFormComplete } from '../potreroPlanPastoreoSmartLogic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POTREROS_DIR = path.resolve(__dirname, '..');

function readNormalized(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

const panelSource = readNormalized(path.join(POTREROS_DIR, 'PotreroPlanPastoreoSmart.jsx'));
const apiSource = readNormalized(path.join(POTREROS_DIR, 'ganaderiaRecomendacionPastoreoApi.js'));

const CATEGORIA_GENERICA = { codigo: 'novillo_ceba', nombre: 'Novillo de ceba', requiereProduccionLeche: false, requiereTerneroAlPie: false };
const CATEGORIA_LECHE = { codigo: 'vaca_leche_produccion', nombre: 'Vaca en producción', requiereProduccionLeche: true, requiereTerneroAlPie: false };
const CATEGORIA_TERNERO = { codigo: 'vaca_cria_con_ternero', nombre: 'Vaca de cría', requiereProduccionLeche: false, requiereTerneroAlPie: true };

// ===========================================================================
// §33 del sprint -- CONTRATO DE API: buildBodyAuto ejecutado de verdad,
// nunca solo inspeccionado como texto. NUNCA debe incluir campos
// resueltos server-side (§0/§11 del sprint), ni siquiera numeroAnimales.
// ===========================================================================

const CAMPOS_PROHIBIDOS = [
  'numeroAnimales', 'numeroAnimalesRecomendado', 'diasPermanenciaRecomendada',
  'fichaId', 'fechaAforo', 'tipoPastura', 'generoPastura', 'generoDominante',
  'occupationPolicy', 'policyVersion', 'MSU', 'materiaSecaTotalKg', 'materiaSecaUtilizableKg',
  'materiaSecaPctAplicada', 'utilizacionPctAplicada', 'DI', 'demandaIndividualKgMsDia',
  'fechaSalidaEstimada', 'consumoOperativoKg', 'remanenteOperativoKg', 'margenForrajeKg',
  'diasMaximosSoportadosExactos', 'motivoDuracion', 'confidence', 'provenance',
];

test('buildBodyAuto (categoría genérica): NUNCA incluye ningún campo prohibido, solo hechos del productor', () => {
  const body = buildBodyAuto(CATEGORIA_GENERICA, { pesoPromedioKg: '420', fechaIngresoPrevista: '2026-09-10', produccionLecheLDia: '', diasEnLeche: '', grasaLechePct: '', terneroAlPie: false });
  for (const campo of CAMPOS_PROHIBIDOS) {
    assert.ok(!(campo in body), `buildBodyAuto no debe incluir ${campo}`);
  }
  assert.deepEqual(Object.keys(body).sort(), ['categoriaCodigo', 'fechaIngresoPrevista', 'pesoPromedioKg'].sort());
  assert.equal(body.categoriaCodigo, 'novillo_ceba');
  assert.equal(body.pesoPromedioKg, 420);
  assert.equal(body.fechaIngresoPrevista, '2026-09-10');
});

test('buildBodyAuto (categoría lactante): incluye SOLO los condicionales de leche aportados, nunca resultados', () => {
  const body = buildBodyAuto(CATEGORIA_LECHE, { pesoPromedioKg: '500', fechaIngresoPrevista: '2026-09-10', produccionLecheLDia: '18', diasEnLeche: '90', grasaLechePct: '3.8', terneroAlPie: false });
  assert.equal(body.produccionLecheLDia, 18);
  assert.equal(body.diasEnLeche, 90);
  assert.equal(body.grasaLechePct, 3.8);
  for (const campo of CAMPOS_PROHIBIDOS) assert.ok(!(campo in body));
});

test('buildBodyAuto (categoría con ternero): incluye terneroAlPie solo si la categoría lo requiere', () => {
  const body = buildBodyAuto(CATEGORIA_TERNERO, { pesoPromedioKg: '450', fechaIngresoPrevista: '2026-09-10', produccionLecheLDia: '', diasEnLeche: '', grasaLechePct: '', terneroAlPie: true });
  assert.equal(body.terneroAlPie, true);
  assert.ok(!('terneroAlPie' in buildBodyAuto(CATEGORIA_GENERICA, { pesoPromedioKg: '450', fechaIngresoPrevista: '2026-09-10', produccionLecheLDia: '', diasEnLeche: '', grasaLechePct: '', terneroAlPie: true })));
});

test('isFormComplete: exige peso Y fecha (nunca numeroAnimales, que no existe en el form)', () => {
  assert.equal(isFormComplete(CATEGORIA_GENERICA, { pesoPromedioKg: '', fechaIngresoPrevista: '2026-09-10' }), false);
  assert.equal(isFormComplete(CATEGORIA_GENERICA, { pesoPromedioKg: '420', fechaIngresoPrevista: '' }), false);
  assert.equal(isFormComplete(CATEGORIA_GENERICA, { pesoPromedioKg: '420', fechaIngresoPrevista: '2026-09-10' }), true);
  assert.equal(isFormComplete(null, { pesoPromedioKg: '420', fechaIngresoPrevista: '2026-09-10' }), false);
});

test('isFormComplete (leche): produccionLecheLDia obligatorio, diasEnLeche obligatorio SOLO si hay grasa', () => {
  const base = { pesoPromedioKg: '500', fechaIngresoPrevista: '2026-09-10', produccionLecheLDia: '', diasEnLeche: '', grasaLechePct: '' };
  assert.equal(isFormComplete(CATEGORIA_LECHE, base), false);
  assert.equal(isFormComplete(CATEGORIA_LECHE, { ...base, produccionLecheLDia: '18' }), true);
  assert.equal(isFormComplete(CATEGORIA_LECHE, { ...base, produccionLecheLDia: '18', grasaLechePct: '3.8' }), false);
  assert.equal(isFormComplete(CATEGORIA_LECHE, { ...base, produccionLecheLDia: '18', grasaLechePct: '3.8', diasEnLeche: '90' }), true);
});

// ===========================================================================
// §4/§29 -- API client: las 3 funciones nuevas existen y apuntan a las
// rutas exactas de 3D10.4 Fase 3, reutilizando postJson (mismo CSRF/
// credentials -- ningún segundo cliente HTTP nuevo).
// ===========================================================================

test('API client expone previewCargaAutomatica/evaluarEscenarioCargaAutomatica/guardarCargaAutomatica sobre las rutas /auto*', () => {
  assert.match(apiSource, /export function previewCargaAutomatica\(predioId, potreroId, body\)/);
  assert.match(apiSource, /export function evaluarEscenarioCargaAutomatica\(predioId, potreroId, body\)/);
  assert.match(apiSource, /export function guardarCargaAutomatica\(predioId, potreroId, body\)/);
  assert.match(apiSource, /recomendacion-pastoreo\/auto\/preview/);
  assert.match(apiSource, /recomendacion-pastoreo\/auto\/escenario`, body\);/);
  assert.match(apiSource, /recomendacion-pastoreo\/auto`, body\);/);
});

test('las 3 funciones nuevas reutilizan postJson -- ningún segundo cliente HTTP/fetch propio', () => {
  const bloque = apiSource.match(/export function previewCargaAutomatica[\s\S]*$/)?.[0] ?? '';
  assert.doesNotMatch(bloque, /\bfetch\(/);
  assert.match(bloque, /postJson\(/g);
});

// ===========================================================================
// §3 -- estado sin aforo válido: copy simple, SIN código/enum técnico.
// ===========================================================================

test('§3: sin aforo (tieneFicha=false o aforoFaltante) muestra el copy simple exacto y CTA "Registrar aforo"', () => {
  assert.match(panelSource, /Necesitamos medir cuánto pasto hay disponible antes de recomendar el próximo pastoreo\./);
  assert.match(panelSource, />\s*Registrar aforo\s*</);
  assert.match(panelSource, /if \(!tieneFicha \|\| aforoFaltante\)/);
});

test('§3: la superficie principal NUNCA imprime el código técnico crudo', () => {
  assert.doesNotMatch(panelSource, />\s*INSUFFICIENT_FORAGE_DATA\s*</);
  assert.doesNotMatch(panelSource, />\s*ficha productiva\s*</i);
});

test('§3: aforo obsoleto (descubierto al calcular/guardar) reutiliza el mismo estado -- setAforoFaltante(true) en los tres flujos', () => {
  const ocurrencias = panelSource.match(/setAforoFaltante\(true\)/g) || [];
  assert.ok(ocurrencias.length >= 3, 'debía activarse en preview, guardar y escenario');
});

// ===========================================================================
// §4/§5 -- formulario principal: SOLO categoría/peso/fecha + condicionales,
// NUNCA cantidad de animales.
// ===========================================================================

test('§4: el formulario PRINCIPAL (categoría/peso/fecha) NUNCA pide "Cantidad de animales" -- ese campo solo existe en "Probar otra cantidad" (escenario, §15-18)', () => {
  const formularioPrincipal = panelSource.match(/const numeroAnimalesParaIngreso[\s\S]*?function handleCalcular/)?.[0]
    ?? panelSource.match(/async function handleCalcular\(\) \{[\s\S]{0,2000}/)?.[0] ?? '';
  const bloqueForm = panelSource.match(/<FormField label="Peso promedio[\s\S]*?<FormField label="Fecha prevista[\s\S]*?<\/FormField>/)?.[0] ?? '';
  assert.notEqual(bloqueForm, '', 'debía existir el bloque peso+fecha del formulario principal');
  assert.doesNotMatch(bloqueForm, /Cantidad de animales/);
  // El único lugar donde aparece es la exploración de escenario, marcada
  // explícitamente como alternativa -- nunca el input principal.
  const ocurrencias = panelSource.match(/Cantidad de animales/g) || [];
  assert.equal(ocurrencias.length, 1);
  assert.match(panelSource, /Probar otra cantidad[\s\S]{0,200}Cantidad de animales/);
});

test('§5: fecha prevista usa input type="date", envía YYYY-MM-DD, nunca construye un timestamp UTC manualmente', () => {
  assert.match(panelSource, /type="date"/);
  assert.match(panelSource, /Fecha prevista de ingreso/);
  assert.doesNotMatch(panelSource, /toISOString\(\)\.slice\(0, ?10\)\.concat/); // sin hacks de concatenar hora
  assert.doesNotMatch(panelSource, /T00:00:00/); // nunca inventa hora
});

test('§4: campos condicionales de leche/ternero solo se muestran si la categoría los requiere', () => {
  assert.match(panelSource, /categoriaSeleccionada\.requiereProduccionLeche \?/);
  assert.match(panelSource, /categoriaSeleccionada\.requiereTerneroAlPie \?/);
});

// ===========================================================================
// §6/§7 -- CTA principal y resultado OK.
// ===========================================================================

test('§6: CTA principal es "Calcular recomendación", deshabilitado mientras carga (evita doble submit)', () => {
  assert.match(panelSource, />\s*\{previewLoading \? 'Calculando\.\.\.' : 'Calcular recomendación'\}\s*</);
  const botonCalcular = panelSource.match(/onClick=\{handleCalcular\}[\s\S]*?<\/button>/)?.[0] ?? '';
  assert.match(botonCalcular, /disabled=\{previewLoading/);
});

test('§6: handleCalcular llama previewCargaAutomatica ANTES de cualquier guardado (nunca persiste al calcular)', () => {
  const fnBlock = panelSource.match(/async function handleCalcular\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(fnBlock, /previewCargaAutomatica\(/);
  assert.doesNotMatch(fnBlock, /guardarCargaAutomatica\(/);
});

test('§7: resultado OK muestra SOLO lo esencial arriba -- N, días, ingreso, salida -- sin MSU/DI/%MS/confidence/provenance en superficie principal', () => {
  const tarjeta = panelSource.match(/\{preview && preview\.estado === 'OK' && !showEscenario \? \([\s\S]*?<DetalleTecnicoAutomatico/)?.[0] ?? '';
  assert.notEqual(tarjeta, '');
  assert.match(tarjeta, /preview\.numeroAnimalesRecomendado/);
  assert.match(tarjeta, /preview\.diasPermanenciaRecomendada/);
  assert.match(tarjeta, /preview\.fechaIngresoPrevista/);
  assert.match(tarjeta, /preview\.fechaSalidaEstimada/);
  for (const tecnico of ['materiaSecaUtilizableKg', 'demandaIndividualKgMsDia', 'nivelConfianza', 'occupationPolicy', 'motorVersion']) {
    assert.doesNotMatch(tarjeta, new RegExp(tecnico));
  }
  assert.match(tarjeta, /Usar esta recomendación/);
  assert.match(tarjeta, /Quiero ingresar otra cantidad/);
});

// ===========================================================================
// §8 -- fallback 2 días, sin alarmismo.
// ===========================================================================

test('§8: FALLBACK_MIN_2_DAYS se presenta como copy discreto, nunca como error/alarma', () => {
  assert.match(panelSource, /Hay poco pasto disponible para esta categoría\./);
  const bloqueFallback = panelSource.match(/motivoDuracion === 'FALLBACK_MIN_2_DAYS' \?[\s\S]{0,120}/g) || [];
  for (const bloque of bloqueFallback) {
    assert.doesNotMatch(bloque, /type="error"/);
  }
});

// ===========================================================================
// §9 -- forraje insuficiente.
// ===========================================================================

test('§9: NO_RECOMMENDATION_INSUFFICIENT_FORAGE muestra el copy exacto y NUNCA el botón "Usar esta recomendación" en esa rama', () => {
  const bloque = panelSource.match(/preview\.estado === 'NO_RECOMMENDATION_INSUFFICIENT_FORAGE' \?[\s\S]*?\) : null\}/)?.[0] ?? '';
  assert.match(bloque, /El pasto disponible no alcanza para recomendar este tipo de animal en una rotación adecuada\./);
  assert.doesNotMatch(bloque, /Usar esta recomendación/);
  assert.doesNotMatch(bloque, /1 día/);
});

// ===========================================================================
// §10 -- pastura sin política.
// ===========================================================================

test('§10: PASTURA_SIN_POLITICA_DEFINIDA muestra copy neutral, nunca "error"/"enum"/"leguminosa"', () => {
  const bloque = panelSource.match(/preview\.estado === 'PASTURA_SIN_POLITICA_DEFINIDA' \?[\s\S]*?\) : null\}/)?.[0] ?? '';
  assert.match(bloque, /Todavía no tenemos una recomendación automática validada para este tipo de cobertura\./);
  assert.doesNotMatch(bloque, /error/i);
  assert.doesNotMatch(bloque, /leguminosa/i);
  assert.doesNotMatch(bloque, /enum/i);
});

// ===========================================================================
// §11/§33 -- guardar: recalcula desde cero, NUNCA envía resultados del preview.
// ===========================================================================

test('§11: handleGuardar construye el body con buildBodyAuto(categoriaSeleccionada, form) -- NUNCA con `preview`', () => {
  const fnBlock = panelSource.match(/async function handleGuardar\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(fnBlock, /guardarCargaAutomatica\(predioId, potreroId, buildBodyAuto\(categoriaSeleccionada, form\)\)/);
  assert.doesNotMatch(fnBlock, /guardarCargaAutomatica\([^)]*preview/);
});

// ===========================================================================
// §12 -- doble click.
// ===========================================================================

test('§12: el botón de guardar queda disabled={saving} -- impide doble submit', () => {
  assert.match(panelSource, /<button type="button" className="gan-submit" onClick=\{handleGuardar\} disabled=\{saving\}>/);
});

// ===========================================================================
// §14/§18 -- escenario.
// ===========================================================================

test('§14/§18: escenario recalcula TODO con evaluarEscenarioCargaAutomatica (nunca reutiliza el preview anterior)', () => {
  const fnBlock = panelSource.match(/async function handleEvaluarEscenario\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(fnBlock, /evaluarEscenarioCargaAutomatica\(/);
  assert.match(fnBlock, /buildBodyAuto\(categoriaSeleccionada, form\)/);
});

test('§16: TARGET_COMPATIBLE y §17: MINIMUM_COMPATIBLE muestran copy exacto; §17 usa aviso discreto, nunca "carga alta"/"presión"', () => {
  assert.match(panelSource, /Esta cantidad utiliza más rápidamente el pasto disponible\./);
  assert.doesNotMatch(panelSource, /carga alta/i);
  assert.doesNotMatch(panelSource, /presión excesiva/i);
  assert.doesNotMatch(panelSource, /warning técnico/i);
});

test('§18: INSUFFICIENT_FORAGE en escenario NUNCA ofrece 1 día ni permite usar ese escenario', () => {
  const bloque = panelSource.match(/escenario\.estado === 'INSUFFICIENT_FORAGE' \?[\s\S]*?\) : null\}/)?.[0] ?? '';
  assert.match(bloque, /Esta cantidad es demasiado alta para el pasto disponible\./);
  assert.doesNotMatch(bloque, /Usar esta cantidad/);
  assert.doesNotMatch(bloque, /1 día/);
});

test('§15/§16 del sprint: escenario NUNCA llama a guardarCargaAutomatica -- no crea una recomendación', () => {
  const fnBlock = panelSource.match(/async function handleEvaluarEscenario\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  const usarCantidadFn = panelSource.match(/function handleUsarCantidadEscenario\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.doesNotMatch(fnBlock, /guardarCargaAutomatica/);
  assert.doesNotMatch(usarCantidadFn, /guardarCargaAutomatica/);
});

// ===========================================================================
// §19 -- detalle técnico cerrado por defecto.
// ===========================================================================

test('§19: DetalleTecnicoAutomatico usa useState(false) -- cerrado por defecto, mismo patrón "Ver detalle técnico"', () => {
  const fnBlock = panelSource.match(/function DetalleTecnicoAutomatico\(\{ detalle \}\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fnBlock, /useState\(false\)/);
  assert.match(fnBlock, /'Ocultar detalle técnico' : 'Ver detalle técnico'/);
  assert.doesNotMatch(fnBlock, /JSON\.stringify/);
});

// ===========================================================================
// §20 -- clima nunca en el camino principal.
// ===========================================================================

test('§20: el smart panel NUNCA importa/monta PotreroAgroClimaPanel ni un botón "Actualizar clima"', () => {
  assert.doesNotMatch(panelSource, /PotreroAgroClimaPanel/);
  assert.doesNotMatch(panelSource, /Actualizar (contexto|clima)/);
});

// ===========================================================================
// §21/§26 -- traducción de estados operativos: reutiliza PotreroCicloPastoreoPanel,
// NUNCA duplica el diccionario.
// ===========================================================================

test('§21: el smart panel NUNCA define su propio diccionario de estados operativos -- reutiliza PotreroCicloPastoreoPanel tal cual', () => {
  assert.doesNotMatch(panelSource, /ESTADO_OPERATIVO_LABELS/);
  assert.doesNotMatch(panelSource, /DISPONIBLE:\s*'/);
  assert.match(panelSource, /import PotreroCicloPastoreoPanel from '\.\/PotreroCicloPastoreoPanel\.jsx';/);
  assert.match(panelSource, /<PotreroCicloPastoreoPanel/);
});

// ===========================================================================
// §22 -- descanso/reentrada: NUNCA auto-apto, reutiliza el panel existente
// tal cual (sin tocar su lógica).
// ===========================================================================

test('§22: reutiliza PotreroDescansoReentradaPanel sin modificarlo -- ninguna lógica de reingreso nueva en este archivo', () => {
  assert.match(panelSource, /import PotreroDescansoReentradaPanel from '\.\/PotreroDescansoReentradaPanel\.jsx';/);
  assert.match(panelSource, /<PotreroDescansoReentradaPanel/);
  assert.doesNotMatch(panelSource, /APTO/);
  assert.doesNotMatch(panelSource, /evaluarReingreso/);
});

// ===========================================================================
// §26/§27 -- state machine: cualquier cambio de input invalida preview/escenario.
// ===========================================================================

test('§26/§27: updateField y selectCategoria invalidan preview/escenario/override previos', () => {
  const updateFieldBlock = panelSource.match(/function updateField\(field, value\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  const selectCategoriaBlock = panelSource.match(/function selectCategoria\(codigo\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(updateFieldBlock, /invalidarCalculoPrevio\(\)/);
  assert.match(selectCategoriaBlock, /invalidarCalculoPrevio\(\)/);
  const invalidarBlock = panelSource.match(/function invalidarCalculoPrevio\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(invalidarBlock, /setPreview\(null\)/);
  assert.match(invalidarBlock, /setEscenario\(null\)/);
  assert.match(invalidarBlock, /setSelectedRealOverride\(null\)/);
  assert.match(invalidarBlock, /setShowEscenario\(false\)/);
});

// ===========================================================================
// §14/§20 -- PLAN ≠ REAL: override real se conserva como intención, nunca
// se persiste como recomendación nueva, y precarga planLote al confirmar.
// ===========================================================================

test('§14/§20: selectedRealOverride precarga planLote.numeroAnimales al confirmar ingreso, nunca altera numeroAnimalesRecomendado', () => {
  const planLoteBlock = panelSource.match(/const numeroAnimalesParaIngreso = esRico[\s\S]*?;/)?.[0] ?? '';
  assert.match(planLoteBlock, /selectedRealOverride \?\? planGuardado\.numeroAnimalesRecomendado/);
  // La tarjeta de resumen sigue mostrando el NÚMERO RECOMENDADO original,
  // nunca lo reemplaza por el override.
  const resumenRow = panelSource.match(/<span>Recomendamos<\/span><strong>[\s\S]*?<\/strong>/)?.[0] ?? '';
  assert.match(resumenRow, /esRico \? planGuardado\.numeroAnimalesRecomendado : planGuardado\.numeroAnimales/);
});

test('§20: handleUsarCantidadEscenario NUNCA modifica el input numeroAnimalesUsuario como si fuera la recomendación AGX', () => {
  const fnBlock = panelSource.match(/function handleUsarCantidadEscenario\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(fnBlock, /setSelectedRealOverride\(Number\(numeroAnimalesUsuario\)\)/);
  assert.doesNotMatch(fnBlock, /setPreview/);
});

// ===========================================================================
// §28 -- errores traducidos, nunca stack/SQL/FORBIDDEN_FIELDS crudo.
// ===========================================================================

test('§28: mapa de errores traduce códigos HTTP a mensajes humanos, nunca expone FORBIDDEN_FIELDS/stack/SQL', () => {
  assert.match(panelSource, /const ERROR_MESSAGES = \{/);
  assert.doesNotMatch(panelSource, />\s*FORBIDDEN_FIELDS\s*</);
  assert.doesNotMatch(panelSource, /error\.stack/);
});

// ===========================================================================
// El componente reutiliza el módulo lógico puro -- nunca duplica
// buildBodyAuto/isFormComplete dentro del propio .jsx (una sola fuente de
// verdad para el contrato de API probado arriba).
// ===========================================================================

test('PotreroPlanPastoreoSmart.jsx importa buildBodyAuto/isFormComplete desde potreroPlanPastoreoSmartLogic.js -- no las redefine', () => {
  assert.match(panelSource, /import \{ buildBodyAuto, isFormComplete \} from '\.\/potreroPlanPastoreoSmartLogic\.js';/);
  assert.doesNotMatch(panelSource, /^export function buildBodyAuto/m);
  assert.doesNotMatch(panelSource, /^export function isFormComplete/m);
});
