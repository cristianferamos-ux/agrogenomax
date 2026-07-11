// Reglas de conteo (Fase 3/4 de la corrección). Distingue explicitamente entre
// deduplicacion geometrica REAL (basada en una huella geometrica normalizada calculada
// fuera de esta biblioteca, en PostGIS) y agrupacion ESTIMADA por atributos coincidentes
// (area + identificador) cuando no hay huella disponible. Nunca mezcla ambos resultados.
//
// Contrato de entrada por registro (todos opcionales salvo lo indicado):
//   {
//     tipo_construccion_codigo,
//     identificador,
//     area_construccion_m2,
//     geometryFingerprint,   // huella geometrica normalizada (ver server/sql o script de
//                            // diagnostico); ausente/null si no se calculo.
//   }
import { toNumberOrNull, isEmptyValue } from './urbanNormalizationRules.js';

function buildEstimatedGroupKey(record) {
  const area = toNumberOrNull(record?.area_construccion_m2 ?? record?.areaConstruccionM2);
  const identificador = String(record?.identificador ?? '').trim().toUpperCase();
  const areaKey = area === null ? 'sin_area' : area.toFixed(3);
  return `${identificador}|${areaKey}`;
}

function hasFingerprint(record) {
  const fp = record?.geometryFingerprint;
  return typeof fp === 'string' && fp.trim().length > 0;
}

/**
 * Agrega un conjunto de registros constructivos de un predio siguiendo el contrato de
 * Fase 3. No accede a PostGIS ni a geometria cruda: opera exclusivamente sobre los campos
 * ya presentes en cada registro.
 */
export function buildConstructionCounts(records = []) {
  const sourceRecordCount = records.length;

  let classifiedRecordCount = 0;
  let conventionalRecordCount = 0;
  let nonConventionalRecordCount = 0;

  // "Clasificado" exige coincidir con un valor conocido del dominio (CONVENCIONAL / NO
  // CONVENCIONAL); un codigo no vacio pero desconocido (fuera del dominio verificado) NO
  // cuenta como clasificado, para no inventar significado a codigos sin dominio.
  records.forEach((record) => {
    const codigo = String(record?.tipo_construccion_codigo ?? record?.tipoConstruccionCodigo ?? '').trim().toUpperCase();
    if (codigo === 'CONVENCIONAL') {
      classifiedRecordCount += 1;
      conventionalRecordCount += 1;
    } else if (codigo === 'NO CONVENCIONAL') {
      classifiedRecordCount += 1;
      nonConventionalRecordCount += 1;
    }
  });
  const unclassifiedRecordCount = sourceRecordCount - classifiedRecordCount;

  // Regla 1/2/3 de Fase 2: solo se calcula distinctGeometryCount cuando TODOS los
  // registros traen huella geometrica; si falta en alguno, el conjunto completo cae a
  // agrupacion estimada (no se mezclan registros verificados con estimados).
  const geometryFingerprintAvailable = sourceRecordCount > 0 && records.every(hasFingerprint);

  let distinctGeometryCount = null;
  let duplicateGeometryRecordCount = null;
  let estimatedGroupCount = null;
  let estimatedGroupingUsed = false;

  if (geometryFingerprintAvailable) {
    const fingerprints = new Set(records.map((record) => record.geometryFingerprint.trim()));
    distinctGeometryCount = fingerprints.size;
    duplicateGeometryRecordCount = Math.max(0, sourceRecordCount - distinctGeometryCount);
  } else if (sourceRecordCount > 0) {
    estimatedGroupingUsed = true;
    const groupKeys = new Set(records.map(buildEstimatedGroupKey));
    estimatedGroupCount = groupKeys.size;
  }

  const duplicationDetected = geometryFingerprintAvailable
    ? duplicateGeometryRecordCount > 0
    : (estimatedGroupCount !== null && estimatedGroupCount < sourceRecordCount);

  const areaSumFromSourceRecords = Math.round(
    records.reduce((sum, record) => sum + (toNumberOrNull(record?.area_construccion_m2 ?? record?.areaConstruccionM2) || 0), 0) * 100,
  ) / 100;
  // El area sumada de filas nunca se presenta como area fisica confirmada si hay
  // duplicacion real o estimada (regla 5 de Fase 2).
  const areaMayBeInflated = duplicationDetected;

  const warnings = [];
  if (geometryFingerprintAvailable && duplicationDetected) {
    warnings.push(
      `Se detectaron ${duplicateGeometryRecordCount} registros con huella geométrica duplicada (${distinctGeometryCount} geometrías distintas de ${sourceRecordCount} registros de la fuente).`,
    );
  } else if (estimatedGroupingUsed) {
    warnings.push(
      'La cantidad corresponde a grupos estimados por atributos coincidentes (área y código de identificador) y no a una deduplicación geométrica verificada.',
    );
  }
  if (unclassifiedRecordCount > 0) {
    warnings.push('Existen registros constructivos sin clasificación disponible en la fuente catastral.');
  }
  if (areaMayBeInflated) {
    warnings.push('El área sumada de los registros de la fuente puede estar inflada por duplicación y no debe presentarse como área construida física confirmada.');
  }

  return {
    sourceRecordCount,
    classifiedRecordCount,
    unclassifiedRecordCount,
    conventionalRecordCount,
    nonConventionalRecordCount,

    geometryFingerprintAvailable,
    distinctGeometryCount,
    duplicateGeometryRecordCount,

    estimatedGroupCount,
    estimatedGroupingUsed,

    duplicationDetected,
    areaSumFromSourceRecords,
    areaMayBeInflated,
    warnings,
  };
}

// Cuenta filas por codigo de dominio (p.ej. CONVENCIONAL / NO CONVENCIONAL), preservando
// codigos desconocidos en vez de descartarlos silenciosamente.
export function countByCode(records = [], codeField = 'tipo_construccion_codigo') {
  const counts = new Map();
  records.forEach((record) => {
    const raw = record?.[codeField];
    const key = isEmptyValue(raw) ? null : String(raw).trim().toUpperCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
}
