// API publica de la biblioteca semantica urbana (v1, diagnostico). No depende de Canvas
// ni del diseno del PDF actual: recibe datos y devuelve objetos semanticos estructurados.
export { createSemanticField, isFieldComplete } from './urbanFieldCatalog.js';
export {
  URBAN_DOMAIN_REGISTRY,
  getDomainMetadata,
  domainHasVerifiedCoverage,
  getDestinoEconomicoDisplay,
  getUsoDisplay,
  getTipoConstruccionDisplay,
  isAmbiguousDestinoEconomico,
} from './urbanDomainCatalog.js';
export {
  CONSTRUCTION_TYPE_DEFINITIONS,
  buildConstructionTypeField,
  classifyConstructionRecords,
} from './urbanConstructionCatalog.js';
export { buildDestinationField } from './urbanDestinationCatalog.js';
export { buildConstructionUseFields, listConstructionUseLabels } from './urbanUseCatalog.js';
export {
  normalizeText,
  isEmptyValue,
  toNumberOrNull,
  roundToOneDecimal,
  formatPercentage,
  calculateCoverage,
  formatCoveragePercentage,
} from './urbanNormalizationRules.js';
export { buildConstructionCounts, countByCode } from './urbanAggregationRules.js';
export {
  pluralizeWord,
  formatRecordCount,
  pluralizeClassificationLabel,
  formatSingleCategorySentence,
  formatUnclassifiedClause,
} from './urbanGrammarRules.js';
export { CONFIDENCE_LEVELS, determineConfidence, isPdfEligible, requiresWarning } from './urbanQualityRules.js';
export { interpretConstructionClassification } from './urbanInterpretationEngine.js';
export { buildCombinedNarrative } from './urbanNarrativeBuilder.js';
export { buildUrbanPdfSchema } from './urbanPdfSchema.js';
