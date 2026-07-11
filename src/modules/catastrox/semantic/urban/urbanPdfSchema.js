// Ensambla el esquema de salida (Fase 8 original + Fase 7 de la correccion). No depende
// de Canvas ni del diseno del PDF: recibe datos crudos de predio + registros constructivos
// (opcionalmente con geometryFingerprint ya calculado fuera de la biblioteca) y devuelve un
// objeto semantico estructurado, listo para que una fase futura decida como dibujarlo.
import { buildDestinationField } from './urbanDestinationCatalog.js';
import { buildConstructionUseFields, listConstructionUseLabels } from './urbanUseCatalog.js';
import { classifyConstructionRecords } from './urbanConstructionCatalog.js';
import { buildConstructionCounts } from './urbanAggregationRules.js';
import { interpretConstructionClassification } from './urbanInterpretationEngine.js';
import { buildCombinedNarrative } from './urbanNarrativeBuilder.js';
import { createSemanticField } from './urbanFieldCatalog.js';
import { CONFIDENCE_LEVELS, isPdfEligible } from './urbanQualityRules.js';
import { isEmptyValue, toNumberOrNull } from './urbanNormalizationRules.js';

const SEMANTIC_VERSION = 'urban-semantic-v1.1';
const CONSTRUCTION_RECORDS_TITLE = 'Registros constructivos asociados';
const CONSTRUCTION_CLASSIFICATION_TITLE = 'Clasificación de los registros constructivos';
const CLASSIFICATION_WARNING = 'Clasificación catastral; no constituye evaluación estructural.';

function buildIdentificationSection(predio) {
  const direccion = predio.direccion_real ?? predio.direccionReal;
  return {
    codigoPredial: createSemanticField({
      key: 'codigoPredial',
      sourceTable: 'U_TERRENO / catastrox_clean.predios',
      sourceField: 'CODIGO',
      rawValue: predio.codigo_predial ?? predio.codigoPredial ?? null,
      normalizedValue: predio.codigo_predial ?? predio.codigoPredial ?? null,
      sourceLabel: predio.codigo_predial ?? predio.codigoPredial ?? '',
      commercialLabel: predio.codigo_predial ?? predio.codigoPredial ?? '',
      scope: 'predio',
      dataType: 'string',
      coverage: isEmptyValue(predio.codigo_predial ?? predio.codigoPredial) ? 0 : 1,
      confidence: CONFIDENCE_LEVELS.ALTA,
      interpretationAllowed: ['Identificador predial único'],
      forbiddenInferences: [],
    }),
    direccion: createSemanticField({
      key: 'direccion',
      sourceTable: 'U_NOMENCLATURA_DOMICILIARIA / catastrox_clean.nomenclatura',
      sourceField: 'TEXTO',
      rawValue: direccion ?? null,
      normalizedValue: isEmptyValue(direccion) ? null : direccion,
      sourceLabel: isEmptyValue(direccion) ? 'Dirección no registrada' : direccion,
      commercialLabel: isEmptyValue(direccion) ? 'Dirección no registrada' : direccion,
      scope: 'predio',
      dataType: 'string',
      coverage: isEmptyValue(direccion) ? 0 : 1,
      confidence: isEmptyValue(direccion) ? CONFIDENCE_LEVELS.MEDIA : CONFIDENCE_LEVELS.ALTA,
      interpretationAllowed: ['Nomenclatura domiciliaria del predio'],
      forbiddenInferences: [],
    }),
  };
}

function buildPhysicalCharacteristicsSection(predio) {
  const areaTerreno = toNumberOrNull(predio.area_terreno_m2 ?? predio.areaM2);
  const areaConstruida = toNumberOrNull(predio.area_construida_m2 ?? predio.areaConstruidaM2);
  return {
    areaTerrenoM2: createSemanticField({
      key: 'areaTerrenoM2',
      sourceTable: 'U_TERRENO / catastrox_clean.predios',
      sourceField: 'AREA_TERRENO (calculada)',
      rawValue: areaTerreno,
      normalizedValue: areaTerreno,
      sourceLabel: areaTerreno === null ? 'No disponible' : `${areaTerreno} m²`,
      commercialLabel: areaTerreno === null ? 'No disponible' : `${areaTerreno} m²`,
      scope: 'predio',
      dataType: 'number',
      coverage: areaTerreno === null ? 0 : 1,
      confidence: areaTerreno === null ? CONFIDENCE_LEVELS.BLOQUEADO : CONFIDENCE_LEVELS.ALTA,
      interpretationAllowed: ['Área de terreno registrada por la fuente catastral'],
      forbiddenInferences: ['Avalúo o valor comercial del predio'],
    }),
    areaConstruidaM2: createSemanticField({
      key: 'areaConstruidaM2',
      sourceTable: 'U_CONSTRUCCION (agregado) / catastrox_clean.predios',
      sourceField: 'area_construida_m2',
      rawValue: areaConstruida,
      normalizedValue: areaConstruida,
      sourceLabel: areaConstruida === null ? 'No disponible' : `${areaConstruida} m²`,
      commercialLabel: areaConstruida === null ? 'No disponible' : `${areaConstruida} m²`,
      scope: 'predio',
      dataType: 'number',
      coverage: areaConstruida === null ? 0 : 1,
      confidence: areaConstruida === null ? CONFIDENCE_LEVELS.BLOQUEADO : CONFIDENCE_LEVELS.MEDIA,
      interpretationAllowed: ['Área construida agregada de los registros constructivos asociados (fuente oficial del predio, no la suma de filas de construcción)'],
      forbiddenInferences: ['Área privada individual', 'Área común de propiedad horizontal'],
      warnings: ['Área oficial del predio; puede diferir de la suma de filas de construcción cuando existe duplicación en la fuente pública.'],
    }),
  };
}

// Fase 3/7 de la correccion: separa evidencia geometrica verificada de agrupacion
// estimada. Nunca mezcla ambos resultados en el mismo campo.
function buildGeometryAnalysisSection(counts) {
  return {
    fingerprintAvailable: counts.geometryFingerprintAvailable,
    distinctGeometryCount: counts.distinctGeometryCount,
    duplicateGeometryRecordCount: counts.duplicateGeometryRecordCount,
    method: counts.geometryFingerprintAvailable
      ? "CASE WHEN geom IS NULL OR GeometryType(geom) NOT IN ('POLYGON','MULTIPOLYGON','GEOMETRYCOLLECTION') OR ST_IsEmpty(ST_CollectionExtract(ST_MakeValid(geom),3)) THEN NULL ELSE md5(ST_AsEWKB(ST_Normalize(ST_SnapToGrid(ST_CollectionExtract(ST_MakeValid(geom),3), 0.001)))) END -- calculado en PostGIS (SRID 9377, metrico, verificado) fuera de la biblioteca; 0.001 = 1 milimetro"
      : null,
  };
}

function buildEstimatedGroupingSection(counts) {
  return {
    used: counts.estimatedGroupingUsed,
    estimatedGroupCount: counts.estimatedGroupCount,
    note: counts.estimatedGroupingUsed
      ? 'La cantidad corresponde a grupos estimados por atributos coincidentes (área y código de identificador) y no a una deduplicación geométrica verificada.'
      : null,
  };
}

function buildConstructionRecordsSection(counts) {
  const rows = [
    { label: 'Total de filas de la fuente', value: String(counts.sourceRecordCount) },
    { label: 'Registros clasificados', value: String(counts.classifiedRecordCount) },
    { label: 'Registros sin clasificación', value: String(counts.unclassifiedRecordCount) },
  ];
  if (counts.geometryFingerprintAvailable) {
    rows.push({ label: 'Geometrías distintas verificadas', value: String(counts.distinctGeometryCount) });
  } else {
    rows.push({ label: 'Grupos estimados por atributos coincidentes', value: String(counts.estimatedGroupCount) });
  }
  rows.push({
    label: 'Suma de área de los registros de la fuente',
    value: `${counts.areaSumFromSourceRecords} m²${counts.areaMayBeInflated ? ' (puede estar inflada)' : ''}`,
  });

  return {
    title: CONSTRUCTION_RECORDS_TITLE,
    rows,
    duplicationDetected: counts.duplicationDetected,
    areaMayBeInflated: counts.areaMayBeInflated,
    warning: counts.warnings.length ? counts.warnings.join(' ') : null,
  };
}

function buildConstructionClassificationSection(classification) {
  const rows = [
    { label: 'Convencionales', value: `${classification.conventional.count} registros` },
    { label: 'No convencionales', value: `${classification.nonConventional.count} registros` },
  ];
  if (classification.unclassified.count > 0) {
    rows.push({ label: 'Sin clasificar', value: `${classification.unclassified.count} registros` });
  }

  return {
    title: CONSTRUCTION_CLASSIFICATION_TITLE,
    rows,
    interpretation: classification.summary,
    warning: CLASSIFICATION_WARNING,
  };
}

/**
 * Construye el esquema semantico completo de un predio urbano. No dibuja nada: devuelve
 * datos estructurados para que una fase futura decida su presentacion.
 *
 * @param {Object} predio - fila normalizada de catastrox_clean.v_predios_enriquecidos.
 * @param {Array} constructionRecords - filas de catastrox_clean.construcciones para ese
 *   predio. Cada fila puede incluir `geometryFingerprint` (calculado en PostGIS fuera de
 *   esta biblioteca) para habilitar deduplicacion geometrica real; si falta en cualquiera
 *   de las filas, se usa agrupacion estimada para el conjunto completo.
 */
export function buildUrbanPdfSchema(predio = {}, constructionRecords = []) {
  const identification = buildIdentificationSection(predio);
  const physicalCharacteristics = buildPhysicalCharacteristicsSection(predio);

  const destinationField = buildDestinationField(predio.destino_economico_nombre ?? predio.destinoEconomicoNombre);
  const useFields = buildConstructionUseFields(predio);
  const useLabels = listConstructionUseLabels(predio);

  const counts = buildConstructionCounts(constructionRecords);
  const classified = classifyConstructionRecords(constructionRecords);
  const classification = interpretConstructionClassification({
    totalAssociatedRecords: counts.sourceRecordCount,
    conventionalCount: classified.conventionalCount,
    nonConventionalCount: classified.nonConventionalCount,
    unclassifiedCount: counts.unclassifiedRecordCount,
    duplicationDetected: counts.duplicationDetected,
  });

  const combined = buildCombinedNarrative({
    destinationLabel: destinationField.pdfEligible ? destinationField.commercialLabel : null,
    useLabels,
    constructionCounts: {
      totalAssociatedRecords: counts.sourceRecordCount,
      conventionalCount: classified.conventionalCount,
      nonConventionalCount: classified.nonConventionalCount,
      unclassifiedCount: counts.unclassifiedRecordCount,
      duplicationDetected: counts.duplicationDetected,
    },
  });

  const allFields = [identification.codigoPredial, identification.direccion, physicalCharacteristics.areaTerrenoM2, physicalCharacteristics.areaConstruidaM2, destinationField, ...useFields];
  const warnings = [...allFields.flatMap((field) => field.warnings || []), ...counts.warnings];

  const pdfEligibility = {
    identification: identification.codigoPredial.pdfEligible && identification.direccion.pdfEligible,
    physicalCharacteristics: physicalCharacteristics.areaTerrenoM2.pdfEligible,
    cadastralDestination: destinationField.pdfEligible,
    constructionUses: useFields.every((field) => field.pdfEligible),
    constructionClassification: isPdfEligible(classification.confidence),
  };

  return {
    semanticVersion: SEMANTIC_VERSION,
    identification,
    physicalCharacteristics,
    cadastralDestination: destinationField,
    constructionUses: useFields,
    sourceRecordCount: counts.sourceRecordCount,
    classifiedRecordCount: counts.classifiedRecordCount,
    constructionRecords: buildConstructionRecordsSection(counts),
    constructionClassification: buildConstructionClassificationSection(classification),
    geometryAnalysis: buildGeometryAnalysisSection(counts),
    estimatedGrouping: buildEstimatedGroupingSection(counts),
    duplicationDetected: counts.duplicationDetected,
    interpretationNarrative: combined.narrative,
    narrative: combined.narrative,
    warnings: [...new Set(warnings)],
    pdfEligibility,
    source: {
      codigoPredial: predio.codigo_predial ?? predio.codigoPredial ?? null,
      fuente: predio.fuente ?? 'No disponible',
      fechaProceso: predio.fecha_proceso ?? predio.fechaProceso ?? 'No disponible',
      zona: predio.zona ?? predio.tipoZona ?? null,
      generadoPor: `urbanPdfSchema ${SEMANTIC_VERSION} (diagnóstico, no integrado al PDF)`,
    },
  };
}

export { isPdfEligible };
