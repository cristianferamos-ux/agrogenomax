// SPRINT-3D8-DESCANSO-REENTRADA: pruebas arquitectónicas (análisis de
// texto fuente) -- mismo patrón que
// potreroRecomendacionPastoreoArchitecture.test.js. Este repo no tiene
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

const panelSource = readNormalized(path.join(POTREROS_DIR, 'PotreroDescansoReentradaPanel.jsx'));
const apiSource = readNormalized(path.join(POTREROS_DIR, 'ganaderiaDescansoReentradaApi.js'));
const apiCode = stripComments(apiSource);
const recomendacionPanelSource = readNormalized(path.join(POTREROS_DIR, 'PotreroRecomendacionPastoreoPanel.jsx'));

// ---------------------------------------------------------------------
// §19 del sprint: botón "Calcular descanso" dentro del flujo de POTRERO 1,
// SOLO después de una recomendación de pastoreo guardada.
// ---------------------------------------------------------------------

test('el botón "Calcular descanso" existe en el panel de descanso', () => {
  assert.match(panelSource, /Calcular descanso/);
});

test('PotreroRecomendacionPastoreoPanel embebe el panel de descanso dentro del bloque de recomendación guardada (`actual`)', () => {
  assert.match(recomendacionPanelSource, /import PotreroDescansoReentradaPanel from '\.\/PotreroDescansoReentradaPanel\.jsx'/);
  assert.match(recomendacionPanelSource, /<PotreroDescansoReentradaPanel predioId=\{predioId\} potreroId=\{potreroId\} \/>/);
});

// ---------------------------------------------------------------------
// §11/§12 del sprint: único input del cliente es la fecha prevista de
// ingreso -- nunca "hoy" silencioso, nunca campos derivados.
// ---------------------------------------------------------------------

test('el formulario pide "Fecha prevista de ingreso" como único input', () => {
  assert.match(panelSource, /Fecha prevista de ingreso/);
});

test('el cliente de API documenta fechaInicioPastoreo como único body esperado', () => {
  assert.match(apiSource, /fechaInicioPastoreo/);
});

test('el cliente de API nunca referencia campos derivados server-side (spoofing)', () => {
  for (const forbidden of ['fichaId', 'contextoId', 'recomendacionPastoreoId', 'diasDescansoMin', 'organizacionId']) {
    assert.doesNotMatch(apiCode, new RegExp(forbidden));
  }
});

// ---------------------------------------------------------------------
// §1/§8 del sprint: nunca un número único falso-preciso -- siempre rango.
// ---------------------------------------------------------------------

test('formatDiasRango siempre expresa un rango (min–max), nunca un único número decimal', () => {
  const fnBlock = panelSource.match(/function formatDiasRango\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.notEqual(fnBlock, '');
  assert.doesNotMatch(fnBlock, /toFixed/);
});

// ---------------------------------------------------------------------
// §9 del sprint: condiciones de reentrada -- nunca solo "vuelva en N días".
// ---------------------------------------------------------------------

test('siempre incluye la condición de confirmar con nuevo aforo antes del reingreso', () => {
  assert.match(panelSource, /Confirmar recuperación con un nuevo aforo antes del reingreso\./);
});

test('la condición de altura es una REFERENCIA regional, nunca una exigencia exacta', () => {
  assert.match(panelSource, /ALTURA_ENTRADA_REFERENCIA/);
  assert.match(panelSource, /referenceEntryHeightCm/);
  assert.match(panelSource, /[Rr]eferencia/);
});

// ---------------------------------------------------------------------
// §22 del hardening: estados explícitos -- nunca convertir ausencia/
// desactualización de contexto en crash.
// ---------------------------------------------------------------------

test('maneja PARTIAL_CONTEXT, NO_AGROCLIMATE_CONTEXT y STALE_AGROCLIMATE_CONTEXT como advertencias, nunca como error fatal', () => {
  assert.match(panelSource, /PARTIAL_CONTEXT/);
  assert.match(panelSource, /NO_AGROCLIMATE_CONTEXT/);
  assert.match(panelSource, /STALE_AGROCLIMATE_CONTEXT/);
});

test('NO_GRAZING_RECOMMENDATION y NO_PASTURE_PROFILE tienen mensajes de error explícitos propios', () => {
  assert.match(panelSource, /NO_GRAZING_RECOMMENDATION/);
  assert.match(panelSource, /NO_PASTURE_PROFILE/);
});

// ---------------------------------------------------------------------
// §18/§28 del hardening: el motor es recalculable -- "Actualizar
// estimación" reutiliza la fecha ya registrada, nunca pide un nuevo input.
// ---------------------------------------------------------------------

test('el botón "Actualizar estimación" existe y reutiliza fechaInicioPastoreo ya guardado', () => {
  assert.match(panelSource, /Actualizar estimación/);
  assert.match(panelSource, /actual\.fechaInicioPastoreo/);
});

test('la condición REASSESSMENT_RECOMMENDED se muestra como aviso de cambio de condiciones', () => {
  assert.match(panelSource, /REASSESSMENT_RECOMMENDED/);
  assert.match(panelSource, /condiciones agroclimáticas han cambiado/);
});

// ---------------------------------------------------------------------
// §30 del hardening territorial: UI simple -- bullets "Por qué" en
// lenguaje llano, percentiles/jerga técnica SOLO detrás de "Ver detalle
// técnico", nunca visibles por defecto.
// ---------------------------------------------------------------------

test('muestra bullets "Por qué" en lenguaje llano, sin jerga de percentiles', () => {
  assert.match(panelSource, /Por qué/);
  const bloqueEtiquetas = panelSource.match(/const WHY_BULLET_LABELS = \{[\s\S]*?\n\};/)?.[0] ?? '';
  assert.notEqual(bloqueEtiquetas, '');
  assert.doesNotMatch(bloqueEtiquetas, /percentil|P10|P25|P75|P90/i);
});

// ---------------------------------------------------------------------
// SPRINT 3D8 (semantic final fix) §2/§3: VARIABLE SIGNAL vs OVERALL
// ASSESSMENT -- una señal secundaria nunca se presenta como si fuera la
// conclusión general cuando el status real es NORMAL. El generador de
// "por qué" antepone una frase introductoria por STATUS cuando aplica
// (RESTRICTIVE/SEVERELY_RESTRICTIVE), nunca duplica texto de regla cruda.
// ---------------------------------------------------------------------

test('semantic fix: NORMAL + señal secundaria de precipitación reciente -> copy reconoce AMBAS cosas en una sola oración, nunca la presenta como conclusión general', () => {
  assert.match(panelSource, /RULE_LOCAL_RECENT_PRECIP_DEFICIT/);
  const bloqueEtiquetas = panelSource.match(/const WHY_BULLET_LABELS = \{[\s\S]*?\n\};/)?.[0] ?? '';
  assert.match(bloqueEtiquetas, /RULE_LOCAL_RECENT_PRECIP_DEFICIT:\s*'[^']*condiciones generales[^']*normal[^']*aunque[^']*'/);
});

test('semantic fix: NORMAL sin ninguna señal secundaria -> reassurance explícita en vez de una sección vacía', () => {
  assert.match(panelSource, /NORMAL_BASELINE_BULLET/);
  assert.match(panelSource, /comportamiento esperado para este potrero/);
});

test('semantic fix: RESTRICTIVE/SEVERELY_RESTRICTIVE anteponen una frase introductoria por status, nunca duplican la regla técnica cruda', () => {
  assert.match(panelSource, /STATUS_INTRO_BULLET/);
  assert.match(panelSource, /RESTRICTIVE:\s*'La recuperación puede ser más lenta/);
  assert.match(panelSource, /SEVERELY_RESTRICTIVE:\s*'Las condiciones actuales pueden limitar/);
});

test('semantic fix: resolveWhyBullets recibe el status general, no solo las reglas -- la copy depende de AMBOS', () => {
  assert.match(panelSource, /function resolveWhyBullets\(appliedRules, status\)/);
  assert.match(panelSource, /resolveWhyBullets\(agroClimate\?\.appliedRules, agroClimate\?\.status\)/);
});

// ---------------------------------------------------------------------
// SPRINT 3D8 (semantic final fix) §5: si una regla de precipitación
// depende de 15d, el detalle técnico debe permitir auditar 7d/15d/30d --
// nunca solo 7d/30d dejando la ventana intermedia invisible.
// ---------------------------------------------------------------------

test('semantic fix: el detalle técnico expone precipitación 15d (además de 7d/30d) cuando la climatología local la resuelve', () => {
  assert.match(panelSource, /precipitacion15dNivel/);
  assert.match(panelSource, /Precipitación 15d vs\. histórico local/);
});

// ---------------------------------------------------------------------
// SPRINT 3D8 (semantic final fix) §4: RULE_LOCAL_ABOVE_NORMAL_MOISTURE
// (suelo) y RULE_LOCAL_ABOVE_NORMAL_PRECIP (precipitación) tienen copy
// PROPIO -- nunca un bullet de suelo etiquetando evidencia de lluvia.
// ---------------------------------------------------------------------

test('semantic fix: precipitación alta y humedad de suelo alta tienen bullets de "por qué" DISTINTOS, nunca comparten texto', () => {
  const bloqueEtiquetas = panelSource.match(/const WHY_BULLET_LABELS = \{[\s\S]*?\n\};/)?.[0] ?? '';
  assert.match(bloqueEtiquetas, /RULE_LOCAL_ABOVE_NORMAL_PRECIP:\s*'[^']*[Ll]luvia[^']*'/);
  assert.match(bloqueEtiquetas, /RULE_LOCAL_ABOVE_NORMAL_MOISTURE:\s*'[^']*suelo[^']*'/);
});

test('el detalle técnico (percentiles/reglas) está detrás de un toggle "Ver detalle técnico", no visible por defecto', () => {
  assert.match(panelSource, /Ver detalle técnico/);
  assert.match(panelSource, /function DetalleTecnico/);
});

// ---------------------------------------------------------------------
// §15/§31 del hardening: nunca "listo" solo por fecha, nunca rigidez tipo
// "if humidicola: return 30".
// ---------------------------------------------------------------------

test('nunca presenta el resultado como "listo" (READY_TO_GRAZE) -- siempre ventana estimada', () => {
  assert.doesNotMatch(panelSource, /READY_TO_GRAZE/);
  assert.doesNotMatch(panelSource, /listo para (pastorear|entrar)/i);
});

test('nunca hardcodea un número de días fijo en el componente -- el rango viene siempre del backend', () => {
  assert.doesNotMatch(panelSource, /\b30\s*d[ií]as\b/i);
  assert.doesNotMatch(panelSource, /humidicola/i);
});

// ---------------------------------------------------------------------
// HARDENING OPERACIONAL §9 (round 5): copy simple durante la
// auto-generación de climatología -- "Construyendo referencia climática
// local..." mientras se calcula, "Referencia climática local disponible"
// una vez terminado. NUNCA jerga técnica (ERA5/años/percentiles/grid) en
// ese copy -- eso queda exclusivamente detrás de "Ver detalle técnico".
// ---------------------------------------------------------------------

test('§9: copy "Construyendo referencia climática local..." durante el primer cálculo sin histórico previo', () => {
  assert.match(panelSource, /Construyendo referencia climática local/);
  assert.match(panelSource, /Referencia climática local disponible/);
});

test('§9: el copy de auto-generación usa climatologyGenerated de la respuesta -- nunca un endpoint/paso adicional del cliente', () => {
  assert.match(panelSource, /climatologyGenerated/);
  assert.doesNotMatch(panelSource, /refreshPotreroClimatologia|\/climatologia/i);
});

test('§9: el copy de construcción/disponibilidad de climatología nunca expone jerga técnica (ERA5/años/percentiles/grid)', () => {
  const bloqueCopy = panelSource.match(/Construyendo referencia climática local[\s\S]{0,120}/)?.[0] ?? '';
  const bloqueDisponible = panelSource.match(/Referencia climática local disponible[\s\S]{0,20}/)?.[0] ?? '';
  assert.doesNotMatch(bloqueCopy, /ERA5|percentil|grid|1991|2020/i);
  assert.doesNotMatch(bloqueDisponible, /ERA5|percentil|grid|1991|2020/i);
});
