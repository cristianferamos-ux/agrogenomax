import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConstructionCounts } from '../urbanAggregationRules.js';

// Fase 4, caso A: misma area, mismo identificador, huellas geometricas DISTINTAS ->
// no debe reportarse duplicacion.
test('5. Dos geometrías diferentes con igual área e identificador no se marcan como duplicadas', () => {
  const records = [
    { tipo_construccion_codigo: 'CONVENCIONAL', identificador: 'A', area_construccion_m2: 100, geometryFingerprint: 'hash-uno' },
    { tipo_construccion_codigo: 'CONVENCIONAL', identificador: 'A', area_construccion_m2: 100, geometryFingerprint: 'hash-dos' },
  ];
  const counts = buildConstructionCounts(records);
  assert.equal(counts.sourceRecordCount, 2);
  assert.equal(counts.geometryFingerprintAvailable, true);
  assert.equal(counts.distinctGeometryCount, 2);
  assert.equal(counts.duplicateGeometryRecordCount, 0);
  assert.equal(counts.duplicationDetected, false);
  assert.equal(counts.estimatedGroupCount, null);
  assert.equal(counts.estimatedGroupingUsed, false);
});

// Fase 4, caso B: misma huella geometrica (atributos secundarios pueden variar) -> SI debe
// detectarse duplicacion real, verificada por geometria.
test('6. Dos filas con la misma huella geométrica se detectan como duplicado real', () => {
  const records = [
    { tipo_construccion_codigo: 'CONVENCIONAL', identificador: 'A', area_construccion_m2: 119.911, geometryFingerprint: 'hash-repetido' },
    { tipo_construccion_codigo: 'CONVENCIONAL', identificador: 'B', area_construccion_m2: 119.911, geometryFingerprint: 'hash-repetido' },
  ];
  const counts = buildConstructionCounts(records);
  assert.equal(counts.sourceRecordCount, 2);
  assert.equal(counts.geometryFingerprintAvailable, true);
  assert.equal(counts.distinctGeometryCount, 1);
  assert.equal(counts.duplicateGeometryRecordCount, 1);
  assert.equal(counts.duplicationDetected, true);
  assert.match(counts.warnings.join(' '), /huella geométrica duplicada/i);
});

// Fase 4, caso C: sin huella geometrica en ningun registro -> solo agrupacion estimada,
// nunca se afirma distinctGeometryCount.
test('7. Ausencia de huella geométrica activa agrupación estimada, nunca geometría verificada', () => {
  const records = [
    { tipo_construccion_codigo: 'CONVENCIONAL', identificador: 'A', area_construccion_m2: 50 },
    { tipo_construccion_codigo: 'CONVENCIONAL', identificador: 'A', area_construccion_m2: 50 },
  ];
  const counts = buildConstructionCounts(records);
  assert.equal(counts.geometryFingerprintAvailable, false);
  assert.equal(counts.distinctGeometryCount, null);
  assert.equal(counts.duplicateGeometryRecordCount, null);
  assert.equal(counts.estimatedGroupCount, 1);
  assert.equal(counts.estimatedGroupingUsed, true);
  assert.match(counts.warnings.join(' '), /grupos estimados por atributos coincidentes/i);
  assert.doesNotMatch(counts.warnings.join(' '), /geometría verificada|geometrías distintas detectadas/i);
});

// Regla explicita: si CUALQUIER registro carece de huella, el conjunto completo cae a
// estimado (nunca se mezclan registros verificados con estimados).
test('7b. Huella geométrica parcial (solo algunos registros) también cae a estimado', () => {
  const records = [
    { tipo_construccion_codigo: 'CONVENCIONAL', identificador: 'A', area_construccion_m2: 50, geometryFingerprint: 'hash-1' },
    { tipo_construccion_codigo: 'CONVENCIONAL', identificador: 'B', area_construccion_m2: 60 },
  ];
  const counts = buildConstructionCounts(records);
  assert.equal(counts.geometryFingerprintAvailable, false);
  assert.equal(counts.distinctGeometryCount, null);
  assert.equal(counts.estimatedGroupingUsed, true);
});

test('16. Área sumada de la fuente se marca como potencialmente inflada cuando hay duplicación', () => {
  const withDuplication = buildConstructionCounts([
    { tipo_construccion_codigo: 'CONVENCIONAL', identificador: 'A', area_construccion_m2: 100, geometryFingerprint: 'x' },
    { tipo_construccion_codigo: 'CONVENCIONAL', identificador: 'A', area_construccion_m2: 100, geometryFingerprint: 'x' },
  ]);
  assert.equal(withDuplication.areaSumFromSourceRecords, 200);
  assert.equal(withDuplication.areaMayBeInflated, true);
  assert.match(withDuplication.warnings.join(' '), /puede estar inflada/i);

  const withoutDuplication = buildConstructionCounts([
    { tipo_construccion_codigo: 'CONVENCIONAL', identificador: 'A', area_construccion_m2: 100, geometryFingerprint: 'x' },
    { tipo_construccion_codigo: 'CONVENCIONAL', identificador: 'B', area_construccion_m2: 50, geometryFingerprint: 'y' },
  ]);
  assert.equal(withoutDuplication.areaMayBeInflated, false);
});

test('9. Cobertura parcial: registros clasificados y sin clasificar coexisten sin ocultar la diferencia', () => {
  const counts = buildConstructionCounts([
    { tipo_construccion_codigo: 'CONVENCIONAL', identificador: 'A', area_construccion_m2: 10, geometryFingerprint: 'a' },
    { tipo_construccion_codigo: '', identificador: 'B', area_construccion_m2: 20, geometryFingerprint: 'b' },
    { tipo_construccion_codigo: null, identificador: 'C', area_construccion_m2: 30, geometryFingerprint: 'c' },
  ]);
  assert.equal(counts.sourceRecordCount, 3);
  assert.equal(counts.classifiedRecordCount, 1);
  assert.equal(counts.unclassifiedRecordCount, 2);
  assert.match(counts.warnings.join(' '), /sin clasificación disponible/i);
});

test('Puerto Rico real: 50 filas, huella geométrica confirma exactamente 2 geometrías distintas', () => {
  const identifierA = { tipo_construccion_codigo: 'CONVENCIONAL', identificador: 'A', area_construccion_m2: 119.911, geometryFingerprint: '42389d1159705b27a23f7a48659a8862' };
  const identifierB = { tipo_construccion_codigo: 'CONVENCIONAL', identificador: 'B', area_construccion_m2: 102.334, geometryFingerprint: '891e1b99b0aa012381605b580df53a83' };
  const records = Array.from({ length: 25 }, () => [identifierA, identifierB]).flat();
  const counts = buildConstructionCounts(records);
  assert.equal(counts.sourceRecordCount, 50);
  assert.equal(counts.geometryFingerprintAvailable, true);
  assert.equal(counts.distinctGeometryCount, 2);
  assert.equal(counts.duplicateGeometryRecordCount, 48);
  assert.equal(counts.duplicationDetected, true);
});
