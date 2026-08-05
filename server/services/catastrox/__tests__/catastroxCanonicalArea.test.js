// CATX-DELIVERABLE-CANONICAL-001: pruebas de la fuente canónica única de
// área -- sin red, sin Postgres (resolveCanonicalArea/resolveCanonicalAreaForRow
// son funciones puras). Caso real que motivó este sprint: predio
// 185920003000000080019000000000, que mostraba simultáneamente 84,38 ha
// y 866.710,71 m² (valores matemáticamente incompatibles).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAreaConsistency, resolveCanonicalArea, resolveCanonicalAreaForRow } from '../catastroxCanonicalArea.js';

// --- Conversión m² <-> ha ----------------------------------------------------

test('866710.71 m² (geometría válida) -> 86.67 ha (redondeado a 2 decimales en presentación)', () => {
  const result = resolveCanonicalArea({ areaM2Exact: 866710.71 });
  assert.equal(result.source, 'geometry');
  assert.equal(result.canonicalAreaM2, 866710.71);
  assert.equal(Number(result.canonicalAreaHa.toFixed(2)), 86.67);
});

test('843800 m² (geometría válida) -> 84.38 ha', () => {
  const result = resolveCanonicalArea({ areaM2Exact: 843800 });
  assert.equal(Number(result.canonicalAreaM2.toFixed(2)), 843800);
  assert.equal(Number(result.canonicalAreaHa.toFixed(2)), 84.38);
});

// --- Nunca dos áreas incompatibles / misma fuente para ambas ---------------

test('nunca se puede mostrar 84.38 ha junto con 866710.71 m² -- canonicalAreaHa siempre se deriva de canonicalAreaM2', () => {
  // Reproduce el defecto real: geometría en vivo = 866710.71 m² (86.67 ha),
  // atributo catastral registrado = 84.38 ha (INCOMPATIBLE). Con geometría
  // válida presente, esta NUNCA debe ganar sobre la geometría.
  const result = resolveCanonicalArea({ areaM2Exact: 866710.71, areaTerrenoHa: 84.38 });
  assert.equal(result.source, 'geometry');
  assert.equal(result.canonicalAreaM2, 866710.71);
  assert.notEqual(Number(result.canonicalAreaHa.toFixed(2)), 84.38);
  assert.equal(Number(result.canonicalAreaHa.toFixed(2)), 86.67);
  // La discrepancia se señala como warning estructurado, nunca en silencio.
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'AREA_SOURCE_MISMATCH');
});

test('m² y ha siempre salen de la misma fuente canónica -- consistentes en las 4 ramas de origen posibles', () => {
  const cases = [
    { areaM2Exact: 500000 }, // geometry
    { areaTerrenoM2: 500000, areaTerrenoHa: 50 }, // catastral_consistent
    { areaTerrenoM2: 500000 }, // catastral_m2_only
    { areaTerrenoHa: 50 }, // catastral_ha_only
  ];
  cases.forEach((input) => {
    const result = resolveCanonicalArea(input);
    const { consistent } = checkAreaConsistency(result.canonicalAreaM2, result.canonicalAreaHa);
    assert.ok(consistent, `${result.source}: m² y ha deben ser consistentes entre sí`);
  });
});

// --- Fallback sin geometría --------------------------------------------------

test('sin geometría válida -> usa el área catastral registrada como fallback, documentado en `source`', () => {
  const result = resolveCanonicalArea({ areaTerrenoM2: 437150, areaTerrenoHa: 43.715 });
  assert.equal(result.source, 'catastral_consistent');
  assert.equal(result.canonicalAreaM2, 437150);
  assert.equal(result.canonicalAreaHa, 43.715);
});

test('sin geometría y solo un atributo catastral presente -> el otro se DERIVA, nunca queda indefinido', () => {
  const onlyM2 = resolveCanonicalArea({ areaTerrenoM2: 100000 });
  assert.equal(onlyM2.source, 'catastral_m2_only');
  assert.equal(onlyM2.canonicalAreaHa, 10);

  const onlyHa = resolveCanonicalArea({ areaTerrenoHa: 10 });
  assert.equal(onlyHa.source, 'catastral_ha_only');
  assert.equal(onlyHa.canonicalAreaM2, 100000);
});

// --- Seguridad ante datos inválidos -----------------------------------------

test('NaN/null/undefined/negativos/cero en cualquier campo nunca rompen -- nunca lanzan, nunca contaminan el resultado', () => {
  const invalidInputs = [
    { areaM2Exact: NaN },
    { areaM2Exact: null },
    { areaM2Exact: undefined },
    { areaM2Exact: -100 },
    { areaM2Exact: 0 },
    { areaM2Exact: 'no-es-un-numero' },
    {},
    null,
    undefined,
  ];
  invalidInputs.forEach((input) => {
    assert.doesNotThrow(() => resolveCanonicalArea(input), JSON.stringify(input));
  });
});

test('sin ningún dato de área válido -> canonicalAreaM2/canonicalAreaHa null, source="unavailable", nunca NaN', () => {
  const result = resolveCanonicalArea({});
  assert.equal(result.canonicalAreaM2, null);
  assert.equal(result.canonicalAreaHa, null);
  assert.equal(result.source, 'unavailable');
  assert.equal(Number.isNaN(result.canonicalAreaM2), false);
});

test('resolveCanonicalAreaForRow) fila con área NaN/null nunca rompe -- fallback seguro a 0 en el llamador (server/routes/catastrox.js)', () => {
  assert.doesNotThrow(() => resolveCanonicalAreaForRow(null));
  assert.doesNotThrow(() => resolveCanonicalAreaForRow({}));
  assert.doesNotThrow(() => resolveCanonicalAreaForRow({ area_m2_exact: 'garbage', area_terreno_ha: undefined }));
  const result = resolveCanonicalAreaForRow({});
  assert.equal(result.canonicalAreaM2, null);
  assert.equal(result.canonicalAreaHa, null);
});

// --- Tolerancia de consistencia ---------------------------------------------

test('checkAreaConsistency) dentro de tolerancia -> consistent=true', () => {
  const { consistent } = checkAreaConsistency(100000, 10);
  assert.equal(consistent, true);
});

test('checkAreaConsistency) fuera de tolerancia (0.5% por defecto) -> consistent=false', () => {
  // 100000 m² = 10 ha exactas; 8.438 ha implica una discrepancia de más
  // del 15% -- muy por fuera de cualquier tolerancia razonable.
  const { consistent, diffM2 } = checkAreaConsistency(866710.71, 84.38);
  assert.equal(consistent, false);
  assert.ok(diffM2 > 0);
});

test('checkAreaConsistency) valores no finitos -> consistent=false, nunca lanza', () => {
  assert.equal(checkAreaConsistency(NaN, 10).consistent, false);
  assert.equal(checkAreaConsistency(100000, null).consistent, false);
  assert.equal(checkAreaConsistency(undefined, undefined).consistent, false);
});

test('cuando dos atributos catastrales (sin geometría) exceden la tolerancia -> se prioriza m², se registra warning, nunca se mezclan', () => {
  const result = resolveCanonicalArea({ areaTerrenoM2: 866710.71, areaTerrenoHa: 84.38 });
  assert.equal(result.source, 'catastral_m2_priority');
  assert.equal(result.canonicalAreaM2, 866710.71);
  assert.equal(Number(result.canonicalAreaHa.toFixed(2)), 86.67);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'AREA_SOURCE_MISMATCH');
});

// --- Nunca altera geometría/perímetro ---------------------------------------

test('resolveCanonicalArea nunca toca ni conoce geometría/perímetro -- solo recibe y devuelve área', () => {
  const result = resolveCanonicalArea({ areaM2Exact: 500000 });
  assert.deepEqual(Object.keys(result).sort(), ['canonicalAreaHa', 'canonicalAreaM2', 'source', 'warnings']);
});

// --- Caso real ---------------------------------------------------------------

test('caso real 185920003000000080019000000000: geometría en vivo gana sobre el atributo catastral divergente, con warning', () => {
  // Valores exactos reportados en producción para este predio.
  const row = {
    area_m2_exact: 866710.71,
    area_terreno_m2: null,
    area_terreno_ha: 84.38,
  };
  const result = resolveCanonicalAreaForRow(row, { codigoPredial: '185920003000000080019000000000' });
  assert.equal(result.source, 'geometry');
  assert.equal(result.canonicalAreaM2, 866710.71);
  assert.equal(Number(result.canonicalAreaHa.toFixed(2)), 86.67);
  assert.equal(result.warnings.length, 1, 'debe registrar el warning de discrepancia -- nunca en silencio');
});
