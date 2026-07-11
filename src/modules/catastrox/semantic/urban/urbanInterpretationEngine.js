// Motor de interpretacion Convencional / No convencional (Fase 5).
// No infiere calidad, estabilidad, materiales ni legalidad bajo ninguna circunstancia.
import { roundToOneDecimal, formatPercentage } from './urbanNormalizationRules.js';
import { CONFIDENCE_LEVELS } from './urbanQualityRules.js';
import { pluralizeWord as pluralize } from './urbanGrammarRules.js';

function percentageOf(part, base) {
  if (!base || base <= 0) return 0;
  return roundToOneDecimal((part / base) * 100);
}

/**
 * Interpreta la clasificacion constructiva de un predio a partir de conteos ya agregados.
 * No accede a la base de datos ni a geometria: opera exclusivamente sobre los numeros que
 * recibe.
 *
 * @param {Object} input
 * @param {number} input.totalAssociatedRecords
 * @param {number} input.conventionalCount
 * @param {number} input.nonConventionalCount
 * @param {number} [input.unclassifiedCount]
 * @param {number} [input.uniqueGeometryCount]
 * @param {boolean} [input.duplicationDetected]
 */
export function interpretConstructionClassification(input = {}) {
  const total = Math.max(0, Number(input.totalAssociatedRecords) || 0);
  const conventionalCount = Math.max(0, Number(input.conventionalCount) || 0);
  const nonConventionalCount = Math.max(0, Number(input.nonConventionalCount) || 0);
  const duplicationDetected = Boolean(input.duplicationDetected);

  // Regla 4: la diferencia nunca se oculta. El conteo de "sin clasificar" autoritativo es
  // el residuo aritmetico entre el total y las categorias clasificadas, no el parametro de
  // entrada (que puede venir inconsistente).
  const classifiedTotal = conventionalCount + nonConventionalCount;
  const unclassifiedCount = Math.max(0, total - classifiedTotal);
  const hasDiscrepancy = classifiedTotal !== total;

  if (total === 0) {
    return {
      total: 0,
      classifiedTotal: 0,
      conventional: { count: 0, percentage: 0 },
      nonConventional: { count: 0, percentage: 0 },
      unclassified: { count: 0, percentage: 0 },
      dominantClassification: null,
      confidence: CONFIDENCE_LEVELS.BLOQUEADO,
      summary: 'No se registran elementos constructivos asociados a este predio en la fuente catastral consultada.',
      warning: 'Sin registros constructivos disponibles para interpretar.',
    };
  }

  // Regla 1 y 2: porcentajes sobre registros clasificados, redondeados a un decimal.
  const conventionalPct = percentageOf(conventionalCount, classifiedTotal);
  const nonConventionalPct = percentageOf(nonConventionalCount, classifiedTotal);
  const unclassifiedPctOverTotal = percentageOf(unclassifiedCount, total);

  // dominantClassification
  let dominantClassification = null;
  if (classifiedTotal === 0) dominantClassification = 'sin_clasificar';
  else if (conventionalCount > nonConventionalCount) dominantClassification = 'convencional';
  else if (nonConventionalCount > conventionalCount) dominantClassification = 'no_convencional';
  else dominantClassification = 'empatado';

  // Confianza: bloqueado nunca aplica aqui (total>0), pero si hay duplicacion la confianza
  // baja porque el conteo de filas no equivale a construcciones distintas. Si hay
  // registros sin clasificar, la confianza es media (cobertura parcial). Si todo esta
  // clasificado y no hay duplicacion, alta.
  let confidence = CONFIDENCE_LEVELS.ALTA;
  if (duplicationDetected) confidence = CONFIDENCE_LEVELS.BAJA;
  else if (unclassifiedCount > 0) confidence = CONFIDENCE_LEVELS.MEDIA;

  const onlyOneCategory =
    classifiedTotal > 0 && (conventionalCount === 0 || nonConventionalCount === 0);

  const sentences = [];

  if (classifiedTotal === 0) {
    // Solo hay registros sin clasificar.
    sentences.push(
      `Se ${pluralize(total, 'registra', 'registran')} ${total} ${pluralize(total, 'elemento constructivo asociado', 'elementos constructivos asociados')}, sin clasificación catastral disponible por tipo de construcción.`,
    );
  } else if (onlyOneCategory) {
    // Regla 6: solo existe una categoria clasificada: informar la cantidad sin comparar.
    const soleLabel = conventionalCount > 0 ? 'convencional' : 'no convencional';
    const soleCount = conventionalCount > 0 ? conventionalCount : nonConventionalCount;
    sentences.push(
      `Se ${pluralize(soleCount, 'registra', 'registran')} ${soleCount} ${pluralize(soleCount, 'elemento constructivo asociado', 'elementos constructivos asociados')}, ${pluralize(soleCount, 'clasificado', 'clasificados')} por la fuente catastral como ${soleLabel}.`,
    );
    // Regla 7: la categoria en cero se oculta salvo que exista discrepancia de conteo.
    if (hasDiscrepancy) {
      sentences.push(
        `${unclassifiedCount} ${pluralize(unclassifiedCount, 'registro no cuenta', 'registros no cuentan')} con clasificación disponible.`,
      );
    }
  } else {
    // Ambas categorias tienen datos: comparacion legitima.
    sentences.push(
      `De los ${total} registros constructivos asociados, ${conventionalCount} (${formatPercentage(conventionalPct)}) ${pluralize(conventionalCount, 'está clasificado', 'están clasificados')} como convencionales y ${nonConventionalCount} (${formatPercentage(nonConventionalPct)}) como no convencionales.`,
    );
    if (dominantClassification === 'empatado') {
      sentences.push('Ambas clasificaciones presentan la misma proporción.');
    } else {
      sentences.push(`Predomina la clasificación ${dominantClassification === 'convencional' ? 'convencional' : 'no convencional'}.`);
    }
    if (hasDiscrepancy) {
      sentences.push(
        `${unclassifiedCount} ${pluralize(unclassifiedCount, 'registro adicional no cuenta', 'registros adicionales no cuentan')} con clasificación disponible.`,
      );
    }
  }

  const warnings = [];
  if (duplicationDetected) {
    warnings.push(
      'Se detectó posible duplicación geométrica en los registros de origen; el conteo corresponde a filas de la fuente catastral pública, no a construcciones físicas verificadas individualmente.',
    );
  }
  if (unclassifiedCount > 0) {
    warnings.push('Existen registros constructivos sin clasificación disponible en la fuente catastral.');
  }

  return {
    total,
    classifiedTotal,
    conventional: { count: conventionalCount, percentage: conventionalPct },
    nonConventional: { count: nonConventionalCount, percentage: nonConventionalPct },
    unclassified: { count: unclassifiedCount, percentage: unclassifiedPctOverTotal },
    dominantClassification,
    confidence,
    summary: sentences.join(' '),
    warning: warnings.join(' ') || null,
  };
}
