import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDestinationField } from '../urbanDestinationCatalog.js';
import { buildConstructionTypeField } from '../urbanConstructionCatalog.js';
import { determineConfidence, CONFIDENCE_LEVELS, isPdfEligible } from '../urbanQualityRules.js';
import { buildUrbanPdfSchema } from '../urbanPdfSchema.js';

test('14. Elegibilidad para PDF se calcula por campo dentro del esquema completo', () => {
  const predio = {
    codigo_predial: '188600101000000100015000000000',
    direccion_real: 'C 11 5 47 57',
    zona: 'urbano',
    area_terreno_m2: '250',
    area_construida_m2: '250',
    destino_economico_nombre: 'Comercial',
    uso_1_nombre: 'COMERCIO',
  };
  const records = [{ tipo_construccion_codigo: 'CONVENCIONAL', identificador: 'A', area_construccion_m2: 249.618, geometryFingerprint: 'hash-valparaiso' }];
  const schema = buildUrbanPdfSchema(predio, records);

  assert.equal(schema.pdfEligibility.identification, true);
  assert.equal(schema.pdfEligibility.cadastralDestination, true);
  assert.equal(schema.pdfEligibility.constructionClassification, true);
  assert.equal(schema.semanticVersion, 'urban-semantic-v1.1');
  assert.equal(schema.sourceRecordCount, 1);
  assert.equal(schema.geometryAnalysis.fingerprintAvailable, true);
  assert.equal(schema.geometryAnalysis.distinctGeometryCount, 1);
});

test('15. Porcentajes del esquema se calculan sobre registros clasificados (caso religioso)', () => {
  const predio = { codigo_predial: 'x', destino_economico_nombre: 'Religioso', uso_1_nombre: 'IGLESIA' };
  const records = [
    ...Array.from({ length: 6 }, (_, i) => ({ tipo_construccion_codigo: 'CONVENCIONAL', identificador: `C${i}`, area_construccion_m2: 10 + i, geometryFingerprint: `conv-${i}` })),
    ...Array.from({ length: 3 }, (_, i) => ({ tipo_construccion_codigo: 'NO CONVENCIONAL', identificador: `N${i}`, area_construccion_m2: 5 + i, geometryFingerprint: `noconv-${i}` })),
  ];
  const schema = buildUrbanPdfSchema(predio, records);
  assert.match(schema.constructionClassification.interpretation, /66,7 %/);
  assert.match(schema.constructionClassification.interpretation, /33,3 %/);
});

test('Campo bloqueado por baja calidad nunca es apto para PDF', () => {
  // Destino economico con codigo ambiguo (V), explicitamente bloqueado en el catalogo.
  const ambiguous = buildDestinationField('V');
  assert.equal(ambiguous.confidence, 'baja');

  // Codigo de tipo de construccion inexistente en el dominio (no CONVENCIONAL/NO CONVENCIONAL).
  const unknownConstruction = buildConstructionTypeField({ tipo_construccion_codigo: 'PREFABRICADO' });
  assert.equal(unknownConstruction.confidence, 'bloqueado');
  assert.equal(unknownConstruction.pdfEligible, false);
  assert.ok(unknownConstruction.warnings.length > 0);

  assert.equal(determineConfidence({ hasValue: false }), CONFIDENCE_LEVELS.BLOQUEADO);
  assert.equal(isPdfEligible(CONFIDENCE_LEVELS.BLOQUEADO), false);
  assert.equal(isPdfEligible(CONFIDENCE_LEVELS.BAJA), true);
});
