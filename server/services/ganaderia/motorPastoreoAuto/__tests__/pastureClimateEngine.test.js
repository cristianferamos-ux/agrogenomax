// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO: pruebas puras del motor
// determinístico pastura+clima (§8 del sprint, hardening rondas 2/3) --
// sin IA generativa, sin ecuaciones agroclimáticas inventadas: un único
// ajuste conservador por déficit hídrico de 7 días, nunca un ajuste que
// incremente la utilización por clima favorable. Hardening ronda 3 §6:
// dryMatterSource sigue MEASURED > PASTURE_SPECIFIC_BASELINE >
// BOTANICAL_TYPE > FALLBACK. Ronda 3 §5: humidicola usa el dato REAL
// verificado (Feedipedia, 26.0%), no un 22% sin cita.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePastureClimateParams } from '../pastureClimateEngine.js';

function sinPastura(tipo, contexto = null) {
  return resolvePastureClimateParams(tipo, null, contexto);
}

test('resuelve %MS base por tipo botánico documentado (BOTANICAL_TYPE)', () => {
  assert.equal(sinPastura('graminea').materiaSecaPct, 20);
  assert.equal(sinPastura('leguminosa').materiaSecaPct, 22);
  assert.equal(sinPastura('mezcla').materiaSecaPct, 21);
  assert.equal(sinPastura('graminea').dryMatterSource, 'BOTANICAL_TYPE');
});

test('"otra" (explícito o desconocido) es SIEMPRE FALLBACK -- degrada confianza (hardening §5)', () => {
  assert.equal(sinPastura('otra').materiaSecaPct, 20);
  assert.equal(sinPastura('otra').dryMatterSource, 'FALLBACK');
  assert.equal(sinPastura('inventado').dryMatterSource, 'FALLBACK');
});

test('tipo desconocido/no clasificable cae a "otra" y se marca tipoPasturaDesconocido (diagnóstico, distinto de dryMatterSource)', () => {
  const result = sinPastura('inventado');
  assert.equal(result.tipoPasturaAplicado, 'otra');
  assert.equal(result.tipoPasturaDesconocido, true);
});

test('"otra" explícito NO se marca como tipoPasturaDesconocido (es una clasificación válida, aunque igual sea FALLBACK)', () => {
  const result = sinPastura('otra');
  assert.equal(result.tipoPasturaDesconocido, false);
  assert.equal(result.dryMatterSource, 'FALLBACK');
});

test('utilizacionFuenteTipo es SIEMPRE FALLBACK -- ninguna fuente documenta un % específico de especie/cultivar (hardening §5)', () => {
  assert.equal(sinPastura('graminea').utilizacionFuenteTipo, 'FALLBACK');
  assert.equal(resolvePastureClimateParams('graminea', { nombreComun: 'Brachiaria humidicola' }, null).utilizacionFuenteTipo, 'FALLBACK');
});

test('sin contexto agroclimático: utilización base (take-half-leave-half), sin ajuste', () => {
  const result = sinPastura('graminea');
  assert.equal(result.utilizacionPct, 50);
  assert.equal(result.ajusteDeficitHidricoAplicado, false);
});

test('déficit hídrico reciente (< 10mm en 7 días): reduce utilización en 5 puntos, nunca la sube', () => {
  const result = sinPastura('graminea', { precipitacion7dMm: 3 });
  assert.equal(result.utilizacionPct, 45);
  assert.equal(result.ajusteDeficitHidricoAplicado, true);
});

test('precipitación abundante NO incrementa la utilización (regla conservadora, §8 del sprint)', () => {
  const result = sinPastura('graminea', { precipitacion7dMm: 120 });
  assert.equal(result.utilizacionPct, 50);
  assert.equal(result.ajusteDeficitHidricoAplicado, false);
});

test('precipitación exactamente en el umbral (10mm) NO dispara el ajuste', () => {
  const result = sinPastura('graminea', { precipitacion7dMm: 10 });
  assert.equal(result.utilizacionPct, 50);
});

test('precipitacion7dMm null/ausente se trata igual que sin contexto', () => {
  const result = sinPastura('graminea', { precipitacion7dMm: null });
  assert.equal(result.utilizacionPct, 50);
  assert.equal(result.ajusteDeficitHidricoAplicado, false);
});

// ---------------------------------------------------------------------
// Hardening ronda 3 §5/§6: Brachiaria humidicola / Urochloa humidicola --
// único entry PASTURE_SPECIFIC_BASELINE de v1, con dato REAL verificado.
// ---------------------------------------------------------------------

test('Brachiaria humidicola resuelve PASTURE_SPECIFIC_BASELINE por nombre común, con el dato REAL de Feedipedia (26.0%, no 22% sin cita)', () => {
  const result = resolvePastureClimateParams('graminea', { nombreComun: 'Brachiaria humidicola', nombreCientifico: null }, null);
  assert.equal(result.dryMatterSource, 'PASTURE_SPECIFIC_BASELINE');
  assert.equal(result.materiaSecaPct, 26);
  assert.equal(result.utilizacionPct, 50);
  assert.equal(result.pasturaEspecificaMetadata.fuenteTecnica, 'FEEDIPEDIA_BRACHIARIA_HUMIDICOLA');
  assert.deepEqual(result.pasturaEspecificaMetadata.materiaSecaRangoPct, [22.1, 29.8]);
  assert.match(result.pasturaEspecificaMetadata.cultivarEspecie, /humidicola/i);
});

test('la metadata de pastura específica reporta región/contexto y edad de rebrote como "no reportada" en vez de inventarla (hardening §5)', () => {
  const result = resolvePastureClimateParams('graminea', { nombreComun: 'Brachiaria humidicola' }, null);
  assert.equal(result.pasturaEspecificaMetadata.edadRebroteReportada, null);
  assert.ok(typeof result.pasturaEspecificaMetadata.regionContexto === 'string' && result.pasturaEspecificaMetadata.regionContexto.length > 0);
});

test('Urochloa humidicola (sinónimo) resuelve PASTURE_SPECIFIC_BASELINE por nombre científico, sin distinguir mayúsculas/acentos', () => {
  const result = resolvePastureClimateParams('graminea', { nombreComun: 'Pasto de potrero', nombreCientifico: 'urochloa humídicola' }, null);
  assert.equal(result.dryMatterSource, 'PASTURE_SPECIFIC_BASELINE');
  assert.equal(result.materiaSecaPct, 26);
});

test('otra gramínea sin match específico sigue siendo BOTANICAL_TYPE, nunca PASTURE_SPECIFIC_BASELINE (§6: no generalizar sin marcar)', () => {
  const result = resolvePastureClimateParams('graminea', { nombreComun: 'Guinea (Panicum maximum)', nombreCientifico: null }, null);
  assert.equal(result.dryMatterSource, 'BOTANICAL_TYPE');
  assert.equal(result.materiaSecaPct, 20);
  assert.equal(result.pasturaEspecificaMetadata, null);
});

test('match específico también aplica el ajuste por déficit hídrico', () => {
  const result = resolvePastureClimateParams('graminea', { nombreComun: 'Brachiaria humidicola', nombreCientifico: null }, { precipitacion7dMm: 2 });
  assert.equal(result.utilizacionPct, 45);
  assert.equal(result.ajusteDeficitHidricoAplicado, true);
});

test('ficha sin especie dominante (mezcla) nunca resuelve PASTURE_SPECIFIC_BASELINE', () => {
  const result = resolvePastureClimateParams('mezcla', null, null);
  assert.equal(result.dryMatterSource, 'BOTANICAL_TYPE');
});

// ---------------------------------------------------------------------
// Hardening ronda 3 §6/§7: dryMatterSource=MEASURED -- arquitectura
// preparada para un futuro %MS medido/bromatológico, INALCANZABLE por
// cualquier input real de v1 (ningún llamador de la app pasa este
// parámetro todavía).
// ---------------------------------------------------------------------

test('materiaSecaMedidaPct (cuando se provee) resuelve dryMatterSource=MEASURED y tiene prioridad sobre pastura específica/tipo botánico', () => {
  const result = resolvePastureClimateParams('graminea', { nombreComun: 'Brachiaria humidicola' }, null, 24.5);
  assert.equal(result.dryMatterSource, 'MEASURED');
  assert.equal(result.materiaSecaPct, 24.5);
  assert.equal(result.fuenteTecnica.materiaSeca, null);
});

test('materiaSecaMedidaPct inválido (<=0, no numérico) se ignora -- cae al tier normal, nunca rompe', () => {
  assert.equal(resolvePastureClimateParams('graminea', null, null, 0).dryMatterSource, 'BOTANICAL_TYPE');
  assert.equal(resolvePastureClimateParams('graminea', null, null, -5).dryMatterSource, 'BOTANICAL_TYPE');
  assert.equal(resolvePastureClimateParams('graminea', null, null, NaN).dryMatterSource, 'BOTANICAL_TYPE');
});
