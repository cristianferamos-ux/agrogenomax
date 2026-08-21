// SPRINT-3D5.2-OPERATIONAL-SPATIAL-TOLERANCE: reemplaza la decisión
// binaria ST_CoveredBy=true/false por tres estados operacionales
// (STRICT_OK/TOLERANCE_OK/OUTSIDE). El polígono catastral del predio es
// referencia territorial; el polígono del potrero es delimitación
// operacional del productor -- no se exige coincidencia subcentimétrica.
//
// REGLA CRÍTICA: la tolerancia solo cambia la DECISIÓN DE ACEPTACIÓN,
// NUNCA la geometría. Este módulo jamás persiste ni devuelve como
// "geometry final" el resultado de ST_Difference/ST_Buffer/ST_Snap --
// esas operaciones se usan EXCLUSIVAMENTE para medir (área fuera,
// distancia fuera). La geometry que ve el candidate/DB sigue siendo
// exactamente ST_GeomFromText(wkt) tal como la aportó el usuario (ver
// potrerosRepository.js).
//
// Separación deliberada en dos grupos de funciones:
//   - decideToleranceStatus()/resolveTolerance()/validateGpsAccuracyList()
//     son PURAS (sin I/O) -- testeables sin Postgres.
//   - computeCoverageMetrics() es la ÚNICA función que habla con
//     PostGIS real -- recibe un `client` ya abierto en transacción
//     (mismo patrón que potrerosRepository.js).

function semanticError(code, status, message) {
  return Object.assign(new Error(message || code), { status, code });
}

export const TOLERANCE_STATUS = Object.freeze({
  STRICT_OK: 'STRICT_OK',
  TOLERANCE_OK: 'TOLERANCE_OK',
  OUTSIDE: 'OUTSIDE',
});

// SPRINT-3D5.2-AJUSTE-FINAL: regla de producto aprobada -- el polígono
// catastral es referencia TERRITORIAL, el potrero es delimitación
// OPERACIONAL. Puede existir una diferencia real pequeña entre catastro,
// AutoCAD, QGIS, RTK, GPS de mano/celular o coordenadas capturadas en
// campo -- NO se exige coincidencia centimétrica. La decisión se basa en
// %fuera Y distancia_máxima_fuera (AND, nunca basta uno solo).
// area_fuera_m2 se sigue calculando y devolviendo como métrica
// informativa/auditable (ver computeCoverageMetrics), pero DEJA de ser un
// hard gate: 0.01 m² contradecía la propia regla de negocio (rechazaba
// diferencias de exportación reales más grandes que un simple redondeo).
// No se agregó una tercera barrera absoluta de área -- %+distancia ya son
// AND, así que un área grande solo pasa si además tiene % y distancia
// pequeños, lo cual ya es información suficiente; si en producción
// aparece un caso patológico que la sortee, se evalúa entonces (ver
// handoff §3).
export const TOLERANCE_KML_KMZ = Object.freeze({
  distanciaMaximaFueraMaxM: 1.0,
  porcentajeFueraMax: 0.25, // %
});

// Coordenadas manuales: margen más amplio que KML/KMZ -- una captura
// manual (teclear lat/lng) tiene más variabilidad esperada que un archivo
// exportado desde una herramienta CAD/GIS, sin llegar al margen de GPS.
export const TOLERANCE_COORDENADAS = Object.freeze({
  distanciaMaximaFueraMaxM: 3.0,
  porcentajeFueraMax: 0.5, // %
});

// §7: máximo de accuracy GPS considerada razonable. Por encima de esto el
// punto se rechaza (recaptura) -- nunca se usa para ampliar tolerancia.
export const GPS_MAX_ACCURACY_M = 100;

// §8: sin accuracy reportada por el dispositivo, NO se inventa un valor.
// Se aplica un margen fijo conservador -- deliberadamente MÁS ESTRICTO que
// el mejor caso alcanzable con accuracy confirmada (ver
// gpsToleranceFromAccuracy): sin evidencia de la calidad de la captura no
// hay base para conceder el mismo margen que a un punto verificado.
// Justificación completa en el handoff 3D5.2 (§GPS accuracy).
export const GPS_FALLBACK_NO_ACCURACY = Object.freeze({
  porcentajeFueraMax: 0.5,
  distanciaMaximaFueraMaxM: 5,
});

// §8: con accuracy confirmada (<= GPS_MAX_ACCURACY_M), el margen escala
// con la precisión reportada -- pero siempre acotado a un máximo absoluto
// de 10 m, nunca "aceptar todo dentro de ±accuracy" sin límite.
export function gpsToleranceFromAccuracy(maxAccuracyM) {
  return Object.freeze({
    porcentajeFueraMax: 1,
    distanciaMaximaFueraMaxM: Math.min(maxAccuracyM, 10),
  });
}

function resolveTolerance(metodoDelimitacion, gpsAccuracyMaxM) {
  if (metodoDelimitacion === 'kml' || metodoDelimitacion === 'kmz') {
    return { kind: 'kml_kmz', ...TOLERANCE_KML_KMZ };
  }
  if (metodoDelimitacion === 'coordenadas') {
    return { kind: 'coordenadas', ...TOLERANCE_COORDENADAS };
  }
  if (metodoDelimitacion === 'gps_movil') {
    const hasAccuracy = typeof gpsAccuracyMaxM === 'number' && Number.isFinite(gpsAccuracyMaxM) && gpsAccuracyMaxM > 0;
    return hasAccuracy
      ? { kind: 'gps_accuracy', ...gpsToleranceFromAccuracy(gpsAccuracyMaxM) }
      : { kind: 'gps_fallback', ...GPS_FALLBACK_NO_ACCURACY };
  }
  // Defensivo: método no reconocido nunca debería llegar aquí (el router
  // valida metodoDelimitacion antes) -- si ocurre, se aplica el umbral más
  // estricto disponible (KML/KMZ) en vez de fallar abierto.
  return { kind: 'unknown_defaults_kml_kmz', ...TOLERANCE_KML_KMZ };
}

/**
 * Decide STRICT_OK/TOLERANCE_OK/OUTSIDE a partir de métricas YA calculadas
 * server-side vía PostGIS real (ver computeCoverageMetrics). Función pura.
 * `areaFueraM2` viaja en el objeto por compatibilidad/auditoría pero NO
 * participa en la decisión (ver comentario de TOLERANCE_KML_KMZ arriba) --
 * la decisión es exclusivamente porcentajeFuera Y distanciaMaximaFueraM.
 */
export function decideToleranceStatus({
  coveredBy,
  areaTotalM2,
  porcentajeFuera,
  distanciaMaximaFueraM,
  metodoDelimitacion,
  gpsAccuracyMaxM = null,
}) {
  if (!(areaTotalM2 > 0)) {
    throw semanticError('INVALID_POTRERO_GEOMETRY', 422, 'El polígono no tiene área (área total <= 0).');
  }

  if (coveredBy) {
    return { status: TOLERANCE_STATUS.STRICT_OK, toleranceApplied: null };
  }

  const tolerance = resolveTolerance(metodoDelimitacion, gpsAccuracyMaxM);
  const withinPorcentaje = porcentajeFuera <= tolerance.porcentajeFueraMax;
  const withinDistancia = distanciaMaximaFueraM <= tolerance.distanciaMaximaFueraMaxM;

  const within = withinPorcentaje && withinDistancia;
  return {
    status: within ? TOLERANCE_STATUS.TOLERANCE_OK : TOLERANCE_STATUS.OUTSIDE,
    toleranceApplied: tolerance,
  };
}

/**
 * §7: valida accuracy opcional por punto GPS (metros,
 * navigator.geolocation.coords.accuracy). Nunca inventa un valor ausente.
 * Devuelve maxAccuracyM=null si NINGÚN punto trae accuracy (caso permitido
 * por compatibilidad -- cae a GPS_FALLBACK_NO_ACCURACY en la decisión).
 * Lanza si algún valor presente es <= 0 o supera GPS_MAX_ACCURACY_M.
 */
export function validateGpsAccuracyList(puntos) {
  const provided = (Array.isArray(puntos) ? puntos : [])
    .map((punto) => punto?.accuracy)
    .filter((value) => value !== undefined && value !== null);

  if (provided.length === 0) {
    return { maxAccuracyM: null };
  }

  for (const raw of provided) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw semanticError('INVALID_GPS_ACCURACY', 400, 'accuracy debe ser un número mayor a 0.');
    }
    if (value > GPS_MAX_ACCURACY_M) {
      throw semanticError(
        'GPS_ACCURACY_TOO_LOW',
        422,
        `La precisión GPS reportada (${Math.round(value)} m) supera el máximo permitido (${GPS_MAX_ACCURACY_M} m). Vuelve a capturar el punto.`,
      );
    }
  }

  return { maxAccuracyM: Math.max(...provided.map(Number)) };
}

// §5: densificación del polígono exterior (ST_Difference) antes de medir
// distancia -- ver justificación completa en computeCoverageMetrics.
const DISTANCE_SEGMENT_LENGTH_M = 0.5;

/**
 * ÚNICA función de este módulo que habla con PostGIS. Recibe un `client`
 * ya abierto en transacción (mismo patrón que potrerosRepository.js) y un
 * `wkt` YA confirmado ST_IsValid=true por el llamador -- nunca se invoca
 * con una geometría sin validar (mismo motivo que el resto del pipeline:
 * operaciones PostGIS sobre geometría inválida pueden lanzar excepción a
 * nivel SQL).
 *
 * §1-3: covered_by decide STRICT_OK server-side. Si es false, se mide
 * -- SOLO para decisión/auditoría, nunca se guarda -- el área
 * verdaderamente exterior (ST_Difference sobre geography) y su
 * porcentaje respecto al área total del potrero.
 *
 * §5: distancia_maxima_fuera_m -- PostGIS no ofrece una función directa
 * para "la distancia máxima de un área exterior al límite del predio"
 * (ST_HausdorffDistance es SIMÉTRICA: tomaría también la distancia desde
 * puntos lejanos del borde del PREDIO hacia el área exterior, dominada
 * por el tamaño del predio, no por la profundidad real de la
 * intrusión/excursión). Aproximación conservadora explícita: se
 * densifica el polígono exterior cada DISTANCE_SEGMENT_LENGTH_M (0.5 m,
 * sobre geography -- unidades reales) con ST_Segmentize, y se toma la
 * distancia mínima de CADA vértice densificado al límite del predio
 * (ST_Distance sobre geography), reportando el MÁXIMO de esas distancias
 * mínimas. Esto aproxima la distancia de Hausdorff DIRIGIDA (área
 * exterior -> límite del predio), con error acotado por el paso de
 * densificación (<= 0.5 m) -- despreciable frente a los umbrales usados
 * en este sprint (el más ajustado es KML/KMZ, <= 1.0 m; el resto de
 * métodos usa márgenes de 3-10 m).
 */
export async function computeCoverageMetrics(client, wkt, predioId, areaTotalM2) {
  if (!(areaTotalM2 > 0)) {
    throw semanticError('INVALID_POTRERO_GEOMETRY', 422, 'El polígono no tiene área (área total <= 0).');
  }

  const coverageResult = await client.query(
    `select
       ST_CoveredBy(g.geom, pr.geometry) as covered_by,
       ST_Area(ST_Difference(g.geom, pr.geometry)::geography) as area_fuera_m2
     from (select ST_GeomFromText($1, 4326) as geom) g, agx.predios pr
     where pr.predio_id = $2`,
    [wkt, predioId],
  );
  const row = coverageResult.rows[0];
  const coveredBy = Boolean(row?.covered_by);

  if (coveredBy) {
    return { coveredBy: true, areaFueraM2: 0, porcentajeFuera: 0, distanciaMaximaFueraM: 0 };
  }

  const areaFueraM2 = Number(row.area_fuera_m2) || 0;
  if (!(areaFueraM2 > 0)) {
    // Borde compartido / diferencia por precisión de punto flotante sin
    // área real -- no hay nada que medir, no hay excursión.
    return { coveredBy: false, areaFueraM2: 0, porcentajeFuera: 0, distanciaMaximaFueraM: 0 };
  }

  const porcentajeFuera = (areaFueraM2 / areaTotalM2) * 100;

  const distanceResult = await client.query(
    `with diff as (
       select ST_Difference(g.geom, pr.geometry) as exterior_geom, pr.geometry as predio_geom
       from (select ST_GeomFromText($1, 4326) as geom) g, agx.predios pr
       where pr.predio_id = $2
     ),
     densified as (
       select (ST_DumpPoints(ST_Segmentize(exterior_geom::geography, $3)::geometry)).geom as pt, predio_geom
       from diff
     )
     select max(ST_Distance(pt::geography, ST_Boundary(predio_geom)::geography)) as distancia_maxima_fuera_m
     from densified`,
    [wkt, predioId, DISTANCE_SEGMENT_LENGTH_M],
  );
  const distanciaMaximaFueraM = Number(distanceResult.rows[0]?.distancia_maxima_fuera_m) || 0;

  return { coveredBy: false, areaFueraM2, porcentajeFuera, distanciaMaximaFueraM };
}
