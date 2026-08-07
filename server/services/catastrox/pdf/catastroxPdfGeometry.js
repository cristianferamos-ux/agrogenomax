// CATX-DELIVERY-001-HOTFIX-RAILWAY: copia server-side, autosuficiente dentro de
// server/, del motor geométrico puro usado por el generador de PDF. Railway
// instala/ejecuta solo server/ (npm ci --prefix server / npm --prefix server
// start) -- el runtime real NUNCA garantiza que src/ exista, así que este
// código NO puede importarse en tiempo de ejecución desde src/.
//
// Copiado (no reescrito) de:
//   src/modules/catastrox/utils/GeometryCore.js
//   src/modules/catastrox/utils/CartographicPresentationEngine.js
//   src/modules/catastrox/utils/DistanceEngine.js
//   src/modules/catastrox/utils/ProjectionEngine.js (subconjunto realmente usado)
//   src/modules/catastrox/utils/VisibleReferencePointEngine.js
// Extracción por cierre de dependencias (AST, acorn) sobre las funciones que
// catastroxPdfLayout.js realmente invoca -- ningún archivo original fue
// modificado; el frontend (navegador) sigue usando esas rutas sin cambios.
// Verificado libre de document/window/canvas/toBlob/Image/import.meta.
//
// server/__tests__/architecture/noSrcImports.test.js falla el build si algún
// archivo bajo server/ vuelve a importar desde src/ -- mantener esta copia
// sincronizada manualmente si la lógica geométrica cambia en src/.

// --- origen: src/modules/catastrox/utils/GeometryCore.js ---
export function normalizeRing(ring) {
  const nextRing = [...ring];
  if (!nextRing.length) return nextRing;
  const first = nextRing[0];
  const last = nextRing[nextRing.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    nextRing.push(first);
  }
  return nextRing;
}

export function getRingBounds(ring) {
  const lons = ring.map((point) => point[0]);
  const lats = ring.map((point) => point[1]);
  return {
    minLng: Math.min(...lons),
    maxLng: Math.max(...lons),
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
  };
}

export function getPointBounds(points) {
  if (!points.length) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function ringCentroid(points) {
  if (!points.length) return [0, 0];
  const sum = points.reduce((acc, point) => [acc[0] + point[0], acc[1] + point[1]], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

export function projectRingToLocalMeters(openRing) {
  const [, centerLat] = ringCentroid(openRing);
  const latFactor = 110574;
  const lngFactor = 111320 * Math.cos((centerLat * Math.PI) / 180);
  return openRing.map(([lng, lat]) => [lng * lngFactor, lat * latFactor]);
}

export function turnDegrees(prev, current, next) {
  const ax = current[0] - prev[0];
  const ay = current[1] - prev[1];
  const bx = next[0] - current[0];
  const by = next[1] - current[1];
  const magA = Math.hypot(ax, ay) || 1;
  const magB = Math.hypot(bx, by) || 1;
  const dot = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (magA * magB)));
  return (Math.PI - Math.acos(dot)) * (180 / Math.PI);
}

export function perpendicularDistanceMeters(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy) || 1;
  return Math.abs(dy * point[0] - dx * point[1] + end[0] * start[1] - end[1] * start[0]) / length;
}

export function haversineMeters(a, b) {
  const [lng1, lat1] = a.map((value) => (value * Math.PI) / 180);
  const [lng2, lat2] = b.map((value) => (value * Math.PI) / 180);
  const dLng = lng2 - lng1;
  const dLat = lat2 - lat1;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function cumulativeDistances(openRing) {
  const cumulative = [0];
  for (let index = 1; index < openRing.length; index += 1) {
    cumulative[index] = cumulative[index - 1] + haversineMeters(openRing[index - 1], openRing[index]);
  }
  return cumulative;
}

export function ringDistanceForward(cumulative, openRing, startIndex, endIndex) {
  if (endIndex >= startIndex) {
    return cumulative[endIndex] - cumulative[startIndex];
  }
  const total = cumulative[cumulative.length - 1] + haversineMeters(openRing[openRing.length - 1], openRing[0]);
  return total - (cumulative[startIndex] - cumulative[endIndex]);
}

export function simplifyRingIndices(points, tolerance) {
  if (points.length <= 2) return new Set(points.map((_, index) => index));
  const selected = new Set([0, points.length - 1]);

  const walk = (startIndex, endIndex) => {
    let maxDistance = -1;
    let bestIndex = -1;
    const start = points[startIndex];
    const end = points[endIndex];
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distance = perpendicularDistanceMeters(points[index], start, end);
      if (distance > maxDistance) {
        maxDistance = distance;
        bestIndex = index;
      }
    }
    if (bestIndex !== -1 && maxDistance >= tolerance) {
      selected.add(bestIndex);
      walk(startIndex, bestIndex);
      walk(bestIndex, endIndex);
    }
  };

  walk(0, points.length - 1);
  return selected;
}

// --- origen: src/modules/catastrox/utils/CartographicPresentationEngine.js ---
function pushUniqueReason(target, reason) {
  if (!reason) return;
  if (!target.includes(reason)) target.push(reason);
}

function registerDisplayVertex(keptVertices, index, point, reason, bucket = 'other') {
  if (!keptVertices.has(index)) {
    keptVertices.set(index, {
      point,
      originalIndex: index,
      reasons: [],
      keepType: bucket,
    });
  }
  const entry = keptVertices.get(index);
  pushUniqueReason(entry.reasons, reason);
  if (entry.keepType === 'other' || bucket === 'corner' || bucket === 'extreme') {
    entry.keepType = bucket;
  } else if (entry.keepType === 'curve' && bucket === 'line') {
    entry.keepType = 'curve';
  } else if (bucket !== 'other') {
    entry.keepType = bucket;
  }
}

function sanitizeOpenRingForDisplay(openRing, options = {}) {
  if (openRing.length <= 2) {
    return openRing.map((point, index) => ({ point, originalIndex: index }));
  }

  const localRing = projectRingToLocalMeters(openRing);
  const localBounds = getPointBounds(localRing);
  const diagonalMeters = Math.hypot(localBounds.width, localBounds.height) || 1;
  const duplicateThresholdMeters = options.displayDuplicateThresholdMeters ?? Math.max(diagonalMeters * 0.0007, 0.12);
  const sanitized = [{ point: openRing[0], originalIndex: 0 }];

  for (let index = 1; index < openRing.length; index += 1) {
    const current = localRing[index];
    const previousKept = localRing[sanitized[sanitized.length - 1].originalIndex];
    const distance = Math.hypot(current[0] - previousKept[0], current[1] - previousKept[1]);
    if (distance < duplicateThresholdMeters) continue;
    sanitized.push({ point: openRing[index], originalIndex: index });
  }

  if (sanitized.length >= 3) {
    const first = localRing[sanitized[0].originalIndex];
    const last = localRing[sanitized[sanitized.length - 1].originalIndex];
    const closureDistance = Math.hypot(first[0] - last[0], first[1] - last[1]);
    if (closureDistance < duplicateThresholdMeters) {
      sanitized.pop();
    }
  }

  return sanitized;
}

export function buildDisplayRingFromOriginalRing(originalRing, options = {}) {
  const normalizedRing = normalizeRing(originalRing);
  const openRing = normalizedRing.slice(0, -1);
  if (!openRing.length) {
    return {
      displayRing: [],
      displayVertices: [],
      report: {
        totalOriginalVertices: 0,
        totalDisplayVertices: 0,
        removedByCollinearity: 0,
        keptByCornerBreak: 0,
        keptByCurve: 0,
        reductionPercent: 0,
      },
    };
  }

  const sanitizedVertices = sanitizeOpenRingForDisplay(openRing, options);
  const sanitizedOpenRing = sanitizedVertices.map((entry) => entry.point);

  if (sanitizedOpenRing.length <= 4) {
    const displayVertices = sanitizedVertices.map((entry) => ({
      point: entry.point,
      originalIndex: entry.originalIndex,
      reasons: ['geometria_minima'],
      reason: 'geometria_minima',
      keepType: 'corner',
      structuralBreak: true,
    }));
    return {
      displayRing: normalizeRing(displayVertices.map((entry) => entry.point)),
      displayVertices,
      report: {
        totalOriginalVertices: openRing.length,
        totalDisplayVertices: displayVertices.length,
        removedByCollinearity: Math.max(openRing.length - displayVertices.length, 0),
        keptByCornerBreak: displayVertices.length,
        keptByCurve: 0,
        reductionPercent: openRing.length > 0
          ? Number((((openRing.length - displayVertices.length) / openRing.length) * 100).toFixed(2))
          : 0,
      },
    };
  }

  const localRing = projectRingToLocalMeters(sanitizedOpenRing);
  const bounds = getRingBounds(sanitizedOpenRing);
  const localBounds = getPointBounds(localRing);
  const diagonalMeters = Math.hypot(localBounds.width, localBounds.height) || 1;
  const coarseTolerance = options.displayCoarseToleranceMeters ?? Math.max(diagonalMeters * 0.016, 0.7);
  const mediumTolerance = options.displayMediumToleranceMeters ?? Math.max(diagonalMeters * 0.009, 0.35);
  const subtleTolerance = options.displaySubtleToleranceMeters ?? Math.max(diagonalMeters * 0.0045, 0.18);
  const collinearDeviationMeters = options.displayCollinearDeviationMeters ?? Math.max(diagonalMeters * 0.0025, 0.08);
  const strongBreakDeg = options.displayStrongBreakDeg ?? 18;
  const moderateBreakDeg = options.displayModerateBreakDeg ?? 8;
  const gentleCurveDeg = options.displayGentleCurveDeg ?? 4;
  const coarseSimplified = simplifyRingIndices(localRing, coarseTolerance);
  const mediumSimplified = simplifyRingIndices(localRing, mediumTolerance);
  const subtleSimplified = simplifyRingIndices(localRing, subtleTolerance);
  const keptVertices = new Map();

  registerDisplayVertex(
    keptVertices,
    sanitizedVertices[0].originalIndex,
    sanitizedVertices[0].point,
    'inicio_poligono',
    'corner',
  );

  const extremeSelectors = [
    { label: 'extremo_oeste', value: bounds.minLng, axis: 0 },
    { label: 'extremo_este', value: bounds.maxLng, axis: 0 },
    { label: 'extremo_sur', value: bounds.minLat, axis: 1 },
    { label: 'extremo_norte', value: bounds.maxLat, axis: 1 },
  ];

  extremeSelectors.forEach(({ label, value, axis }) => {
    let bestIndex = 0;
    let bestDelta = Number.POSITIVE_INFINITY;
    sanitizedVertices.forEach((entry, index) => {
      const point = entry.point;
      const delta = Math.abs(point[axis] - value);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = index;
      }
    });
    registerDisplayVertex(
      keptVertices,
      sanitizedVertices[bestIndex].originalIndex,
      sanitizedVertices[bestIndex].point,
      label,
      'extreme',
    );
  });

  for (let index = 0; index < sanitizedOpenRing.length; index += 1) {
    const prevIndex = (index - 1 + sanitizedOpenRing.length) % sanitizedOpenRing.length;
    const nextIndex = (index + 1) % sanitizedOpenRing.length;
    const prev = localRing[prevIndex];
    const current = localRing[index];
    const next = localRing[nextIndex];
    const point = sanitizedOpenRing[index];
    const originalIndex = sanitizedVertices[index].originalIndex;
    const turnDeg = turnDegrees(prev, current, next);
    const changeDeg = Math.abs(180 - turnDeg);
    const deviation = perpendicularDistanceMeters(current, prev, next);
    const prevLen = Math.hypot(current[0] - prev[0], current[1] - prev[1]);
    const nextLen = Math.hypot(next[0] - current[0], next[1] - current[1]);
    const localScale = prevLen + nextLen;
    const coarseKept = coarseSimplified.has(index);
    const mediumKept = mediumSimplified.has(index);
    const subtleKept = subtleSimplified.has(index);
    const strongBreak =
      changeDeg >= strongBreakDeg ||
      (changeDeg >= moderateBreakDeg && deviation >= mediumTolerance) ||
      (changeDeg >= moderateBreakDeg && localScale >= diagonalMeters * 0.04);
    const curveRepresentative =
      !strongBreak &&
      (
        (coarseKept && deviation >= mediumTolerance * 0.9) ||
        (mediumKept && deviation >= subtleTolerance * 0.9) ||
        (subtleKept && changeDeg >= gentleCurveDeg && deviation >= collinearDeviationMeters * 1.4)
      );

    if (strongBreak) {
      registerDisplayVertex(keptVertices, originalIndex, point, 'quiebre_direccion', 'corner');
      if (localScale >= diagonalMeters * 0.035) {
        registerDisplayVertex(keptVertices, originalIndex, point, 'sostiene_silueta', 'corner');
      }
      continue;
    }

    if (curveRepresentative) {
      const curveReason =
        coarseKept ? 'curva_representativa' :
        mediumKept ? 'transicion_suave' :
        'silueta_representativa';
      registerDisplayVertex(keptVertices, originalIndex, point, curveReason, 'curve');
    }
  }

  const displayVertices = [...keptVertices.values()]
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .map((entry) => ({
      ...entry,
      reason: entry.reasons[0] || 'preservacion_de_forma',
      structuralBreak: entry.keepType === 'corner' || entry.keepType === 'extreme',
    }));

  const displayRing = normalizeRing(displayVertices.map((entry) => entry.point));
  const removedByCollinearity = Math.max(openRing.length - displayVertices.length, 0);
  const keptByCornerBreak = displayVertices.filter((entry) => entry.keepType === 'corner' || entry.keepType === 'extreme').length;
  const keptByCurve = displayVertices.filter((entry) => entry.keepType === 'curve').length;
  const reductionPercent = openRing.length > 0
    ? Number((((openRing.length - displayVertices.length) / openRing.length) * 100).toFixed(2))
    : 0;

  return {
    displayRing,
    displayVertices,
    report: {
      totalOriginalVertices: openRing.length,
      totalDisplayVertices: displayVertices.length,
      removedByCollinearity,
      keptByCornerBreak,
      keptByCurve,
      reductionPercent,
    },
  };
}

// --- origen: src/modules/catastrox/utils/DistanceEngine.js ---
export function buildReferenceSegments(fullRing, referencePoints) {
  const openRing = fullRing.slice(0, -1);
  const indices = referencePoints.map((entry) => {
    const currentPoint = entry.point || entry;
    return typeof entry.originalIndex === 'number'
      ? entry.originalIndex
      : openRing.findIndex((item) => item[0] === currentPoint[0] && item[1] === currentPoint[1]);
  });

  return referencePoints.map((point, index) => {
    const nextIndex = (index + 1) % referencePoints.length;
    const startIdx = indices[index];
    const endIdx = indices[nextIndex];
    let distance = 0;
    let cursor = startIdx;
    while (cursor !== endIdx) {
      const nextCursor = (cursor + 1) % openRing.length;
      distance += haversineMeters(openRing[cursor], openRing[nextCursor]);
      cursor = nextCursor;
    }
    return {
      from: `P${index + 1}`,
      to: `P${nextIndex + 1}`,
      distance,
    };
  });
}

export function buildReferenceRows(referencePoints) {
  return referencePoints.map((entry, index) => {
    const [lng, lat] = entry.point || entry;
    return {
      point: `P${index + 1}`,
      lat: lat.toFixed(6),
      lng: lng.toFixed(6),
    };
  });
}

// --- origen: src/modules/catastrox/utils/ProjectionEngine.js (subconjunto) ---
const TILE_SIZE = 256;

function lngToWorldX(lng) {
  return ((lng + 180) / 360) * TILE_SIZE;
}

function latToWorldY(lat) {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * TILE_SIZE;
}

export function computeMapState(ring, viewportWidth, viewportHeight, padding = 28) {
  const bounds = getRingBounds(ring);
  const minWorldX = lngToWorldX(bounds.minLng);
  const maxWorldX = lngToWorldX(bounds.maxLng);
  const minWorldY = latToWorldY(bounds.maxLat);
  const maxWorldY = latToWorldY(bounds.minLat);
  const spanX = Math.max(maxWorldX - minWorldX, 1e-6);
  const spanY = Math.max(maxWorldY - minWorldY, 1e-6);
  const usableWidth = Math.max(64, viewportWidth - padding * 2);
  const usableHeight = Math.max(64, viewportHeight - padding * 2);
  const zoom = Math.max(12, Math.min(18, Math.floor(Math.log2(Math.min(usableWidth / spanX, usableHeight / spanY)))));
  const scale = 2 ** zoom;
  const centerLng = (bounds.minLng + bounds.maxLng) / 2;
  const centerLat = (bounds.minLat + bounds.maxLat) / 2;

  return {
    zoom,
    scale,
    centerLng,
    centerLat,
    centerWorldX: lngToWorldX(centerLng),
    centerWorldY: latToWorldY(centerLat),
    viewportWidth,
    viewportHeight,
  };
}

// Fit-to-frame dinámico para el PLANO GEOMÉTRICO INFORMATIVO (páginas de
// plano vectorial del PDF -- dibujo puro de contorno/vértices/cotas, SIN
// teselas satelitales). Defecto corregido: catastroxPdfGenerator.js
// reutilizaba computeMapState (arriba) también para esta página, heredando
// una restricción que solo tiene sentido para teselas Web Mercator (zoom
// ENTERO, porque las teselas de Esri únicamente existen en niveles de zoom
// discretos, y un tope duro en 18 porque esas teselas dejan de existir de
// forma confiable más allá -- ver comentario de zoom en
// CatastroXMockMap.jsx). El dibujo vectorial no tiene ninguna de esas dos
// limitaciones -- la escala puede ser cualquier número real -- pero al
// heredar zoom = floor(log2(...)) truncado a 18, un predio urbano pequeño
// (que necesitaría una escala mucho mayor para llenar el recuadro) queda
// topado muy por debajo de lo que cabría, y además floor() siempre
// descarta hasta casi una octava completa de escala respecto al ajuste
// ideal continuo, aun sin tocar el tope.
//
// Requisito 1 (detectar ocupación): se llama a computeMapState con el
// MISMO padding absoluto que ya usa hoy esta página (ver
// catastroxPdfGenerator.js, planoMapState) para obtener exactamente la
// escala que produce esa restricción heredada, y se compara contra el
// ajuste continuo ideal (mismo padding, sin floor ni tope) -- el cociente
// es qué fracción de lo que cabría realmente se estaba aprovechando.
// Requisito 2 (umbral 45%): SMALL_OCCUPANCY_TRIGGER.
// Requisitos 3/4 (60%-75% con padding 6%-10% para predios pequeños):
// SMALL_GEOMETRY_PADDING_RATIO/TARGET_OCCUPANCY, aplicados SOLO cuando la
// geometría se detecta pequeña.
// Requisito 5 (escala gráfica recalculada): se resuelve solo por devolver
// el mismo shape que computeMapState (scale/centerLat) --
// computeDynamicScaleMeters/computeMetersPerPixel ya lo consumen sin
// cambios.
// Requisito 7 (predios medianos/grandes intactos): cuando NO se detecta
// geometría pequeña, se devuelve el resultado de computeMapState SIN
// NINGÚN cambio -- mismo padding, mismo floor, mismo tope, mismo valor
// exacto que hoy. Ningún caso "no pequeño" cambia de tamaño.
const VECTOR_PLAN_SMALL_OCCUPANCY_TRIGGER = 0.45;
const VECTOR_PLAN_SMALL_PADDING_RATIO = 0.08; // rango pedido: 6%-10%
const VECTOR_PLAN_TARGET_OCCUPANCY = 0.68; // punto medio del rango pedido: 60%-75%

export function computeVectorPlanFitState(ring, viewportWidth, viewportHeight, {
  legacyPadding = 20,
  smallOccupancyTrigger = VECTOR_PLAN_SMALL_OCCUPANCY_TRIGGER,
  smallPaddingRatio = VECTOR_PLAN_SMALL_PADDING_RATIO,
  targetOccupancy = VECTOR_PLAN_TARGET_OCCUPANCY,
} = {}) {
  const bounds = getRingBounds(ring);
  const minWorldX = lngToWorldX(bounds.minLng);
  const maxWorldX = lngToWorldX(bounds.maxLng);
  const minWorldY = latToWorldY(bounds.maxLat);
  const maxWorldY = latToWorldY(bounds.minLat);
  const spanX = Math.max(maxWorldX - minWorldX, 1e-6);
  const spanY = Math.max(maxWorldY - minWorldY, 1e-6);

  const legacyState = computeMapState(ring, viewportWidth, viewportHeight, legacyPadding);
  const legacyUsableWidth = Math.max(64, viewportWidth - legacyPadding * 2);
  const legacyUsableHeight = Math.max(64, viewportHeight - legacyPadding * 2);
  const idealScaleAtLegacyPadding = Math.min(legacyUsableWidth / spanX, legacyUsableHeight / spanY);
  const occupancyRatio = legacyState.scale / idealScaleAtLegacyPadding;
  const isSmallGeometry = occupancyRatio < smallOccupancyTrigger;

  if (!isSmallGeometry) {
    return { ...legacyState, isSmallGeometry, occupancyRatio };
  }

  const usableWidth = Math.max(64, viewportWidth * (1 - 2 * smallPaddingRatio));
  const usableHeight = Math.max(64, viewportHeight * (1 - 2 * smallPaddingRatio));
  const naturalFitScale = Math.min(usableWidth / spanX, usableHeight / spanY);
  const scale = naturalFitScale * targetOccupancy;
  const centerLng = (bounds.minLng + bounds.maxLng) / 2;
  const centerLat = (bounds.minLat + bounds.maxLat) / 2;

  return {
    scale,
    centerLng,
    centerLat,
    centerWorldX: lngToWorldX(centerLng),
    centerWorldY: latToWorldY(centerLat),
    viewportWidth,
    viewportHeight,
    isSmallGeometry,
    occupancyRatio,
  };
}

export function projectPointToViewport(point, mapState, viewportWidth = mapState.viewportWidth, viewportHeight = mapState.viewportHeight) {
  const worldX = lngToWorldX(point[0]);
  const worldY = latToWorldY(point[1]);
  const x = (worldX - mapState.centerWorldX) * mapState.scale + viewportWidth / 2;
  const y = (worldY - mapState.centerWorldY) * mapState.scale + viewportHeight / 2;
  return [x, y];
}

export function projectRingToViewport(ring, mapState, viewportWidth, viewportHeight) {
  return ring.map((point) => projectPointToViewport(point, mapState, viewportWidth, viewportHeight));
}

// CATX-PDF-PARITY-002: escala gráfica dinámica del mapa satelital -- copiado
// literal de src/modules/catastrox/utils/catastroxDeliverables.js
// (computeMetersPerPixel/roundToNiceScaleMeters/computeDynamicScaleMeters,
// ~líneas 1740-1765), mismo constante de Web Mercator (circunferencia
// ecuatorial / 256px a zoom 0). Necesario para que "ESCALA GRÁFICA" en la
// página 1 del PDF server-side sea coherente con el mapState real usado
// para posicionar las teselas, no un valor inventado.
const WEB_MERCATOR_METERS_PER_WORLD_UNIT_AT_ZOOM0 = 156543.03392;

export function computeMetersPerPixel(mapState, extraScale = 1) {
  const latRad = ((mapState?.centerLat ?? 0) * Math.PI) / 180;
  const metersPerPixelBase = (WEB_MERCATOR_METERS_PER_WORLD_UNIT_AT_ZOOM0 * Math.cos(latRad)) / (mapState?.scale || 1);
  return metersPerPixelBase / (extraScale || 1);
}

// Redondea a la serie 1-2-5 x 10^n mas cercana (convención estándar de escalas gráficas).
export function roundToNiceScaleMeters(value) {
  if (!Number.isFinite(value) || value <= 0) return 10;
  const exponent = Math.floor(Math.log10(value));
  const base = value / 10 ** exponent;
  const niceBase = base < 1.5 ? 1 : base < 3.5 ? 2 : base < 7.5 ? 5 : 10;
  return niceBase * 10 ** exponent;
}

export function computeDynamicScaleMeters(mapState, mapWidthPx, extraScale = 1) {
  const metersPerPixel = computeMetersPerPixel(mapState, extraScale);
  const desiredMeters = mapWidthPx * 0.3 * metersPerPixel;
  return roundToNiceScaleMeters(desiredMeters);
}

// --- origen: src/modules/catastrox/utils/VisibleReferencePointEngine.js ---
function determineTargetVisiblePoints(vertexCount, averageTurn) {
  if (vertexCount <= 18 && averageTurn < 18) return 6;
  if (vertexCount <= 28 && averageTurn < 24) return 8;
  if (vertexCount <= 48) return 14;
  if (vertexCount <= 80) return 18;
  if (vertexCount <= 120) return 22;
  if (vertexCount <= 220) return 26;
  return 30;
}

function resolveMaxVisiblePoints(openRingLength, options = {}) {
  const requested = options.maxVisiblePoints ?? openRingLength;
  return Math.min(openRingLength, Math.max(6, requested));
}

function primaryCardinalSideForEngine(candidate) {
  const distances = [
    ['west', candidate.normX ?? 0.5],
    ['east', 1 - (candidate.normX ?? 0.5)],
    ['south', candidate.normY ?? 0.5],
    ['north', 1 - (candidate.normY ?? 0.5)],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0][0];
}

function detectSecondarySilhouetteBreaks({
  scoredWithPeaks,
  openRing,
  localRing,
  cumulative,
  totalPerimeter,
  diagonalMeters,
  selected,
  maxVisiblePoints,
}) {
  const segmentDistance = (startIndex, endIndex) =>
    ringDistanceForward(cumulative, openRing, startIndex, endIndex);

  const computeSecondaryScore = (candidate, distanceInSegment, segmentLength) => {
    const segmentWeight = Math.max(candidate.prevLen + candidate.nextLen, 1) / Math.max(diagonalMeters, 1);
    const shapePreservationBonus =
      (candidate.rdpDominant ? 80 : 0) +
      (candidate.structuralBreak ? 100 : 0) +
      (candidate.edgeBonus ? candidate.edgeBonus * 24 : 0);
    const trendChangeBonus =
      candidate.turnDeg >= 42 ? 44 :
      candidate.turnDeg >= 30 ? 28 :
      candidate.turnDeg >= 18 ? 16 : 0;
    const balance = Math.min(distanceInSegment, Math.max(segmentLength - distanceInSegment, 0)) / Math.max(segmentLength, 1);
    return (
      candidate.turnDeg * 8 +
      (candidate.deviation || 0) * 2.5 +
      segmentWeight * 240 +
      shapePreservationBonus +
      trendChangeBonus +
      balance * 120
    );
  };

  const selectedIndices = new Set(selected.map((entry) => entry.index));
  const selectedSorted = [...selected].sort((a, b) => a.index - b.index);
  const candidateRows = [];
  const added = [];
  const discarded = [];
  const discardedReasons = [];
  const beforeCount = selectedSorted.length;

  let guard = 0;
  while (selectedSorted.length < maxVisiblePoints && guard < 80) {
    guard += 1;
    let bestCandidate = null;

    for (let index = 0; index < selectedSorted.length; index += 1) {
      const current = selectedSorted[index];
      const next = selectedSorted[(index + 1) % selectedSorted.length];
      const perimeterSegment = segmentDistance(current.index, next.index);
      const gapCandidates = scoredWithPeaks
        .filter((candidate) => {
          if (selectedIndices.has(candidate.index)) return false;
          const forward = segmentDistance(current.index, candidate.index);
          const whole = segmentDistance(current.index, next.index);
          return forward > 0 && forward < whole;
        })
        .map((candidate) => {
          const forward = segmentDistance(current.index, candidate.index);
          const secondarySilhouetteScore = computeSecondaryScore(candidate, forward, perimeterSegment);
          const relevant =
            candidate.turnDeg >= 18 &&
            (
              (candidate.deviation || 0) >= diagonalMeters * 0.004 ||
              candidate.rdpDominant ||
              candidate.structuralBreak ||
              perimeterSegment >= 1200
            );
          const trendChange =
            candidate.turnDeg >= 24 ||
            ((candidate.deviation || 0) >= diagonalMeters * 0.006 && perimeterSegment >= totalPerimeter * 0.07);
          const shapeRelevant =
            relevant &&
            (
              trendChange ||
              perimeterSegment >= 1200 ||
              candidate.turnDeg >= 30 ||
              (candidate.deviation || 0) >= diagonalMeters * 0.009
            );

          const row = {
            ringIndex: candidate.index,
            lat: candidate.point[1],
            lng: candidate.point[0],
            turnDeg: candidate.turnDeg,
            deviation: candidate.deviation || 0,
            secondarySilhouetteScore,
            selected: false,
            discardedReason: shapeRelevant ? null : 'sin_aporte_suficiente_a_silueta',
            reasons: ['quiebre_secundario_silueta', 'preservacion_silueta', 'lectura_humana_poligono'],
            candidate,
            forward,
            perimeterSegment,
            shapeRelevant,
          };
          candidateRows.push(row);
          return row;
        })
        .filter((row) => row.shapeRelevant)
        .sort((a, b) => b.secondarySilhouetteScore - a.secondarySilhouetteScore);

      if (!gapCandidates.length) continue;

      const mustSplit =
        perimeterSegment > 1800 ||
        (perimeterSegment > 1200 && gapCandidates.length > 0) ||
        gapCandidates.some((row) => row.turnDeg >= 36 && row.deviation >= diagonalMeters * 0.007) ||
        gapCandidates.length >= 2;
      if (!mustSplit) {
        gapCandidates.forEach((row) => {
          row.discardedReason = row.discardedReason || 'tramo_no_requiere_refinamiento';
        });
        continue;
      }

      const chosen = gapCandidates[0];
      if (
        !bestCandidate ||
        chosen.perimeterSegment > bestCandidate.perimeterSegment ||
        chosen.secondarySilhouetteScore > bestCandidate.secondarySilhouetteScore
      ) {
        bestCandidate = chosen;
      }
    }

    if (!bestCandidate) break;

    const enriched = {
      ...bestCandidate.candidate,
      protectedPoint: true,
      secondarySilhouetteBreak: true,
      reasons: [...new Set([...(bestCandidate.candidate.reasons || []), ...bestCandidate.reasons])],
    };
    selectedIndices.add(enriched.index);
    selectedSorted.push(enriched);
    selectedSorted.sort((a, b) => a.index - b.index);
    added.push({
      ringIndex: enriched.index,
      lat: enriched.point[1],
      lng: enriched.point[0],
      turnDeg: enriched.turnDeg,
      deviation: enriched.deviation || 0,
      secondarySilhouetteScore: bestCandidate.secondarySilhouetteScore,
      reasons: enriched.reasons,
    });
  }

  const finalSelectedIndexSet = new Set(selectedSorted.map((entry) => entry.index));
  const seenDiscarded = new Set();
  candidateRows.forEach((row) => {
    if (finalSelectedIndexSet.has(row.ringIndex)) {
      row.selected = true;
      row.discardedReason = null;
      return;
    }
    const key = `${row.ringIndex}:${row.discardedReason || 'descartado'}`;
    if (!seenDiscarded.has(key)) {
      discarded.push({
        ringIndex: row.ringIndex,
        lat: row.lat,
        lng: row.lng,
        turnDeg: row.turnDeg,
        deviation: row.deviation,
        secondarySilhouetteScore: row.secondarySilhouetteScore,
        reasons: row.reasons,
        discardedReason: row.discardedReason || 'descartado_por_prioridad_menor',
      });
      discardedReasons.push(row.discardedReason || 'descartado_por_prioridad_menor');
      seenDiscarded.add(key);
    }
  });

  return {
    selected: selectedSorted,
    report: {
      beforeCount,
      detectedCount: candidateRows.length,
      addedCount: added.length,
      discardedCount: discarded.length,
      added,
      discarded,
      discardedReasons,
      candidateRows: candidateRows.map((row) => ({
        ringIndex: row.ringIndex,
        lat: row.lat,
        lng: row.lng,
        turnDeg: row.turnDeg,
        deviation: row.deviation,
        secondarySilhouetteScore: row.secondarySilhouetteScore,
        reasons: row.reasons,
        selected: finalSelectedIndexSet.has(row.ringIndex),
        discardedReason: finalSelectedIndexSet.has(row.ringIndex) ? null : (row.discardedReason || 'descartado_por_prioridad_menor'),
      })),
    },
  };
}

export function selectVisibleReferencePoints(ring, options = {}) {
  const openRing = ring.slice(0, -1);
  if (openRing.length <= 12) {
    const selectedCandidates = openRing.map((point, index) => ({
      index,
      point,
      score: 1,
      turnDeg: 180,
      mandatory: true,
      cardinalGroups: [],
      primarySide: 'none',
      reasons: ['predio_simple'],
    }));
    return {
      selectedCandidates,
      report: {
        totalRealVertices: openRing.length,
        totalCandidatesDetected: selectedCandidates.length,
        totalVisiblePoints: selectedCandidates.length,
        maxAllowed: resolveMaxVisiblePoints(openRing.length, options),
        forcedByExtremes: Math.min(openRing.length, 4),
        forcedByAngularChange: 0,
        selectedBySimplification: 0,
        eliminatedByProximity: 0,
        validation: 'OK',
        reasons: selectedCandidates.map((candidate, idx) => ({
          point: `P${idx + 1}`,
          ringIndex: candidate.index,
          reasons: candidate.reasons,
        })),
      },
    };
  }

  const localRing = projectRingToLocalMeters(openRing);
  const cumulative = cumulativeDistances(openRing);
  const totalPerimeter = cumulative[cumulative.length - 1] + haversineMeters(openRing[openRing.length - 1], openRing[0]);
  const requestedMax = resolveMaxVisiblePoints(openRing.length, options);
  const bounds = getRingBounds(openRing);
  const localBounds = getPointBounds(localRing);
  const diagonalMeters = Math.hypot(localBounds.width, localBounds.height) || 1;
  const spanLng = Math.max(bounds.maxLng - bounds.minLng, 1e-9);
  const spanLat = Math.max(bounds.maxLat - bounds.minLat, 1e-9);
  const rdpDominantIndices = new Set([
    ...simplifyRingIndices(localRing, diagonalMeters * 0.018),
    ...simplifyRingIndices(localRing, diagonalMeters * 0.03),
  ]);

  const scored = openRing.map((point, index) => {
    const prev = localRing[(index - 1 + openRing.length) % openRing.length];
    const current = localRing[index];
    const next = localRing[(index + 1) % openRing.length];
    const turnDeg = turnDegrees(prev, current, next);
    const prevLen = Math.hypot(current[0] - prev[0], current[1] - prev[1]);
    const nextLen = Math.hypot(next[0] - current[0], next[1] - current[1]);
    const localScale = prevLen + nextLen;
    const deviation = perpendicularDistanceMeters(current, prev, next);
    const cross = (current[0] - prev[0]) * (next[1] - current[1]) - (current[1] - prev[1]) * (next[0] - current[0]);
    const dxLeft = Math.abs(point[0] - bounds.minLng);
    const dxRight = Math.abs(point[0] - bounds.maxLng);
    const dyBottom = Math.abs(point[1] - bounds.minLat);
    const dyTop = Math.abs(point[1] - bounds.maxLat);
    const normX = (point[0] - bounds.minLng) / spanLng;
    const normY = (point[1] - bounds.minLat) / spanLat;
    const extremeWest = dxLeft <= spanLng * 0.06;
    const extremeEast = dxRight <= spanLng * 0.06;
    const extremeSouth = dyBottom <= spanLat * 0.06;
    const extremeNorth = dyTop <= spanLat * 0.06;
    const edgeBonus =
      (extremeWest ? 1 : 0) +
      (extremeEast ? 1 : 0) +
      (extremeSouth ? 1 : 0) +
      (extremeNorth ? 1 : 0);
    const angleWeight = turnDeg >= 120 ? 9.5 : turnDeg >= 95 ? 7.2 : turnDeg >= 72 ? 5.3 : turnDeg >= 48 ? 3.1 : 0.85;
    const cardinalGroups = [];
    if (normX <= 0.36) cardinalGroups.push('west');
    if (normX >= 0.64) cardinalGroups.push('east');
    if (normY <= 0.36) cardinalGroups.push('south');
    if (normY >= 0.64) cardinalGroups.push('north');
    const rdpDominant = rdpDominantIndices.has(index);
    const structuralBreak =
      turnDeg >= 84 ||
      rdpDominant ||
      edgeBonus > 0 ||
      (turnDeg >= 56 && localScale >= diagonalMeters * 0.04) ||
      (turnDeg >= 38 && deviation >= diagonalMeters * 0.016) ||
      (Math.abs(cross) >= diagonalMeters * 7 && localScale >= diagonalMeters * 0.05);
    return {
      index,
      point,
      turnDeg,
      edgeBonus,
      normX,
      normY,
      prevLen,
      nextLen,
      localScale,
      deviation,
      cross,
      extremeWest,
      extremeEast,
      extremeSouth,
      extremeNorth,
      rdpDominant,
      structuralBreak,
      cardinalGroups,
      score:
        Math.max(localScale, 1) * angleWeight +
        edgeBonus * 240 +
        deviation * 1.8 +
        (rdpDominant ? 220 : 0) +
        (structuralBreak ? 180 : 0),
    };
  });

  const averageTurn = scored.reduce((sum, candidate) => sum + candidate.turnDeg, 0) / scored.length;
  const targetCount = Math.min(requestedMax, determineTargetVisiblePoints(openRing.length, averageTurn));
  const minPerimeterSpacing = totalPerimeter / Math.max(targetCount * 1.65, 1);
  const minStraightSpacingMeters = diagonalMeters / Math.max(targetCount * 1.28, 1);
  const adaptiveMaxSegmentLength = Math.min(totalPerimeter * 0.18, (totalPerimeter / Math.max(targetCount, 1)) * 1.75);
  const absoluteMaxSegmentLength =
    totalPerimeter <= 3500 ? 600 :
    totalPerimeter <= 6000 ? 1000 :
    totalPerimeter <= 12000 ? 1500 :
    1500;
  const maxSegmentLength = Math.min(adaptiveMaxSegmentLength, absoluteMaxSegmentLength);

  const scoredWithPeaks = scored.map((candidate, index) => {
    const prev = scored[(index - 1 + scored.length) % scored.length];
    const next = scored[(index + 1) % scored.length];
    const localPeak =
      candidate.turnDeg >= 42 &&
      candidate.turnDeg >= prev.turnDeg * 0.94 &&
      candidate.turnDeg >= next.turnDeg * 0.94;
    const protectedPoint =
      candidate.structuralBreak ||
      (localPeak &&
        (candidate.turnDeg >= 70 || candidate.edgeBonus >= 1 || candidate.score > (prev.score + next.score) / 2));

    return {
      ...candidate,
      localPeak,
      protectedPoint,
      primarySide: primaryCardinalSideForEngine(candidate),
      reasons: [],
    };
  });

  const center = ringCentroid(openRing);
  const sectorCount = Math.max(8, Math.min(14, Math.round(targetCount * 0.75)));
  const sectorBuckets = Array.from({ length: sectorCount }, () => []);
  scoredWithPeaks.forEach((candidate) => {
    const angle = Math.atan2(candidate.point[1] - center[1], candidate.point[0] - center[0]);
    const normalized = angle < 0 ? angle + Math.PI * 2 : angle;
    const sector = Math.min(sectorCount - 1, Math.floor((normalized / (Math.PI * 2)) * sectorCount));
    const perimeterRatio = (cumulative[candidate.index] || 0) / Math.max(totalPerimeter, 1);
    const perimeterBucketCount = Math.max(8, Math.min(16, targetCount));
    const perimeterBucket = Math.min(
      perimeterBucketCount - 1,
      Math.floor(perimeterRatio * perimeterBucketCount),
    );
    const cardinalGroups = [];
    if (candidate.normX <= 0.32) cardinalGroups.push('west');
    if (candidate.normX >= 0.68) cardinalGroups.push('east');
    if (candidate.normY <= 0.32) cardinalGroups.push('south');
    if (candidate.normY >= 0.68) cardinalGroups.push('north');
    sectorBuckets[sector].push({
      ...candidate,
      sector,
      perimeterBucket,
      cardinalGroups,
    });
  });

  const selected = [];
  const sectorCounts = new Map();
  const bucketCounts = new Map();
  const cardinalCounts = new Map();
  let forcedByExtremes = 0;
  let forcedByAngularChange = 0;
  let selectedBySimplification = 0;
  let addedByLongSegments = 0;
  const registerSelected = (candidate) => {
    if (typeof candidate.sector === 'number') {
      sectorCounts.set(candidate.sector, (sectorCounts.get(candidate.sector) || 0) + 1);
    }
    if (typeof candidate.perimeterBucket === 'number') {
      bucketCounts.set(candidate.perimeterBucket, (bucketCounts.get(candidate.perimeterBucket) || 0) + 1);
    }
    (candidate.cardinalGroups || []).forEach((group) => {
      cardinalCounts.set(group, (cardinalCounts.get(group) || 0) + 1);
    });
  };
  const canAddSectorCandidate = (candidate, phase = 'general') => {
    const count = typeof candidate.sector === 'number' ? sectorCounts.get(candidate.sector) || 0 : 0;
    const bucketCount = typeof candidate.perimeterBucket === 'number' ? bucketCounts.get(candidate.perimeterBucket) || 0 : 0;
    const sectorCap = phase === 'coverage' ? 1 : phase === 'balance' ? 2 : 3;
    const bucketCap = phase === 'coverage' ? 1 : phase === 'balance' ? 2 : 3;
    if (count >= sectorCap || bucketCount >= bucketCap) return false;
    if (!candidate.cardinalGroups?.length) return true;
    const cardinalCap = phase === 'coverage' ? Math.max(2, Math.round(targetCount / 8)) : phase === 'balance' ? Math.max(3, Math.round(targetCount / 6)) : Math.max(4, Math.round(targetCount / 5));
    const sideCap = Math.max(3, Math.ceil(targetCount * 0.38));
    return candidate.cardinalGroups.every((group) => {
      const current = cardinalCounts.get(group) || 0;
      return current < cardinalCap && current < sideCap;
    });
  };
  const canSelect = (candidate) =>
    selected.every((entry) => {
      const candidateMeters = localRing[candidate.index];
      const entryMeters = localRing[entry.index];
      const direct = Math.hypot(candidateMeters[0] - entryMeters[0], candidateMeters[1] - entryMeters[1]);
      const perimeterGap = Math.min(
        ringDistanceForward(cumulative, openRing, candidate.index, entry.index),
        ringDistanceForward(cumulative, openRing, entry.index, candidate.index),
      );
      const spacingFactor =
        candidate.mandatory || candidate.protectedPoint || candidate.structuralBreak
          ? 0.58
          : candidate.turnDeg >= 90
            ? 0.74
            : 1;
      return direct >= minStraightSpacingMeters * spacingFactor && perimeterGap >= minPerimeterSpacing * spacingFactor;
    });

  const dominantCandidates = [...scoredWithPeaks]
    .filter((candidate) => candidate.protectedPoint || candidate.turnDeg >= 52 || candidate.edgeBonus > 0 || candidate.rdpDominant)
    .sort((a, b) => b.score - a.score);

  const selectCandidate = (candidate, tags = {}) => {
    const next = {
      ...candidate,
      ...tags,
      reasons: [...new Set([...(candidate.reasons || []), ...(tags.reasons || [])])],
    };
    selected.push(next);
    registerSelected(next);
  };

  const cardinalGroups = ['west', 'north', 'south', 'east'];
  cardinalGroups.forEach((group) => {
    const groupCandidates = sectorBuckets
      .flat()
      .filter((candidate) => candidate.cardinalGroups?.includes(group))
      .sort((a, b) => {
        if (a.protectedPoint !== b.protectedPoint) return a.protectedPoint ? -1 : 1;
        if (a.turnDeg !== b.turnDeg) return b.turnDeg - a.turnDeg;
        return b.score - a.score;
      });

    const groupTarget = targetCount >= 22 ? 3 : targetCount >= 14 ? 2 : 1;
    let added = 0;
    for (const candidate of groupCandidates) {
      if (added >= groupTarget || selected.length >= Math.min(targetCount, requestedMax)) break;
      if (
        !selected.some((entry) => entry.index === candidate.index) &&
        canAddSectorCandidate(candidate, 'coverage') &&
        (selected.length < 2 || canSelect({ ...candidate, protectedPoint: true, cardinalProtected: true }))
      ) {
        selectCandidate(candidate, {
          protectedPoint: true,
          cardinalProtected: true,
          mandatory: true,
          reasons: ['extremo_geometrico', `lado_${group}`, 'punto_estructural_obligatorio'],
        });
        forcedByExtremes += 1;
        added += 1;
      }
    }
  });

  sectorBuckets.forEach((bucket) => {
    const sectorBest = [...bucket]
      .sort((a, b) => {
        if (a.protectedPoint !== b.protectedPoint) return a.protectedPoint ? -1 : 1;
        if (a.turnDeg !== b.turnDeg) return b.turnDeg - a.turnDeg;
        return b.score - a.score;
      })[0];
    if (
      sectorBest &&
      selected.length < Math.min(targetCount, requestedMax) &&
      !selected.some((entry) => entry.index === sectorBest.index) &&
      canAddSectorCandidate(sectorBest, 'coverage') &&
      (selected.length < 2 || canSelect({ ...sectorBest, protectedPoint: true }))
    ) {
      selectCandidate(sectorBest, {
        protectedPoint: true,
        sectorProtected: true,
        reasons: ['distribucion_perimetral', 'punto_estructural_obligatorio'],
      });
    }
  });

  const bucketGroups = new Map();
  sectorBuckets.flat().forEach((candidate) => {
    if (!bucketGroups.has(candidate.perimeterBucket)) bucketGroups.set(candidate.perimeterBucket, []);
    bucketGroups.get(candidate.perimeterBucket).push(candidate);
  });

  [...bucketGroups.entries()]
    .sort((a, b) => a[0] - b[0])
    .forEach(([, bucket]) => {
      const best = [...bucket].sort((a, b) => {
        if (a.protectedPoint !== b.protectedPoint) return a.protectedPoint ? -1 : 1;
        if (a.turnDeg !== b.turnDeg) return b.turnDeg - a.turnDeg;
        return b.score - a.score;
      })[0];
      if (
        best &&
        selected.length < Math.min(targetCount, requestedMax) &&
        !selected.some((entry) => entry.index === best.index) &&
        canAddSectorCandidate(best, 'coverage') &&
        (selected.length < 2 || canSelect({ ...best, protectedPoint: true, bucketProtected: true }))
      ) {
        selectCandidate(best, {
          protectedPoint: true,
          bucketProtected: true,
          reasons: ['bucket_perimetral', 'preservacion_de_forma'],
        });
      }
    });

  for (const candidate of dominantCandidates) {
    if (selected.length >= Math.min(targetCount, requestedMax)) break;
    if (
      !selected.some((entry) => entry.index === candidate.index) &&
      canAddSectorCandidate(candidate, 'balance') &&
      (selected.length < 2 || canSelect(candidate))
    ) {
      selectCandidate(candidate, {
        reasons: candidate.turnDeg >= 70 ? ['cambio_angular_fuerte', 'quiebre_estructural'] : ['candidato_significativo', 'preservacion_de_forma'],
      });
      if (candidate.turnDeg >= 70) forcedByAngularChange += 1;
    }
  }

  const slotSize = totalPerimeter / targetCount;
  for (let slotIndex = 0; slotIndex < targetCount; slotIndex += 1) {
    const slotStart = slotIndex * slotSize;
    const slotEnd = slotStart + slotSize;
    const slotCandidates = scoredWithPeaks
      .filter(({ index }) => {
        const distanceAlong = cumulative[index];
        return distanceAlong >= slotStart && distanceAlong < slotEnd;
      })
      .sort((a, b) => b.score - a.score);

    const chosen = slotCandidates.find(
      (candidate) =>
        canAddSectorCandidate(candidate, 'balance') &&
        (selected.length < 2 || canSelect(candidate)),
    );
    if (chosen && !selected.some((entry) => entry.index === chosen.index)) {
      selectCandidate(chosen, { reasons: ['representatividad_perimetral', 'preservacion_de_forma'] });
      selectedBySimplification += 1;
    }
  }

  const minimumSelection = Math.min(requestedMax, targetCount);
  if (selected.length < minimumSelection) {
    const fallbackCandidates = [...scoredWithPeaks].sort((a, b) => b.score - a.score);
    for (const candidate of fallbackCandidates) {
      if (selected.length >= minimumSelection) break;
      if (
        !selected.some((entry) => entry.index === candidate.index) &&
        (canAddSectorCandidate(candidate, 'general') || candidate.structuralBreak || candidate.rdpDominant) &&
        canSelect(candidate)
      ) {
        selectCandidate(candidate, { reasons: ['ajuste_final_por_puntaje', candidate.structuralBreak ? 'quiebre_relevante' : 'preservacion_de_forma'] });
      }
    }
  }

  const segmentDeviationMeters = (candidateIndex, startIndex, endIndex) => {
    const point = localRing[candidateIndex];
    const start = localRing[startIndex];
    const end = localRing[endIndex];
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const length = Math.hypot(dx, dy) || 1;
    return Math.abs(dy * point[0] - dx * point[1] + end[0] * start[1] - end[1] * start[0]) / length;
  };

  const visibleSegmentDistance = (startIndex, endIndex) =>
    ringDistanceForward(cumulative, openRing, startIndex, endIndex);

  const collectGapCandidates = (startIndex, endIndex, selectedEntries = selected) =>
    scoredWithPeaks.filter((candidate) => {
      if (selectedEntries.some((entry) => entry.index === candidate.index)) return false;
      const forward = ringDistanceForward(cumulative, openRing, startIndex, candidate.index);
      const whole = ringDistanceForward(cumulative, openRing, startIndex, endIndex);
      return forward > 0 && forward < whole;
    });

  const isRelevantSilhouetteCandidate = (candidate, segmentDistance) =>
    candidate.structuralBreak ||
    candidate.rdpDominant ||
    candidate.turnDeg >= 62 ||
    (candidate.turnDeg >= 46 && (candidate.deviation || 0) >= diagonalMeters * 0.012) ||
    (segmentDistance >= 1200 && candidate.turnDeg >= 32 && (candidate.deviation || 0) >= diagonalMeters * 0.008) ||
    (segmentDistance >= 1800 && (candidate.turnDeg >= 24 || (candidate.deviation || 0) >= diagonalMeters * 0.01));

  const insertLongSegmentPoints = () => {
    let changed = false;
    let guard = 0;
    while (selected.length < requestedMax && guard < 60) {
      guard += 1;
      selected.sort((a, b) => a.index - b.index);
      let longest = null;
      for (let index = 0; index < selected.length; index += 1) {
        const current = selected[index];
        const next = selected[(index + 1) % selected.length];
        const distance = visibleSegmentDistance(current.index, next.index);
        const candidatesInGap = scoredWithPeaks.filter((candidate) => {
          if (selected.some((entry) => entry.index === candidate.index)) return false;
          const forward = ringDistanceForward(cumulative, openRing, current.index, candidate.index);
          const whole = ringDistanceForward(cumulative, openRing, current.index, next.index);
          return forward > 0 && forward < whole;
        });
        const complexity = candidatesInGap.reduce(
          (acc, candidate) => {
            if (candidate.structuralBreak) acc.structuralCount += 1;
            acc.maxTurn = Math.max(acc.maxTurn, candidate.turnDeg);
            acc.maxDeviation = Math.max(acc.maxDeviation, candidate.deviation || 0);
            return acc;
          },
          { structuralCount: 0, maxTurn: 0, maxDeviation: 0 },
        );
        const complexGap =
          complexity.structuralCount >= 2 ||
          complexity.maxTurn >= 70 ||
          (complexity.maxTurn >= 48 && complexity.maxDeviation >= diagonalMeters * 0.018);
        if (
          !longest ||
          distance > longest.distance ||
          (complexGap && !longest.complexGap)
        ) {
          longest = { current, next, distance, candidatesInGap, complexGap, complexity };
        }
      }
      if (
        !longest ||
        (
          longest.distance <= maxSegmentLength &&
          !(longest.complexGap && longest.distance >= totalPerimeter / Math.max(targetCount * 1.65, 1))
        )
      ) break;

      const candidatesInGap = longest.candidatesInGap
        .map((candidate) => {
          const forward = ringDistanceForward(cumulative, openRing, longest.current.index, candidate.index);
          const backward = ringDistanceForward(cumulative, openRing, candidate.index, longest.next.index);
          const balance = Math.min(forward, backward) / Math.max(longest.distance, 1);
          const deviation = segmentDeviationMeters(candidate.index, longest.current.index, longest.next.index);
          const importance =
            candidate.score +
            candidate.turnDeg * 12 +
            deviation * 1.5 +
            balance * 240 +
            (candidate.protectedPoint ? 180 : 0) +
            (candidate.structuralBreak ? 220 : 0);
          return { ...candidate, importance };
        })
        .sort((a, b) => b.importance - a.importance);

      const chosen =
        candidatesInGap.find((candidate) => canSelect({ ...candidate, mandatory: true, protectedPoint: true, structuralBreak: true })) ||
        candidatesInGap[0];
      if (!chosen) break;
      selectCandidate(chosen, {
        mandatory: true,
        protectedPoint: true,
        structuralBreak: true,
        reasons: ['tramo_largo', longest.complexGap ? 'tramo_complejo' : 'quiebre_representativo', 'punto_de_apoyo_por_tramo_largo'],
      });
      addedByLongSegments += 1;
      changed = true;
    }
    return changed;
  };

  insertLongSegmentPoints();
  const secondarySilhouette = detectSecondarySilhouetteBreaks({
    scoredWithPeaks,
    openRing,
    localRing,
    cumulative,
    totalPerimeter,
    diagonalMeters,
    selected,
    maxVisiblePoints: requestedMax,
  });
  selected.length = 0;
  secondarySilhouette.selected.forEach((entry) => selected.push(entry));
  selected.sort((a, b) => a.index - b.index);
  let longestBeforeRefinement = 0;
  for (let index = 0; index < selected.length; index += 1) {
    const current = selected[index];
    const next = selected[(index + 1) % selected.length];
    longestBeforeRefinement = Math.max(longestBeforeRefinement, visibleSegmentDistance(current.index, next.index));
  }

  let addedBySecondaryBreaks = 0;
  let addedByComplexSegments = 0;
  const refineVisibleSilhouette = () => {
    let changed = false;
    let guard = 0;
    while (selected.length < requestedMax && guard < 80) {
      guard += 1;
      selected.sort((a, b) => a.index - b.index);
      let bestGapChoice = null;

      for (let index = 0; index < selected.length; index += 1) {
        const current = selected[index];
        const next = selected[(index + 1) % selected.length];
        const segmentDistance = visibleSegmentDistance(current.index, next.index);
        const gapCandidates = collectGapCandidates(current.index, next.index);
        if (!gapCandidates.length) continue;

        const relevantCandidates = gapCandidates
          .filter((candidate) => isRelevantSilhouetteCandidate(candidate, segmentDistance))
          .map((candidate) => {
            const forward = ringDistanceForward(cumulative, openRing, current.index, candidate.index);
            const backward = ringDistanceForward(cumulative, openRing, candidate.index, next.index);
            const balance = Math.min(forward, backward) / Math.max(segmentDistance, 1);
            const importance =
              candidate.score +
              candidate.turnDeg * 14 +
              (candidate.deviation || 0) * 1.7 +
              balance * 260 +
              (candidate.structuralBreak ? 220 : 0) +
              (candidate.rdpDominant ? 160 : 0) +
              (segmentDistance >= 1800 ? 120 : segmentDistance >= 1200 ? 60 : 0);
            return { ...candidate, importance, segmentDistance };
          })
          .sort((a, b) => b.importance - a.importance);

        if (!relevantCandidates.length) continue;

        const needsRefinement =
          segmentDistance > maxSegmentLength ||
          segmentDistance >= 1200 ||
          relevantCandidates.length >= 2 ||
          relevantCandidates.some((candidate) => candidate.turnDeg >= 60);
        if (!needsRefinement) continue;

        const chosen =
          relevantCandidates.find((candidate) =>
            canSelect({
              ...candidate,
              mandatory: true,
              protectedPoint: true,
              structuralBreak: true,
            }),
          ) || null;
        if (!chosen) continue;

        if (
          !bestGapChoice ||
          chosen.segmentDistance > bestGapChoice.segmentDistance ||
          chosen.importance > bestGapChoice.importance
        ) {
          bestGapChoice = chosen;
        }
      }

      if (!bestGapChoice) break;
      selectCandidate(bestGapChoice, {
        mandatory: true,
        protectedPoint: true,
        structuralBreak: true,
        reasons: [
          bestGapChoice.segmentDistance >= 1200 ? 'tramo_largo' : 'quiebre_secundario_relevante',
          bestGapChoice.segmentDistance >= 1200 ? 'tramo_complejo' : 'refinamiento_de_silueta',
          'preservacion_de_forma',
        ],
      });
      if (bestGapChoice.segmentDistance >= 1200) addedByComplexSegments += 1;
      else addedBySecondaryBreaks += 1;
      changed = true;
    }
    return changed;
  };

  refineVisibleSilhouette();
  selected.sort((a, b) => a.index - b.index);
  const selectedCandidates = selected.slice(0, requestedMax);
  let longestFinalSegment = 0;
  let unresolvedLongSegments = 0;
  for (let index = 0; index < selectedCandidates.length; index += 1) {
    const current = selectedCandidates[index];
    const next = selectedCandidates[(index + 1) % selectedCandidates.length];
    const distance = visibleSegmentDistance(current.index, next.index);
    longestFinalSegment = Math.max(longestFinalSegment, distance);
    if (distance > maxSegmentLength) {
      const hasRemainingRelevantCandidate = scoredWithPeaks.some((candidate) => {
        if (selectedCandidates.some((entry) => entry.index === candidate.index)) return false;
        const forward = ringDistanceForward(cumulative, openRing, current.index, candidate.index);
        const whole = ringDistanceForward(cumulative, openRing, current.index, next.index);
        if (!(forward > 0 && forward < whole)) return false;
        return candidate.structuralBreak || candidate.turnDeg >= 52 || (candidate.deviation || 0) >= diagonalMeters * 0.016;
      });
      if (hasRemainingRelevantCandidate) unresolvedLongSegments += 1;
    }
  }
  return {
    selectedCandidates,
    report: {
      totalRealVertices: openRing.length,
      totalCandidatesDetected: scoredWithPeaks.length,
      totalVisiblePoints: selectedCandidates.length,
      maxAllowed: requestedMax,
      targetPointCount: targetCount,
      perimeterTotal: totalPerimeter,
      maxSegmentLength,
      forcedByExtremes,
      forcedByAngularChange,
      selectedBySimplification,
      addedByLongSegments,
      addedBySecondarySilhouette: secondarySilhouette.report.addedCount,
      secondarySilhouetteDetected: secondarySilhouette.report.detectedCount,
      secondarySilhouetteDiscarded: secondarySilhouette.report.discardedCount,
      secondarySilhouetteProtected: secondarySilhouette.report.added.length,
      secondarySilhouetteDiscardedReasons: secondarySilhouette.report.discardedReasons,
      secondarySilhouetteCandidates: secondarySilhouette.report.candidateRows,
      addedBySecondaryBreaks,
      addedByComplexSegments,
      eliminatedByProximity: 0,
      longestSegmentBeforeRefinement: longestBeforeRefinement,
      longestFinalSegment,
      unresolvedLongSegments,
      validation: unresolvedLongSegments === 0 ? 'OK' : 'ERROR',
      reasons: selectedCandidates.map((candidate, idx) => ({
        point: `P${idx + 1}`,
        ringIndex: candidate.index,
        reasons: candidate.reasons,
      })),
    },
  };
}

function buildVisiblePointProjectionForEngine(referencePoints, mapState, zone) {
  return referencePoints.map((entry) => {
    const point = entry.point || entry;
    const worldX = ((point[0] + 180) / 360) * 256;
    const sinLat = Math.sin((point[1] * Math.PI) / 180);
    const worldY = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * 256;
    const x = (worldX - mapState.centerWorldX) * mapState.scale + zone.width / 2;
    const y = (worldY - mapState.centerWorldY) * mapState.scale + zone.height / 2;
    return [zone.x + x, zone.y + y];
  });
}

export function reducePointsForVisualClarity(referenceCandidates, ring, mapState, zone, options = {}) {
  let current = [...referenceCandidates];
  const requestedMin = options.minVisiblePoints ?? 10;
  const minVisible = Math.min(referenceCandidates.length, Math.max(requestedMin, Math.round(referenceCandidates.length * 0.64)));
  const getPrimarySide = (entry) => entry.primarySide || primaryCardinalSideForEngine(entry);
  const getProtectionLevel = (entry) =>
    (entry.mandatory ? 8 : 0) +
    (entry.cardinalProtected ? 5 : 0) +
    (entry.bucketProtected ? 2 : 0) +
    (entry.sectorProtected ? 2 : 0) +
    (entry.secondarySilhouetteBreak ? 8 : 0) +
    (entry.rdpDominant ? 4 : 0) +
    (entry.protectedPoint ? 3 : 0) +
    (entry.structuralBreak ? 4 : 0);
  const isStronglyProtected = (entry) =>
    Boolean(
      entry.secondarySilhouetteBreak ||
      entry.structuralBreak ||
      entry.protectedPoint ||
      entry.mandatory ||
      entry.rdpDominant ||
      (entry.reasons || []).some((reason) =>
        [
          'quiebre_secundario_silueta',
          'preservacion_silueta',
          'lectura_humana_poligono',
          'refinamiento_de_silueta',
          'quiebre_relevante',
        ].includes(reason),
      )
    );
  const getImportance = (entry) =>
    (entry.score || 0) +
    (entry.turnDeg || 0) * 8 +
    ((entry.deviation || 0) * 0.8) +
    (entry.structuralBreak ? 240 : 0);
  const minSidePresence = Math.max(1, Math.min(3, Math.round(minVisible / 8)));

  while (current.length > minVisible) {
    const projected = buildVisiblePointProjectionForEngine(current.map((entry) => entry.point), mapState, zone);
    let collisionPair = null;
    for (let i = 0; i < projected.length; i += 1) {
      for (let j = i + 1; j < projected.length; j += 1) {
        if (Math.hypot(projected[i][0] - projected[j][0], projected[i][1] - projected[j][1]) < 26) {
          collisionPair = [i, j];
          break;
        }
      }
      if (collisionPair) break;
    }
    if (!collisionPair) break;

    const sideCounts = current.reduce((acc, entry) => {
      const side = getPrimarySide(entry);
      acc[side] = (acc[side] || 0) + 1;
      return acc;
    }, {});

    const candidateIndices = collisionPair ? collisionPair : current.map((_, index) => index);
    let weakestIndex = null;

    for (const index of candidateIndices) {
      const candidate = current[index];
      const side = getPrimarySide(candidate);
      if (side !== 'none' && (sideCounts[side] || 0) <= minSidePresence) continue;
      if (candidate.mandatory && candidate.cardinalProtected) continue;
      const candidateLevel = getProtectionLevel(candidate);
      if (isStronglyProtected(candidate) && candidateLevel >= 8) continue;

      if (weakestIndex === null) {
        weakestIndex = index;
        continue;
      }

      const weakest = current[weakestIndex];
      const weakestLevel = getProtectionLevel(weakest);
      if (isStronglyProtected(weakest) && !isStronglyProtected(candidate)) {
        weakestIndex = index;
        continue;
      }
      if (weakestLevel > candidateLevel) {
        weakestIndex = index;
        continue;
      }
      if (
        candidateLevel === weakestLevel &&
        getImportance(candidate) < getImportance(weakest)
      ) {
        weakestIndex = index;
      }
    }
    if (weakestIndex === null) break;
    current.splice(weakestIndex, 1);
  }

  const removedByProximity = Math.max(referenceCandidates.length - current.length, 0);
  current.removedByProximity = removedByProximity;
  return current;
}
