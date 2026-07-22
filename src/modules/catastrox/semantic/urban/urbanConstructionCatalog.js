// Definiciones seguras de los valores del dominio domTipoConstruccion. El dominio en la
// GDB publica ("Tipos de Construccion") no aporta ninguna descripcion de materiales,
// resistencia estructural, legalidad ni estado de conservacion (confirmado por
// ogrinfo -fielddomain domTipoConstruccion, ver audit_outputs/catastrox/semantic_urban/
// dom_tipo_construccion_audit.csv). Por lo tanto ninguna de esas inferencias esta permitida.
import { createSemanticField } from './urbanFieldCatalog.js';
import { getTipoConstruccionDisplay } from './urbanDomainCatalog.js';
import { CONFIDENCE_LEVELS } from './urbanQualityRules.js';
import { buildConstructionCounts } from './urbanAggregationRules.js';

const FORBIDDEN_INFERENCES_COMMON = [
  'Material de construcción',
  'Resistencia estructural',
  'Estado de conservación',
  'Legalidad',
  'Licencia de construcción',
  'Seguridad de la edificación',
];

export const CONSTRUCTION_TYPE_DEFINITIONS = {
  CONVENCIONAL: {
    commercialLabel: 'Registro constructivo convencional',
    interpretationAllowed: ['Clasificación catastral convencional'],
    forbiddenInferences: FORBIDDEN_INFERENCES_COMMON,
  },
  'NO CONVENCIONAL': {
    commercialLabel: 'Registro constructivo no convencional',
    interpretationAllowed: ['Clasificación catastral no convencional'],
    forbiddenInferences: [
      ...FORBIDDEN_INFERENCES_COMMON,
      'Precariedad',
      'Informalidad',
      'Inseguridad de la construcción',
    ],
  },
};

/**
 * Construye el campo semantico "constructionType" para UNA fila de construccion, siguiendo
 * exactamente el ejemplo del contrato de Fase 2.
 */
export function buildConstructionTypeField(record) {
  const rawCode = String(record?.tipo_construccion_codigo ?? record?.tipoConstruccionCodigo ?? '').trim().toUpperCase();
  const display = getTipoConstruccionDisplay(rawCode);
  const definition = CONSTRUCTION_TYPE_DEFINITIONS[rawCode] || null;

  return createSemanticField({
    key: 'constructionType',
    sourceTable: 'U_CONSTRUCCION / catastrox_clean.construcciones',
    sourceField: 'TIPO_CONSTRUCCION',
    sourceDomain: 'domTipoConstruccion',
    rawValue: rawCode,
    normalizedValue: definition ? rawCode : null,
    sourceLabel: display.value,
    commercialLabel: definition?.commercialLabel || display.value,
    scope: 'registro_constructivo',
    dataType: 'enum',
    coverage: definition ? 1 : 0,
    confidence: definition ? CONFIDENCE_LEVELS.ALTA : CONFIDENCE_LEVELS.BLOQUEADO,
    interpretationAllowed: definition?.interpretationAllowed || [],
    warnings: definition ? [] : ['Código de tipo de construcción sin dominio verificable para este registro.'],
    forbiddenInferences: definition?.forbiddenInferences || FORBIDDEN_INFERENCES_COMMON,
  });
}

/**
 * Clasifica un conjunto de registros constructivos de un predio en convencional/no
 * convencional/sin clasificar, reutilizando urbanAggregationRules (Fase 3) para el conteo
 * de filas y la deteccion de duplicacion geometrica (real o estimada).
 */
export function classifyConstructionRecords(records = []) {
  const counts = buildConstructionCounts(records);
  return {
    ...counts,
    // Alias retrocompatibles usados por el motor de interpretacion (Fase 5 original).
    conventionalCount: counts.conventionalRecordCount,
    nonConventionalCount: counts.nonConventionalRecordCount,
  };
}
