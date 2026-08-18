// SPRINT-3C1-MIS-PREDIOS-API §5: motor interno de búsqueda predial,
// reutilizado por "Mis Predios" (integración servidor-a-servidor, nunca
// HTTP) sin duplicar ninguna consulta SQL ni regla de ambigüedad ya
// auditada en server/routes/catastrox.js. Este módulo NO define SQL
// propio -- importa y orquesta exclusivamente funciones ya exportadas de
// catastrox.js:
//   - findCleanPredioCandidatesByPoint / isAmbiguousPointMatch (punto)
//   - validateCadastralCodeInput / findPredioByCadastralCode (código)
//   - resolvePredioDataForDelivery (hidratación completa + geometry, ya
//     usada en producción para reconstruir un predio SOLO desde su
//     codigo_predial de 30 dígitos, exactamente el caso que necesitamos
//     aquí para ambas búsquedas)
// El contrato público de CatastroX (/api/catastrox/lookup,
// /lookup-by-code, full-result, paywall) no se toca -- cero cambios de
// comportamiento visible en esas rutas.
//
// SPRINT-3C1.1 §6 (dirección de dependencia -- DEUDA DOCUMENTADA, NO
// resuelta en este sprint): lo correcto arquitectónicamente es que este
// archivo importe de un servicio compartido bajo server/services/catastrox/
// (p.ej. catastroxPredioQueryService.js), y que server/routes/catastrox.js
// importe DE ESE MISMO servicio en vez de definir las funciones inline --
// nunca Ganadería -> router de CatastroX. Se auditó la viabilidad de
// extraer AHORA MISMO findCleanPredioCandidatesByPoint/isAmbiguousPointMatch/
// validateCadastralCodeInput/findPredioByCadastralCode/resolvePredioDataForDelivery
// (las 5 funciones que este módulo necesita) y se decidió NO hacerlo en
// este sprint, por lo siguiente:
//
// Esas 5 funciones dependen de un conjunto de ~10 helpers/constantes
// PRIVADOS de catastrox.js (toNullableString, toNullableNumber,
// canonicalText, getVeredaDisplay, hasValidRing, isValidPredioGeometry,
// buildQueryPoint, isUndefinedRelationError, queryOptional,
// CATASTROX_ORIGEN_NACIONAL_PROJ) que NO son exclusivos de este cluster --
// se usan en TODO el archivo (auditado por grep, 2026-08-18):
// toNullableString 77 veces, canonicalText 24, CATASTROX_ORIGEN_NACIONAL_PROJ
// 14, isUndefinedRelationError/queryOptional 10, toNullableNumber 9,
// getVeredaDisplay 4 -- incluidos el handler público `POST /lookup` y
// `buildLookupFullResultPayload`, que NO se moverían. Una extracción real
// exige mover también esos helpers compartidos (o duplicarlos, lo cual sí
// sería la duplicación que este sprint explícitamente prohíbe) y
// re-verificar ~140 sitios de uso repartidos en un archivo de 2539 líneas
// que sirve pagos reales de Wompi, generación de PDF y el flujo comercial
// completo de CatastroX -- alto riesgo de regresión para un cambio
// puramente estructural, sin beneficio de comportamiento nuevo.
//
// Plan concreto para una futura extracción dedicada (sprint propio, con
// su propia pasada de regresión completa como único objetivo):
//   1. Crear server/services/catastrox/catastroxPredioQueryService.js.
//   2. Mover ahí, verbatim: los 10 helpers/constantes privados listados
//      arriba + las 5 funciones públicas de este cluster + sus
//      dependientes exportados también usados por catastrox.js
//      (buildLookupByCodeQuery, resolveLookupByCodeCandidates,
//      normalizeCadastralCodeInput, resolveCanonicalPredioId,
//      buildCandidateGeometrySignature).
//   3. catastrox.js importa todo lo anterior desde ese servicio y
//      re-exporta lo que ya exportaba (para no romper
//      catastroxPayments.js, deliveryJobService.js, y los imports directos
//      de los tests catastroxLookupByPoint/ByCode/CanonicalPredio).
//   4. Este archivo (catastroxPredioLookup.js) pasa a importar del nuevo
//      servicio, no de catastrox.js.
//   5. Correr el suite completo de CatastroX (todos los
//      server/routes/__tests__/catastrox*.test.js) como gate de
//      aceptación, sin excepción.
// Hasta que ese sprint ocurra, esta dirección de dependencia
// (Ganadería -> router de CatastroX) es deuda técnica aceptada
// explícitamente, no un descuido.
import {
  findCleanPredioCandidatesByPoint,
  isAmbiguousPointMatch,
  validateCadastralCodeInput,
  findPredioByCadastralCode,
  resolvePredioDataForDelivery,
} from '../routes/catastrox.js';

// SPRINT-3C2.5 §5 (decisión aprobada): CATASTROX_DATASET_VERSION es la
// versión del PIPELINE/dataset propio de CatastroX (usada por
// resolveCanonicalPredioId en catastrox.js para IDs de respaldo) -- NUNCA
// la versión real de la fuente oficial (IGAC). Este módulo YA NO la usa
// para `versionFuente` (ver buildNormalizedPredio) -- no se borra de
// catastrox.js porque ese archivo sí la necesita para sus propios IDs
// internos; simplemente no se importa/duplica aquí, donde no aplica.

/**
 * Centroide aproximado de una geometry GeoJSON (Polygon/MultiPolygon) --
 * promedio simple de los vértices del anillo exterior de cada polígono.
 * Suficiente para mostrar un punto de referencia en un mapa ("Mis
 * Predios" no hace cálculos legales/financieros con este valor) -- NO es
 * un centroide geométrico exacto (no pondera por área). Nunca se envía
 * al cliente como fuente de verdad de ubicación catastral -- esa es
 * `geometry`.
 */
export function computeApproximateCentroid(geometry) {
  const geo = typeof geometry === 'string' ? JSON.parse(geometry) : geometry;
  if (!geo || !Array.isArray(geo.coordinates)) return null;

  const rings = geo.type === 'Polygon' ? [geo.coordinates[0]] : geo.type === 'MultiPolygon' ? geo.coordinates.map((polygon) => polygon?.[0]) : [];

  let sumLng = 0;
  let sumLat = 0;
  let count = 0;
  for (const ring of rings) {
    if (!Array.isArray(ring)) continue;
    for (const point of ring) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const [lng, lat] = point;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      sumLng += lng;
      sumLat += lat;
      count += 1;
    }
  }

  if (count === 0) return null;
  return { lat: sumLat / count, lng: sumLng / count };
}

function normalizeGeometry(geometry) {
  const geo = typeof geometry === 'string' ? JSON.parse(geometry) : geometry;
  if (!geo || !geo.type || !Array.isArray(geo.coordinates)) return null;
  return { type: geo.type, coordinates: geo.coordinates };
}

// SPRINT-3C2.5 §2/§3: getVeredaDisplay() de catastrox.js devuelve un
// objeto de PRESENTACIÓN (label/value/isCadastralCode/...), nunca un
// string -- diseñado para la UI de CatastroX, no para persistirse. NO se
// toca getVeredaDisplay() en catastrox.js -- este helper es exclusivo del
// DTO de Ganadería.
//
// getVeredaDisplay() tiene 3 ramas, no 2 -- las dos primeras comparten
// `isCadastralCode: false`, así que ese flag por sí solo NO basta para
// distinguir "nombre humano real" de "sin dato" (bug real encontrado en
// la primera versión de este helper, atrapado por
// catastroxPredioLookup.test.js):
//   1. Sin vereda_nombre en absoluto ->
//        { value: 'Información no disponible', isCadastralCode: false }
//   2. vereda_nombre es un código técnico (TECHNICAL_VEREDA_PATTERN) ->
//        { value: 'Información no disponible', isCadastralCode: true, secondaryValue, note }
//   3. vereda_nombre es un nombre humano real ->
//        { value: <nombre real>, isCadastralCode: false }
// Regla aprobada: solo la rama 3 produce un dato real que se conserva.
// Las ramas 1 y 2 -> null explícito (nunca el objeto crudo, que
// terminaría serializado como JSON.stringify por el driver `pg`; nunca
// tampoco el texto placeholder "Información no disponible", que es copy
// de UI, no un dato real).
const VEREDA_PLACEHOLDER_VALUE = 'Información no disponible';

function extractVeredaValue(veredaDisplay) {
  if (!veredaDisplay) return null;
  if (veredaDisplay.isCadastralCode) return null;
  if (veredaDisplay.value === VEREDA_PLACEHOLDER_VALUE) return null;
  return veredaDisplay.value ?? null;
}

// SPRINT-3C2.6 §7: cuando getVeredaDisplay() cae en la rama de código
// técnico, conserva el código crudo en `secondaryValue` -- se preserva
// aquí SOLO para trazabilidad interna (atributos_json del snapshot, ver
// prediosRepository.js), nunca como el campo descriptivo `vereda`.
function extractVeredaCodigoTecnico(veredaDisplay) {
  if (!veredaDisplay || !veredaDisplay.isCadastralCode) return null;
  return veredaDisplay.secondaryValue ?? null;
}

/**
 * Contrato normalizado compartido por ambas búsquedas (§8 del pedido,
 * SPRINT-3C2.5 §8: areaCatastralHa/areaCatastralM2, nunca areaHa/areaM2
 * -- esta API todavía no tiene consumidor productivo, es el momento de
 * corregir el nombre antes de que alguien dependa de él).
 * `delivery` es el resultado de resolvePredioDataForDelivery (ya
 * hidratado con geometry vía ST_AsGeoJSON, ya validado no-null).
 */
function buildNormalizedPredio(delivery) {
  const geometry = normalizeGeometry(delivery.geometry);
  if (!geometry) return null;

  return {
    codigoPredial: delivery.codigoPredial,
    codigoAnterior: delivery.codigoAnterior === 'No disponible' ? null : delivery.codigoAnterior,
    nombrePredio: delivery.nombrePredio,
    departamento: delivery.departamento,
    municipio: delivery.municipio,
    vereda: extractVeredaValue(delivery.veredaDisplay),
    // SPRINT-3C2.6 §2 (corrige la decisión anterior de 3C2.5 §4): a
    // diferencia de codigoPredial/codigoAnterior, `sector` NO es un
    // identificador -- Ganadería lo presenta como campo descriptivo, y
    // toda la base de datos (grep exhaustivo sobre catastrox.js) solo
    // expone `sector_codigo`, nunca un `sector_nombre` humano. Sin una
    // fuente real de nombre, el campo descriptivo `sector` es SIEMPRE
    // null -- nunca el código técnico disfrazado de nombre.
    sector: null,
    // Código técnico crudo, preservado SOLO para trazabilidad interna
    // (atributos_json del snapshot) -- nunca expuesto como `sector`, y
    // nunca reenviado al cliente (ver serializePredioSearchResult en
    // ganaderiaPredios.js, que excluye explícitamente este campo de la
    // respuesta pública de búsqueda).
    sectorCodigoTecnico: delivery.sectorCodigo,
    veredaCodigoTecnico: extractVeredaCodigoTecnico(delivery.veredaDisplay),
    areaCatastralM2: delivery.areaM2,
    areaCatastralHa: delivery.areaHa,
    centroide: computeApproximateCentroid(geometry),
    geometry,
    fuente: delivery.fuente,
    // §5 (decisión aprobada): CATASTROX_DATASET_VERSION NO es la versión
    // real de la fuente (IGAC) -- nunca inferir una fecha del nombre de
    // `fuente` tampoco. Sin un campo real de versión por registro, el
    // valor honesto es null, no un dato inventado o no relacionado.
    versionFuente: null,
    fechaConsulta: new Date().toISOString(),
  };
}

/**
 * Búsqueda por coordenadas (§6). Devuelve un `outcome` semántico -- nunca
 * lanza para "no encontrado"/"ambiguo" (§19/§20), solo para errores reales
 * de infraestructura (propagados al llamador).
 */
export async function lookupPredioPorCoordenadas(lat, lng, queryImpl = undefined) {
  const candidates = await (queryImpl
    ? findCleanPredioCandidatesByPoint(lng, lat, queryImpl)
    : findCleanPredioCandidatesByPoint(lng, lat));

  if (!candidates.length) {
    return { outcome: 'not_found' };
  }

  if (candidates.length > 1 && isAmbiguousPointMatch(candidates[0], candidates[1])) {
    return { outcome: 'ambiguous', reason: 'REQUIRES_TECHNICAL_VALIDATION' };
  }

  const topCandidate = candidates[0];
  const codigoPredial = String(topCandidate?.codigo_predial || '').trim();
  if (!/^\d{30}$/.test(codigoPredial)) {
    // Candidato sin código predial de 30 dígitos utilizable -- no se
    // inventa identidad de respaldo aquí (a diferencia de CatastroX
    // público, que sí puede mostrar un preview parcial): "Mis Predios"
    // solo persiste predios con identidad catastral estable y
    // re-consultable.
    return { outcome: 'not_found' };
  }

  const delivery = await (queryImpl
    ? resolvePredioDataForDelivery(codigoPredial, queryImpl)
    : resolvePredioDataForDelivery(codigoPredial));
  if (!delivery) {
    return { outcome: 'not_found' };
  }

  const predio = buildNormalizedPredio(delivery);
  if (!predio) {
    return { outcome: 'not_found' };
  }

  return { outcome: 'resolved', predio };
}

/**
 * Búsqueda por código predial (§7). Acepta 20 o 30 dígitos (código
 * anterior o código vigente) -- misma validación ya auditada
 * (validateCadastralCodeInput). Lanza el mismo error público
 * (`publicCode: 'INVALID_CADASTRAL_CODE'`) que CatastroX si el formato no
 * es válido, para que el router lo traduzca exactamente igual.
 */
export async function lookupPredioPorCodigo(codigoInput, queryImpl = undefined) {
  const normalizedCode = validateCadastralCodeInput(codigoInput);
  const result = await (queryImpl
    ? findPredioByCadastralCode(normalizedCode, queryImpl)
    : findPredioByCadastralCode(normalizedCode));

  if (result.outcome === 'not_found') {
    return { outcome: 'not_found' };
  }

  if (result.outcome !== 'resolved') {
    return { outcome: 'ambiguous', reason: 'REQUIRES_TECHNICAL_VALIDATION' };
  }

  const canonicalCode = result.candidate.codigoPredial;
  if (!/^\d{30}$/.test(String(canonicalCode || ''))) {
    return { outcome: 'not_found' };
  }

  const delivery = await (queryImpl
    ? resolvePredioDataForDelivery(canonicalCode, queryImpl)
    : resolvePredioDataForDelivery(canonicalCode));
  if (!delivery) {
    return { outcome: 'not_found' };
  }

  const predio = buildNormalizedPredio(delivery);
  if (!predio) {
    return { outcome: 'not_found' };
  }

  return { outcome: 'resolved', predio };
}
