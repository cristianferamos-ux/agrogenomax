// SPRINT-3D8-DESCANSO-REENTRADA (hardening dinámico) §2/§3/§4: baseline
// FISIOLÓGICO/REGIONAL de referencia -- fixture real POTRERO 1
// (humidicola) + NUNCA un fallback universal inventado para cualquier
// otra pastura (null bloquea con NO_PASTURE_PROFILE en el repositorio).
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePasturaDescansoBaseline } from '../pasturaDescansoBaselineEngine.js';

test('Brachiaria humidicola (nombre común) resuelve el baseline regional específico documentado', () => {
  const baseline = resolvePasturaDescansoBaseline({ nombreComun: 'Brachiaria humidicola', nombreCientifico: 'Urochloa humidicola' });
  assert.equal(baseline.sourceType, 'PASTURE_SPECIFIC_REGIONAL');
  assert.equal(baseline.restDaysMinReference, 25);
  assert.equal(baseline.restDaysTypicalReference, 30);
  assert.equal(baseline.restDaysMaxReference, 35);
  assert.equal(baseline.referenceEntryHeightCm, 30);
  assert.equal(baseline.referenceExitHeightCm, 15);
  assert.equal(baseline.fuenteTecnica, 'RINCON_2018_HUMIDICOLA_LLANERO');
  assert.ok(baseline.fuenteTecnicaDetalle);
  assert.ok(Array.isArray(baseline.metadata.limitaciones));
  assert.ok(baseline.metadata.region);
});

test('Urochloa humidicola (nombre científico, sin nombre común) también resuelve el baseline específico', () => {
  const baseline = resolvePasturaDescansoBaseline({ nombreComun: null, nombreCientifico: 'Urochloa humidicola' });
  assert.equal(baseline.sourceType, 'PASTURE_SPECIFIC_REGIONAL');
  assert.equal(baseline.restDaysTypicalReference, 30);
});

test('coincidencia insensible a mayúsculas/acentos', () => {
  const baseline = resolvePasturaDescansoBaseline({ nombreComun: 'BRACHIARIA HUMIDÍCOLA', nombreCientifico: null });
  assert.equal(baseline.sourceType, 'PASTURE_SPECIFIC_REGIONAL');
});

test('§4 del hardening: pastura sin perfil regional específico devuelve null -- NUNCA un fallback universal inventado', () => {
  const baseline = resolvePasturaDescansoBaseline({ nombreComun: 'Guinea (Colonião)', nombreCientifico: 'Megathyrsus maximus' });
  assert.equal(baseline, null);
});

test('mezcla sin nombres (ficha tipo_cobertura=mezcla) también devuelve null', () => {
  const baseline = resolvePasturaDescansoBaseline({ nombreComun: null, nombreCientifico: null });
  assert.equal(baseline, null);
});

test('el baseline nunca reporta un rango invertido (min <= typical <= max)', () => {
  const baseline = resolvePasturaDescansoBaseline({ nombreComun: 'Brachiaria humidicola', nombreCientifico: null });
  assert.ok(baseline.restDaysMinReference <= baseline.restDaysTypicalReference);
  assert.ok(baseline.restDaysTypicalReference <= baseline.restDaysMaxReference);
});
