import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCombinedNarrative } from '../urbanNarrativeBuilder.js';

// Caso real: Valparaíso religioso (188600101000000170001000000000).
test('2. Destinación religiosa reproduce exactamente la narrativa esperada (9 registros)', () => {
  const { narrative, forbiddenAssertions } = buildCombinedNarrative({
    destinationLabel: 'Religioso',
    useLabels: ['AULAS DE CLASES', 'IGLESIA', 'VIVIENDA HASTA 3 PISOS'],
    constructionCounts: {
      totalAssociatedRecords: 9,
      conventionalCount: 6,
      nonConventionalCount: 3,
    },
  });
  assert.equal(
    narrative,
    'El predio presenta destinación catastral religiosa y registra usos constructivos asociados a aulas de clase, iglesia y vivienda. De los 9 registros constructivos asociados, 6 están clasificados como convencionales y 3 como no convencionales; predomina la clasificación convencional.',
  );
  assert.doesNotMatch(narrative, /instituci[oó]n educativa formal/i);
  assert.doesNotMatch(narrative, /licencia/i);
  assert.doesNotMatch(narrative, /nueve edificios/i);
  assert.doesNotMatch(narrative, /segur[ao]/i);
  assert.ok(forbiddenAssertions.length > 0);
});

// Caso real: Valparaíso comercial (188600101000000100015000000000), 1 registro.
// Fase 5 de la corrección: la frase singular ya NO debe decir
// "De los 1 registros constructivos asociados, 1 están clasificados...".
test('1. Valparaíso comercial con un registro usa gramática singular correcta', () => {
  const { narrative } = buildCombinedNarrative({
    destinationLabel: 'Comercial',
    useLabels: ['COMERCIO'],
    constructionCounts: { totalAssociatedRecords: 1, conventionalCount: 1, nonConventionalCount: 0 },
  });
  assert.match(narrative, /destinación catastral comercial/);
  assert.match(narrative, /usos? constructivos? asociados? a comercio/);
  assert.doesNotMatch(narrative, /1 registros constructivos asociados/);
  assert.doesNotMatch(narrative, /1 están clasificados/);
  assert.match(narrative, /El predio registra un registro constructivo asociado, clasificado como convencional\.$/);
});

test('11. Singular convencional produce exactamente el texto pedido', () => {
  const { narrative } = buildCombinedNarrative({
    destinationLabel: null,
    useLabels: [],
    constructionCounts: { totalAssociatedRecords: 1, conventionalCount: 1, nonConventionalCount: 0 },
  });
  assert.match(narrative, /El predio registra un registro constructivo asociado, clasificado como convencional\.$/);
});

test('12. Singular no convencional produce exactamente el texto pedido', () => {
  const { narrative } = buildCombinedNarrative({
    destinationLabel: null,
    useLabels: [],
    constructionCounts: { totalAssociatedRecords: 1, conventionalCount: 0, nonConventionalCount: 1 },
  });
  assert.match(narrative, /El predio registra un registro constructivo asociado, clasificado como no convencional\.$/);
});

// Caso real: Puerto Rico (185920101000000330023000000000), 50 filas pero solo 2
// geometrías reales distintas (huella geométrica confirmada). La narrativa nunca debe
// afirmar "50 construcciones" ni "edificaciones"; el conteo de registros de fuente (50)
// se mantiene intacto porque describe filas de la fuente, no edificios.
test('3. Puerto Rico mantiene 50 registros de fuente en la narrativa sin afirmar edificaciones', () => {
  const { narrative } = buildCombinedNarrative({
    destinationLabel: 'Habitacional',
    useLabels: ['VIVIENDA HASTA 3 PISOS', 'RAMADAS - COBERTIZOS - CANEYES'],
    constructionCounts: { totalAssociatedRecords: 50, conventionalCount: 50, nonConventionalCount: 0 },
  });
  assert.match(narrative, /destinación catastral habitacional/);
  assert.match(narrative, /De los 50 registros constructivos asociados, 50 están clasificados como convencionales\.$/);
  assert.doesNotMatch(narrative, /edificaci[oó]n/i);
  assert.doesNotMatch(narrative, /construcci[oó]n f[ií]sica/i);
});

// Caso real: La Montañita (184100100000000340001000000000): uso_1 y uso_2 son literalmente
// la misma etiqueta ("VIVIENDA HASTA 3 PISOS"); no debe producirse "vivienda y vivienda".
test('4. La Montañita deduplica usos repetidos idénticos', () => {
  const { narrative } = buildCombinedNarrative({
    destinationLabel: 'Habitacional',
    useLabels: ['VIVIENDA HASTA 3 PISOS', 'VIVIENDA HASTA 3 PISOS'],
    constructionCounts: { totalAssociatedRecords: 20, conventionalCount: 20, nonConventionalCount: 0 },
  });
  assert.doesNotMatch(narrative, /vivienda y vivienda/);
  assert.match(narrative, /asociados a vivienda\./);
  assert.match(narrative, /De los 20 registros constructivos asociados, 20 están clasificados como convencionales\.$/);
});

test('8. Registros sin clasificar se declaran en la narrativa combinada', () => {
  const { narrative } = buildCombinedNarrative({
    destinationLabel: 'Comercial',
    useLabels: ['COMERCIO'],
    constructionCounts: { totalAssociatedRecords: 5, conventionalCount: 3, nonConventionalCount: 0 },
  });
  assert.match(narrative, /2 registros no cuentan con clasificación disponible/);
});

test('10. Cero registros no produce afirmaciones de clasificación', () => {
  const { narrative } = buildCombinedNarrative({
    destinationLabel: 'Comercial',
    useLabels: ['COMERCIO'],
    constructionCounts: { totalAssociatedRecords: 0, conventionalCount: 0, nonConventionalCount: 0 },
  });
  assert.match(narrative, /No se registran elementos constructivos asociados/);
});

test('13. Inferencias prohibidas siempre acompañan la narrativa combinada', () => {
  const { forbiddenAssertions } = buildCombinedNarrative({
    destinationLabel: 'Religioso',
    useLabels: ['IGLESIA'],
    constructionCounts: { totalAssociatedRecords: 1, conventionalCount: 1, nonConventionalCount: 0 },
  });
  assert.ok(forbiddenAssertions.includes('Existencia de institución formal o registrada'));
  assert.ok(forbiddenAssertions.includes('Seguridad de la edificación'));
});

test('Varios usos constructivos se listan con "y" natural entre el último elemento', () => {
  const { narrative } = buildCombinedNarrative({
    destinationLabel: 'Comercial',
    useLabels: ['COMERCIO', 'OFICINAS - CONSULTORIOS', 'BODEGAS COMERCIALES - GRANDES ALMACENES'],
    constructionCounts: { totalAssociatedRecords: 3, conventionalCount: 3, nonConventionalCount: 0 },
  });
  assert.match(narrative, /comercio, oficinas y bodegas comerciales - grandes almacenes/);
});
