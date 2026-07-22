import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretConstructionClassification } from '../urbanInterpretationEngine.js';
import { buildConstructionCounts, countByCode } from '../urbanAggregationRules.js';
import { classifyConstructionRecords } from '../urbanConstructionCatalog.js';

// Caso 1 (Fase 5, ejemplo textual exacto del pedido): Valparaíso comercial, 1 registro
// convencional.
test('1. Solo convencional (Valparaíso comercial) coincide con el texto esperado', () => {
  const result = interpretConstructionClassification({
    totalAssociatedRecords: 1,
    conventionalCount: 1,
    nonConventionalCount: 0,
  });
  assert.equal(result.total, 1);
  assert.equal(result.conventional.count, 1);
  assert.equal(result.nonConventional.count, 0);
  assert.equal(result.dominantClassification, 'convencional');
  assert.equal(
    result.summary,
    'Se registra 1 elemento constructivo asociado, clasificado por la fuente catastral como convencional.',
  );
  assert.match(result.summary, /^(?!.*edificaci[oó]n)(?!.*construcci[oó]n f[ií]sica).*$/i);
});

test('2. Solo no convencional informa la cantidad sin crear comparación', () => {
  const result = interpretConstructionClassification({
    totalAssociatedRecords: 4,
    conventionalCount: 0,
    nonConventionalCount: 4,
  });
  assert.equal(result.dominantClassification, 'no_convencional');
  assert.equal(result.conventional.count, 0);
  assert.equal(result.nonConventional.count, 4);
  assert.match(result.summary, /registran 4 elementos constructivos asociados.*no convencional/i);
  assert.doesNotMatch(result.summary, /% /); // sin porcentaje al haber una sola categoría
});

// Caso 2 (Fase 5, ejemplo textual exacto del pedido): destinación religiosa.
test('3. Convencional + no convencional coincide con el texto esperado (caso religioso 9 registros)', () => {
  const result = interpretConstructionClassification({
    totalAssociatedRecords: 9,
    conventionalCount: 6,
    nonConventionalCount: 3,
  });
  assert.equal(result.classifiedTotal, 9);
  assert.equal(result.conventional.percentage, 66.7);
  assert.equal(result.nonConventional.percentage, 33.3);
  assert.equal(result.dominantClassification, 'convencional');
  assert.equal(
    result.summary,
    'De los 9 registros constructivos asociados, 6 (66,7 %) están clasificados como convencionales y 3 (33,3 %) como no convencionales. Predomina la clasificación convencional.',
  );
});

test('4. Registros sin clasificación se declaran explícitamente', () => {
  const result = interpretConstructionClassification({
    totalAssociatedRecords: 5,
    conventionalCount: 0,
    nonConventionalCount: 0,
  });
  assert.equal(result.classifiedTotal, 0);
  assert.equal(result.unclassified.count, 5);
  assert.match(result.summary, /sin clasificación catastral disponible/i);
});

test('5. Total distinto a la suma de clasificaciones no oculta la diferencia', () => {
  const result = interpretConstructionClassification({
    totalAssociatedRecords: 10,
    conventionalCount: 6,
    nonConventionalCount: 2,
  });
  // 6 + 2 = 8, total = 10 -> 2 sin clasificar, deben declararse.
  assert.equal(result.unclassified.count, 2);
  assert.match(result.summary, /2 registros adicionales no cuentan con clasificación disponible/);
});

test('6. Duplicación geométrica detectada baja la confianza y evita "construcciones físicas"/"edificaciones"', () => {
  const result = interpretConstructionClassification({
    totalAssociatedRecords: 50,
    conventionalCount: 50,
    nonConventionalCount: 0,
    duplicationDetected: true,
  });
  assert.equal(result.confidence, 'baja');
  assert.doesNotMatch(result.summary, /edificaci[oó]n/i);
  assert.doesNotMatch(result.summary, /construcci[oó]n f[ií]sica/i);
  assert.match(result.warning, /duplicaci[oó]n geom[eé]trica/i);
  assert.match(result.warning, /registros/i);
});

test('7. Total cero no genera división por cero ni afirma clasificación', () => {
  const result = interpretConstructionClassification({
    totalAssociatedRecords: 0,
    conventionalCount: 0,
    nonConventionalCount: 0,
  });
  assert.equal(result.confidence, 'bloqueado');
  assert.equal(result.dominantClassification, null);
  assert.match(result.summary, /no se registran elementos constructivos/i);
});

test('8. Valores nulos/indefinidos no rompen el motor', () => {
  const result = interpretConstructionClassification({
    totalAssociatedRecords: null,
    conventionalCount: undefined,
    nonConventionalCount: null,
  });
  assert.equal(result.total, 0);
  assert.equal(result.confidence, 'bloqueado');
});

test('9. Etiquetas de dominio desconocidas se cuentan como sin clasificar, no se inventan', () => {
  const records = [
    { tipo_construccion_codigo: 'CONVENCIONAL', identificador: 'A', area_construccion_m2: 10 },
    { tipo_construccion_codigo: 'CODIGO_DESCONOCIDO_XYZ', identificador: 'B', area_construccion_m2: 20 },
  ];
  const counts = buildConstructionCounts(records);
  const classified = classifyConstructionRecords(records);
  // El codigo desconocido no es CONVENCIONAL ni NO CONVENCIONAL: no debe contarse en
  // ninguna de las dos categorias conocidas, pero tampoco debe perderse del total ni
  // inventarse como "clasificado".
  assert.equal(classified.conventionalCount, 1);
  assert.equal(classified.nonConventionalCount, 0);
  assert.equal(counts.sourceRecordCount, 2);
  assert.equal(counts.classifiedRecordCount, 1);
  assert.equal(counts.unclassifiedRecordCount, 1);
  const byCode = countByCode(records);
  assert.equal(byCode.get('CODIGO_DESCONOCIDO_XYZ'), 1);

  const interpreted = interpretConstructionClassification({
    totalAssociatedRecords: counts.sourceRecordCount,
    conventionalCount: classified.conventionalCount,
    nonConventionalCount: classified.nonConventionalCount,
  });
  // total=2, clasificados=1 (solo convencional) -> discrepancia de 1, debe declararse.
  assert.equal(interpreted.unclassified.count, 1);
  assert.match(interpreted.summary, /1 registro no cuenta con clasificación disponible/);
});
