// Usos constructivos (uso_1/uso_2/uso_3). Reutiliza getUsoDisplay del catalogo existente
// (CATASTRO_USOS). Un uso como "AULAS DE CLASES" o "IGLESIA" describe la clasificacion
// catastral del predio, no confirma la existencia de una institucion formal.
import { createSemanticField } from './urbanFieldCatalog.js';
import { getUsoDisplay } from './urbanDomainCatalog.js';
import { CONFIDENCE_LEVELS } from './urbanQualityRules.js';
import { isEmptyValue } from './urbanNormalizationRules.js';

const FORBIDDEN_INFERENCES = [
  'Existencia de institución formal',
  'Formalidad del uso declarado',
  'Licencia o permiso de funcionamiento',
];

function buildSingleUseField(rawUso, slot) {
  const display = getUsoDisplay(rawUso);
  const hasValue = !isEmptyValue(rawUso);

  return createSemanticField({
    key: `constructionUse_${slot}`,
    sourceTable: 'REGISTRO_1 / catastrox_clean.predios',
    sourceField: `USO_${slot}`,
    sourceDomain: 'CATASTRO_USOS',
    rawValue: rawUso ?? null,
    normalizedValue: hasValue ? display.value : null,
    sourceLabel: display.value,
    commercialLabel: display.value,
    scope: 'predio',
    dataType: 'enum',
    coverage: hasValue ? 1 : 0,
    confidence: hasValue && display.isKnown ? CONFIDENCE_LEVELS.ALTA : CONFIDENCE_LEVELS.BLOQUEADO,
    interpretationAllowed: hasValue ? ['Clasificación catastral de uso constructivo'] : [],
    warnings: [],
    forbiddenInferences: FORBIDDEN_INFERENCES,
  });
}

/**
 * Construye la lista de campos de uso (uso_1/2/3) para un predio, filtrando slots vacios
 * o no aprobados para mostrar.
 */
export function buildConstructionUseFields(predio) {
  const raw = [predio?.uso_1_nombre ?? predio?.uso1Nombre, predio?.uso_2_nombre ?? predio?.uso2Nombre, predio?.uso_3_nombre ?? predio?.uso3Nombre];
  return raw.map((value, index) => buildSingleUseField(value, index + 1)).filter((field) => field.pdfEligible && field.coverage > 0);
}

export function listConstructionUseLabels(predio) {
  return buildConstructionUseFields(predio).map((field) => field.commercialLabel);
}
