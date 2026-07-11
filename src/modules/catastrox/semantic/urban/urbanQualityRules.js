// Niveles de confianza (Fase 7) y bloqueo automatico de campos no aptos para PDF.

export const CONFIDENCE_LEVELS = {
  ALTA: 'alta',
  MEDIA: 'media',
  BAJA: 'baja',
  BLOQUEADO: 'bloqueado',
};

/**
 * Determina el nivel de confianza de un campo semantico segun evidencia verificable.
 *
 * ALTA: dominio confirmado, valor presente, relacion de origen verificable.
 * MEDIA: campo existente pero con cobertura parcial o agregacion aun no perfeccionada.
 * BAJA: dato ambiguo, codigo sin dominio, posible duplicacion o relacion incompleta.
 * BLOQUEADO: sin dominio, sin cobertura, inconsistente o no apto para PDF.
 */
export function determineConfidence({
  hasDomain = false,
  hasValue = true,
  coverage = 1,
  isAmbiguous = false,
  duplicationDetected = false,
  relationVerifiable = true,
  inconsistent = false,
} = {}) {
  if (!hasValue || inconsistent) {
    return CONFIDENCE_LEVELS.BLOQUEADO;
  }
  if (!hasDomain && !relationVerifiable) {
    return CONFIDENCE_LEVELS.BLOQUEADO;
  }
  if (!hasDomain || isAmbiguous || duplicationDetected || !relationVerifiable) {
    return CONFIDENCE_LEVELS.BAJA;
  }
  if (coverage < 1) {
    return CONFIDENCE_LEVELS.MEDIA;
  }
  return CONFIDENCE_LEVELS.ALTA;
}

// Un campo BLOQUEADO nunca es apto para PDF. Un campo BAJA puede mostrarse solo con
// advertencia explicita (queda a criterio de quien construya el schema, pero nunca sin
// advertencia). ALTA/MEDIA son aptos.
export function isPdfEligible(confidence) {
  return confidence !== CONFIDENCE_LEVELS.BLOQUEADO;
}

export function requiresWarning(confidence) {
  return confidence === CONFIDENCE_LEVELS.BAJA || confidence === CONFIDENCE_LEVELS.MEDIA;
}
