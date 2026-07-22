// Destinacion economica catastral. Reutiliza getDestinoEconomicoDisplay del catalogo
// existente (CATASTRO_DESTINOS). El dominio traduce el codigo a una categoria catastral
// (Religioso, Comercial, Habitacional, etc.) sin implicar licencias, formalidad ni uso
// legal verificado.
import { createSemanticField } from './urbanFieldCatalog.js';
import { getDestinoEconomicoDisplay, isAmbiguousDestinoEconomico } from './urbanDomainCatalog.js';
import { CONFIDENCE_LEVELS } from './urbanQualityRules.js';
import { isEmptyValue } from './urbanNormalizationRules.js';

const FORBIDDEN_INFERENCES = [
  'Existencia de institución formal o registrada',
  'Licencia de funcionamiento',
  'Uso legal certificado',
  'Cumplimiento normativo',
];

export function buildDestinationField(rawDestino) {
  const display = getDestinoEconomicoDisplay(rawDestino);
  const ambiguous = isAmbiguousDestinoEconomico(rawDestino);
  const hasValue = !isEmptyValue(rawDestino);

  let confidence = CONFIDENCE_LEVELS.BLOQUEADO;
  if (hasValue && display.isKnown && !ambiguous) confidence = CONFIDENCE_LEVELS.ALTA;
  else if (hasValue && ambiguous) confidence = CONFIDENCE_LEVELS.BAJA;
  else if (hasValue && !display.isKnown) confidence = CONFIDENCE_LEVELS.MEDIA;

  return createSemanticField({
    key: 'cadastralDestination',
    sourceTable: 'REGISTRO_1 / catastrox_clean.predios',
    sourceField: 'DESTINO_ECONOMICO',
    sourceDomain: 'CATASTRO_DESTINOS',
    rawValue: rawDestino ?? null,
    normalizedValue: hasValue ? display.value : null,
    sourceLabel: display.value,
    commercialLabel: display.value,
    scope: 'predio',
    dataType: 'enum',
    coverage: hasValue ? 1 : 0,
    confidence,
    interpretationAllowed: hasValue ? ['Clasificación catastral de destinación económica'] : [],
    warnings: ambiguous ? [display.note].filter(Boolean) : [],
    forbiddenInferences: FORBIDDEN_INFERENCES,
  });
}
