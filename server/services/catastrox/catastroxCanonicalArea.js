// CATX-DELIVERABLE-CANONICAL-001: fuente canónica única de área para un
// predio -- causa raíz del defecto reportado (predio
// 185920003000000080019000000000 mostrando simultáneamente 84,38 ha y
// 866.710,71 m², valores matemáticamente incompatibles: 866710.71/10000 =
// 86.671071 ≈ 86,67 ha, no 84,38 ha).
//
// server/routes/catastrox.js construía `areaM2`/`areaHa` con dos cadenas
// de prioridad DISTINTAS a partir de la misma fila de
// catastrox_clean.predios:
//   areaM2 preferÍa area_m2_exact (ST_Area(geom) en vivo, sobre el
//     polígono actualmente almacenado);
//   areaHa preferÍa area_terreno_ha (atributo catastral estático,
//     importado tal cual del GPKG de origen -- ver
//     docs/catastrox/CATASTROX_CLEAN_IMPORT_CAQUETA.md).
// Cuando el área registrada en el atributo catastral no coincide con el
// área real de la geometría actualmente almacenada (desactualización,
// corrección de linderos posterior a la importación, etc.), las dos
// "fuentes de verdad" divergen -- y como nunca se compara una contra la
// otra, el resultado nunca se detecta ni se corrige antes de mostrarse.
//
// Esta función es la ÚNICA que debe decidir areaM2/areaHa para cualquier
// predio -- diagnóstico, ficha técnica, resumen de compra, PDF y
// cualquier JSON de entrega consumen exactamente el mismo resultado
// (server/routes/catastrox.js la invoca una sola vez por fila, en los dos
// únicos lugares que construyen el objeto `predio`: buildLookupFullResultPayload
// y resolvePredioDataForDelivery). Nunca toca geometría/perímetro -- solo
// decide los dos campos de área.
//
// Precisión: esta función devuelve valores en precisión completa
// (double) -- el redondeo a 2 decimales es responsabilidad exclusiva de
// la capa de presentación (formatNumber/formatNumberEs, ya usadas en
// frontend y PDF), nunca de aquí.

const DEFAULT_TOLERANCE_RATIO = 0.005; // 0.5% de tolerancia relativa por defecto

function isFinitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Requisito 5 del pedido: abs(canonicalAreaHa*10000 - canonicalAreaM2) <=
 * tolerancia. Expuesta aparte (no solo inline en resolveCanonicalArea)
 * para poder probar la regla de consistencia de forma genérica,
 * independiente de qué fuente se haya elegido.
 */
export function checkAreaConsistency(canonicalAreaM2, canonicalAreaHa, toleranceRatio = DEFAULT_TOLERANCE_RATIO) {
  if (!isFinitePositive(canonicalAreaM2) || !isFinitePositive(canonicalAreaHa)) {
    return { consistent: false, diffM2: null, toleranceM2: null };
  }
  const diffM2 = Math.abs(canonicalAreaHa * 10000 - canonicalAreaM2);
  const toleranceM2 = canonicalAreaM2 * toleranceRatio;
  return { consistent: diffM2 <= toleranceM2, diffM2, toleranceM2 };
}

/**
 * Decide la fuente canónica de área para un predio, con las reglas
 * exactas del requisito 5 del pedido:
 *
 * 1. Geometría válida y finita (areaM2Exact, ST_Area(geom) en vivo) ->
 *    se usa como canonicalAreaM2; canonicalAreaHa se DERIVA dividiendo
 *    entre 10000. Nunca se usa areaTerrenoHa como ha cuando hay
 *    geometría válida, aunque exista -- exactamente lo que evita el
 *    defecto reportado.
 * 2. Sin geometría válida: fallback a los atributos catastrales
 *    registrados (areaTerrenoM2/areaTerrenoHa), documentado en `source`.
 *    Si ambos existen y concuerdan dentro de tolerancia, se usan tal
 *    cual. Si ambos existen pero NO concuerdan, se registra un warning
 *    estructurado y se prioriza areaTerrenoM2 (misma unidad base que la
 *    geometría) -- areaTerrenoHa se descarta, nunca se mezclan. Si solo
 *    uno de los dos existe, el otro se DERIVA de ese.
 * 3. Sin ningún dato de área válido: canonicalAreaM2/canonicalAreaHa
 *    quedan en null, source='unavailable'.
 *
 * Nunca devuelve dos valores que no sean matemáticamente equivalentes
 * entre sí (por construcción, uno siempre se deriva del otro).
 */
export function resolveCanonicalArea(input) {
  // `input` puede llegar como `null` explícito (no solo `undefined`) --
  // p. ej. resolveCanonicalArea(null) -- y el valor por defecto de un
  // parámetro desestructurado (`= {}`) NUNCA se activa para `null`, solo
  // para `undefined`. Desestructurar en el cuerpo de la función, sobre
  // `input || {}`, cubre ambos casos sin lanzar.
  const {
    areaM2Exact = null,
    areaTerrenoM2 = null,
    areaTerrenoHa = null,
    toleranceRatio = DEFAULT_TOLERANCE_RATIO,
  } = input || {};
  const warnings = [];

  if (isFinitePositive(areaM2Exact)) {
    const canonicalAreaM2 = areaM2Exact;
    const canonicalAreaHa = canonicalAreaM2 / 10000;

    if (isFinitePositive(areaTerrenoHa)) {
      const { consistent, diffM2, toleranceM2 } = checkAreaConsistency(canonicalAreaM2, areaTerrenoHa, toleranceRatio);
      if (!consistent) {
        warnings.push({
          code: 'AREA_SOURCE_MISMATCH',
          message:
            'El área geométrica en vivo (ST_Area) y el área catastral registrada (area_terreno_ha) no coinciden dentro de la tolerancia -- se usó la geometría como fuente canónica.',
          canonicalAreaM2,
          canonicalAreaHa,
          areaTerrenoHa,
          diffM2,
          toleranceM2,
        });
      }
    }

    return { canonicalAreaM2, canonicalAreaHa, source: 'geometry', warnings };
  }

  if (isFinitePositive(areaTerrenoM2) && isFinitePositive(areaTerrenoHa)) {
    const derivedHaFromM2 = areaTerrenoM2 / 10000;
    const { consistent, diffM2, toleranceM2 } = checkAreaConsistency(areaTerrenoM2, areaTerrenoHa, toleranceRatio);
    if (!consistent) {
      warnings.push({
        code: 'AREA_SOURCE_MISMATCH',
        message:
          'area_terreno_m2 y area_terreno_ha (atributos catastrales registrados) no coinciden dentro de la tolerancia -- se priorizó area_terreno_m2.',
        areaTerrenoM2,
        areaTerrenoHa,
        derivedHaFromM2,
        diffM2,
        toleranceM2,
      });
      return { canonicalAreaM2: areaTerrenoM2, canonicalAreaHa: derivedHaFromM2, source: 'catastral_m2_priority', warnings };
    }
    return { canonicalAreaM2: areaTerrenoM2, canonicalAreaHa: areaTerrenoHa, source: 'catastral_consistent', warnings };
  }

  if (isFinitePositive(areaTerrenoM2)) {
    return { canonicalAreaM2: areaTerrenoM2, canonicalAreaHa: areaTerrenoM2 / 10000, source: 'catastral_m2_only', warnings };
  }

  if (isFinitePositive(areaTerrenoHa)) {
    return { canonicalAreaM2: areaTerrenoHa * 10000, canonicalAreaHa: areaTerrenoHa, source: 'catastral_ha_only', warnings };
  }

  return { canonicalAreaM2: null, canonicalAreaHa: null, source: 'unavailable', warnings };
}

/**
 * Envoltorio de conveniencia para los dos sitios reales de
 * server/routes/catastrox.js -- resuelve el área y registra cualquier
 * warning estructurado (console.warn, mismo patrón `[CatastroX ...]` ya
 * usado en todo este módulo/proyecto) con el código predial para poder
 * ubicar el predio afectado en los logs.
 */
export function resolveCanonicalAreaForRow(row, { codigoPredial = null } = {}) {
  // row.shape_area (solo presente en algunas de las consultas de
  // catastrox.js) es, igual que area_m2_exact, un área derivada de la
  // geometría almacenada -- se acepta como segunda opción "geométrica"
  // antes de caer a los atributos catastrales estáticos, preservando el
  // orden de prioridad que ya tenía buildLookupFullResultPayload para
  // areaM2 antes de esta corrección.
  const areaM2Exact =
    row?.area_m2_exact != null ? Number(row.area_m2_exact) : row?.shape_area != null ? Number(row.shape_area) : null;

  const result = resolveCanonicalArea({
    areaM2Exact,
    areaTerrenoM2: row?.area_terreno_m2 != null ? Number(row.area_terreno_m2) : null,
    areaTerrenoHa: row?.area_terreno_ha != null ? Number(row.area_terreno_ha) : null,
  });

  result.warnings.forEach((warning) => {
    console.warn('[CatastroX Area]', { codigoPredial, timestamp: new Date().toISOString(), ...warning });
  });

  return result;
}
