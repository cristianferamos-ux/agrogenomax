// Contrato de campo semantico urbano (Fase 2). Cada campo interpretado por la biblioteca
// debe tener exactamente esta forma, sin importar de que catalogo provenga.
import { isPdfEligible } from './urbanQualityRules.js';

/**
 * @typedef {Object} SemanticField
 * @property {string} key
 * @property {string} sourceTable
 * @property {string} sourceField
 * @property {string|null} sourceDomain
 * @property {*} rawValue
 * @property {*} normalizedValue
 * @property {string} sourceLabel
 * @property {string} commercialLabel
 * @property {string} scope
 * @property {string} dataType
 * @property {number} coverage
 * @property {'alta'|'media'|'baja'|'bloqueado'} confidence
 * @property {boolean} pdfEligible
 * @property {string[]} interpretationAllowed
 * @property {string[]} warnings
 * @property {string[]} forbiddenInferences
 */

/**
 * Crea un campo semantico validando que cumpla el contrato exacto de Fase 2.
 * No infiere valores por defecto peligrosos: si no se provee confidence, se asume
 * 'bloqueado' (fail-safe) en vez de 'alta'.
 * @returns {SemanticField}
 */
export function createSemanticField(overrides = {}) {
  const confidence = overrides.confidence || 'bloqueado';
  return {
    key: overrides.key || '',
    sourceTable: overrides.sourceTable || '',
    sourceField: overrides.sourceField || '',
    sourceDomain: overrides.sourceDomain ?? null,
    rawValue: overrides.rawValue ?? null,
    normalizedValue: overrides.normalizedValue ?? null,
    sourceLabel: overrides.sourceLabel || '',
    commercialLabel: overrides.commercialLabel || '',
    scope: overrides.scope || '',
    dataType: overrides.dataType || 'string',
    coverage: typeof overrides.coverage === 'number' ? overrides.coverage : 0,
    confidence,
    pdfEligible: overrides.pdfEligible ?? isPdfEligible(confidence),
    interpretationAllowed: Array.isArray(overrides.interpretationAllowed) ? overrides.interpretationAllowed : [],
    warnings: Array.isArray(overrides.warnings) ? overrides.warnings : [],
    forbiddenInferences: Array.isArray(overrides.forbiddenInferences) ? overrides.forbiddenInferences : [],
  };
}

export function isFieldComplete(field) {
  return Boolean(
    field &&
      typeof field.key === 'string' && field.key &&
      typeof field.sourceTable === 'string' &&
      typeof field.sourceField === 'string' &&
      Array.isArray(field.interpretationAllowed) &&
      Array.isArray(field.forbiddenInferences),
  );
}
