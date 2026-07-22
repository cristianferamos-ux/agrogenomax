// Construye la narrativa combinada (Fase 6): destinacion + usos + clasificacion
// constructiva + area, en un unico parrafo comercial controlado. Nunca afirma
// formalidad institucional, licencias, cumplimiento normativo ni seguridad estructural.
import { interpretConstructionClassification } from './urbanInterpretationEngine.js';
import {
  pluralizeWord,
  pluralizeClassificationLabel,
  formatSingleCategorySentence,
  formatUnclassifiedClause,
} from './urbanGrammarRules.js';

// Alias narrativos para las etiquetas de uso mas frecuentes en Caqueta, para evitar
// frases robóticas ("AULAS DE CLASES" -> "aulas de clase"). Los usos sin alias se
// muestran con su etiqueta comercial completa en minúscula (fallback seguro, nunca
// inventa un nombre). Ampliable sin tocar el resto del motor.
const USE_NARRATIVE_ALIASES = {
  'AULAS DE CLASES': 'aulas de clase',
  IGLESIA: 'iglesia',
  'VIVIENDA HASTA 3 PISOS': 'vivienda',
  COMERCIO: 'comercio',
  'RAMADAS - COBERTIZOS - CANEYES': 'ramadas y cobertizos',
  'COLEGIO Y UNIVERSIDADES': 'colegio o universidad',
  'OFICINAS - CONSULTORIOS': 'oficinas',
  BODEGAS: 'bodegas',
};

// Heuristica minima de concordancia de genero para adjetivos de destinacion economica
// terminados en "-o" (ej. Religioso -> religiosa, Educativo -> educativa), ya que
// "destinación" es femenino. No se aplica a frases compuestas (se dejan tal cual).
function toFeminineAdjective(label) {
  const clean = String(label || '').trim();
  if (!clean || clean.includes(' ')) return clean.toLowerCase();
  if (clean.toLowerCase().endsWith('o')) return `${clean.slice(0, -1)}a`.toLowerCase();
  return clean.toLowerCase();
}

function describeUse(label) {
  const clean = String(label || '').trim();
  if (!clean) return '';
  return USE_NARRATIVE_ALIASES[clean.toUpperCase()] || clean.toLowerCase();
}

function joinNaturally(items) {
  // Deduplica valores identicos (p. ej. uso_1 y uso_2 repitiendo la misma etiqueta) para
  // evitar frases redundantes como "vivienda y vivienda"; no oculta usos genuinamente
  // distintos.
  const clean = [...new Set(items.filter(Boolean))];
  if (clean.length === 0) return '';
  if (clean.length === 1) return clean[0];
  return `${clean.slice(0, -1).join(', ')} y ${clean[clean.length - 1]}`;
}

// Version compacta de la clasificacion constructiva para narrativa combinada: sin
// porcentajes, unida con punto y coma. Reutiliza los mismos conteos y reglas que
// interpretConstructionClassification (Fase 5); toda la concordancia singular/plural vive
// en urbanGrammarRules.js (Fase 5 de la correccion), no se dispersan condicionales aqui.
function describeClassificationCompact(classification) {
  const { total, conventional, nonConventional, unclassified, dominantClassification, classifiedTotal } = classification;

  if (total === 0) return 'No se registran elementos constructivos asociados a este predio.';

  if (classifiedTotal === 0) {
    return total === 1
      ? 'El predio registra un elemento constructivo asociado, sin clasificación catastral disponible por tipo de construcción.'
      : `Se registran ${total} elementos constructivos asociados, sin clasificación catastral disponible por tipo de construcción.`;
  }

  const onlyOneCategory = conventional.count === 0 || nonConventional.count === 0;

  if (onlyOneCategory) {
    const soleLabel = conventional.count > 0 ? 'convencional' : 'no convencional';
    const soleCount = conventional.count > 0 ? conventional.count : nonConventional.count;
    // formatSingleCategorySentence ya cubre singular ("El predio registra un registro...")
    // y plural ("De los N registros..."); se le quita el punto final para poder anexar la
    // clausula de sin-clasificar cuando exista discrepancia.
    let sentence = formatSingleCategorySentence(soleCount, soleLabel).replace(/\.$/, '');
    if (unclassified.count > 0) sentence += `; ${formatUnclassifiedClause(unclassified.count)}`;
    return `${sentence}.`;
  }

  const conventionalVerb = pluralizeWord(conventional.count, 'está clasificado', 'están clasificados');
  const conventionalLabel = pluralizeClassificationLabel(conventional.count, 'convencional');
  const nonConventionalLabel = pluralizeClassificationLabel(nonConventional.count, 'no convencional');
  let sentence = `De los ${total} registros constructivos asociados, ${conventional.count} ${conventionalVerb} como ${conventionalLabel} y ${nonConventional.count} como ${nonConventionalLabel}`;
  if (dominantClassification === 'empatado') {
    sentence += '; ambas clasificaciones presentan la misma proporción';
  } else {
    sentence += `; predomina la clasificación ${dominantClassification === 'convencional' ? 'convencional' : 'no convencional'}`;
  }
  if (unclassified.count > 0) sentence += `; ${formatUnclassifiedClause(unclassified.count, { adicional: true })}`;
  return `${sentence}.`;
}

/**
 * Construye la narrativa combinada de un predio urbano: destinacion + usos + clasificacion
 * constructiva, siguiendo el ejemplo exacto de Fase 6 (caso religioso).
 *
 * @param {Object} input
 * @param {string} input.destinationLabel - etiqueta comercial ya traducida (ej. "Religioso").
 * @param {string[]} input.useLabels - etiquetas comerciales de uso ya traducidas.
 * @param {Object} input.constructionCounts - { totalAssociatedRecords, conventionalCount, nonConventionalCount, unclassifiedCount, duplicationDetected }
 */
export function buildCombinedNarrative({ destinationLabel, useLabels = [], constructionCounts = {} } = {}) {
  const classification = interpretConstructionClassification(constructionCounts);

  const destinationSentencePart = destinationLabel
    ? `El predio presenta destinación catastral ${toFeminineAdjective(destinationLabel)}`
    : 'El predio no registra destinación catastral disponible';

  const usesText = joinNaturally(useLabels.map(describeUse));
  const usesSentencePart = usesText
    ? ` y registra usos constructivos asociados a ${usesText}.`
    : '.';

  const openingSentence = `${destinationSentencePart}${usesSentencePart}`;
  const classificationSentence = describeClassificationCompact(classification);

  return {
    narrative: `${openingSentence} ${classificationSentence}`,
    classification,
    forbiddenAssertions: [
      'Existencia de institución formal o registrada',
      'Licencia o permiso de funcionamiento',
      'Cumplimiento de normas de construcción',
      'Seguridad de la edificación',
      'Conteo exacto de edificios físicos',
    ],
  };
}
