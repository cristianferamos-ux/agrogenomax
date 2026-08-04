// CATX-PDF-PARITY-002 (tercera vuelta): puerto LITERAL del motor de
// colocación de etiquetas de distancia y de vértices del generador
// aprobado (src/modules/catastrox/utils/catastroxDeliverables.js) --
// búsqueda de candidatos + evasión de colisiones contra vértices, otras
// etiquetas, el recuadro del mapa, la rosa de los vientos y la escala
// gráfica. Reemplaza la colocación por offset perpendicular fijo de la
// vuelta anterior (documentada como brecha residual, ahora cerrada).
//
// Toda esta lógica es JS puro (geometría + medición de texto vía una
// función `measureTextWidth` inyectada) -- funciona igual con
// `context.measureText` (canvas) o `doc.widthOfString` (PDFKit), así que
// no hace falta canvas ni ninguna dependencia nueva.
//
// Fuente exacta de cada función (para auditoría de paridad, ver informe
// de entrega):
//   rectsOverlap                        -> catastroxDeliverables.js:988-995
//   pointInExpandedRect                 -> catastroxDeliverables.js:1806-1813
//   pointInPolygon                      -> catastroxDeliverables.js:1815-1828
//   buildVisiblePointPlacements         -> catastroxDeliverables.js:1623-1687
//   chooseScaleBarAnchor                -> catastroxDeliverables.js:1830-1866
//   getCompassRoseRect                  -> catastroxDeliverables.js:2768-2770
//   normalizeDimensionAngle             -> catastroxDeliverables.js:2772-2777
//   buildRotatedRect                    -> catastroxDeliverables.js:2779-2790
//   buildTechnicalSegmentDimensionPlacements -> catastroxDeliverables.js:2792-2900
import { getPointBounds } from './catastroxPdfGeometry.js';

export function rectsOverlap(a, b, padding = 0) {
  return !(
    a.x + a.width + padding <= b.x ||
    b.x + b.width + padding <= a.x ||
    a.y + a.height + padding <= b.y ||
    b.y + b.height + padding <= a.y
  );
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];
    const intersect =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function getCompassRoseRect(x, y) {
  return { x: x - 30, y: y - 30, width: 60, height: 60 };
}

// Porte literal de pointInExpandedRect (catastroxDeliverables.js:1806-1813).
function pointInExpandedRect(point, rect, padding = 0) {
  return (
    point[0] >= rect.x - padding &&
    point[0] <= rect.x + rect.width + padding &&
    point[1] >= rect.y - padding &&
    point[1] <= rect.y + rect.height + padding
  );
}

/**
 * Puerto de chooseScaleBarAnchor (catastroxDeliverables.js:1830-1866):
 * evalúa 4 posiciones candidatas para la escala gráfica (las 4 esquinas
 * interiores del recuadro del mapa) y elige la de menor puntaje de
 * colisión -- nunca una esquina fija. Puntúa: +12 por cada vértice del
 * polígono dentro del candidato (padding 10), +22 por cada punto de
 * referencia (padding 16), +28 si choca con una etiqueta/círculo ya
 * colocado (`placements`, padding 10), +18 si choca con la caja
 * delimitadora del polígono (padding 12), + un desempate mínimo por orden.
 *
 * DESVIACIÓN DOCUMENTADA frente al original: en el código aprobado,
 * `rectsOverlap(rect, polygonBounds, 12)` recibe `polygonBounds` tal como
 * lo devuelve `getPointBounds` (`{minX, minY, maxX, maxY, width, height}`),
 * pero `rectsOverlap` espera `{x, y, width, height}` -- `b.x`/`b.y` quedan
 * `undefined`, así que esa comparación es siempre `NaN`/`undefined` y el
 * término `if (rectsOverlap(...)) score += 18` termina siendo un `true`
 * constante en el navegador (SIEMPRE suma 18 a los 4 candidatos por igual,
 * nunca los diferencia -- código muerto, no una regla real). Aquí se
 * normaliza `polygonBounds` a `{x: minX, y: minY, width, height}` ANTES de
 * llamar a `rectsOverlap`, para que ese término sí evalúe una colisión real
 * contra la caja del polígono, en vez de replicar un bug inerte. El resto
 * de la función (candidatos, pesos, orden) es un puerto literal.
 */
export function chooseScaleBarAnchor(mapRect, projected, projectedRefs, placements = [], compact = false) {
  const candidates = [
    { x: mapRect.x + 18, y: mapRect.y + mapRect.height - 24 },
    { x: mapRect.x + mapRect.width - 166, y: mapRect.y + mapRect.height - 24 },
    { x: mapRect.x + 18, y: mapRect.y + 70 },
    { x: mapRect.x + mapRect.width - 166, y: mapRect.y + 70 },
  ];

  const bounds = getPointBounds(projected);
  const polygonBoundsRect = { x: bounds.minX, y: bounds.minY, width: bounds.width, height: bounds.height };
  let best = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;

  candidates.forEach((candidate, index) => {
    const rect = getScaleBarRect(candidate.x, candidate.y, compact);
    let score = 0;

    projected.forEach((point) => {
      if (pointInExpandedRect(point, rect, 10)) score += 12;
    });
    projectedRefs.forEach((point) => {
      if (pointInExpandedRect(point, rect, 16)) score += 22;
    });
    placements.forEach((placement) => {
      if (rectsOverlap(rect, placement.rect, 10)) score += 28;
    });

    if (rectsOverlap(rect, polygonBoundsRect, 12)) score += 18;
    score += index * 0.4;

    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  });

  return best;
}

export function getScaleBarRect(x, y, compact = false) {
  const boxWidth = compact ? 146 : 170;
  const boxHeight = compact ? 46 : 50;
  return { x: x - 8, y: y - 22, width: boxWidth, height: boxHeight };
}

// Mantiene el texto de cada distancia siempre legible (nunca cabeza abajo).
export function normalizeDimensionAngle(angle) {
  let next = angle;
  if (next > Math.PI / 2) next -= Math.PI;
  if (next < -Math.PI / 2) next += Math.PI;
  return next;
}

export function buildRotatedRect(centerX, centerY, width, height, angle) {
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const boundWidth = width * cos + height * sin;
  const boundHeight = width * sin + height * cos;
  return {
    x: centerX - boundWidth / 2,
    y: centerY - boundHeight / 2,
    width: boundWidth,
    height: boundHeight,
  };
}

export function ringCentroid(points) {
  if (!points.length) return [0, 0];
  const sum = points.reduce((acc, point) => [acc[0] + point[0], acc[1] + point[1]], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

/**
 * Puerto literal de buildVisiblePointPlacements (catastroxDeliverables.js:1623-1687):
 * para cada vértice proyectado, busca la posición de su círculo (ángulo +
 * distancia crecientes, en torno al vértice) que quede dentro del recuadro
 * del mapa y no choque ni con círculos ya colocados ni con `blockedRects`.
 * Si no encuentra ninguna, el vértice se marca `hidden` (nunca se dibuja
 * fuera de cualquier posición válida) -- igual que el navegador.
 */
export function buildVisiblePointPlacements(projectedPoints, mapZone, polygonPoints = [], blockedRects = []) {
  const center = polygonPoints.length ? ringCentroid(polygonPoints) : ringCentroid(projectedPoints);
  const placements = [];

  projectedPoints.forEach(([x, y]) => {
    const baseAngle = Math.atan2(y - center[1], x - center[0]);
    const angleOffsets = [0, -0.32, 0.32, -0.64, 0.64, -0.96, 0.96, -1.28, 1.28, Math.PI];
    const distanceOffsets = [18, 26, 34, 42, 52, 62, 72, 0];
    let best = null;

    for (const distance of distanceOffsets) {
      for (const angleOffset of angleOffsets) {
        const angle = baseAngle + angleOffset;
        const circleX = x + Math.cos(angle) * distance;
        const circleY = y + Math.sin(angle) * distance;
        const rect = { x: circleX - 8, y: circleY - 8, width: 16, height: 16 };
        const inside =
          rect.x >= mapZone.x + 3 &&
          rect.y >= mapZone.y + 3 &&
          rect.x + rect.width <= mapZone.x + mapZone.width - 3 &&
          rect.y + rect.height <= mapZone.y + mapZone.height - 3;
        const overlapsPoint = placements.some((placement) => rectsOverlap(rect, placement.rect, 3));
        const overlapsBlocked = blockedRects.some((blockedRect) => rectsOverlap(rect, blockedRect, 4));
        if (inside && !overlapsPoint && !overlapsBlocked) {
          best = { anchorX: x, anchorY: y, circleX, circleY, rect, showGuide: distance >= 12 };
          break;
        }
      }
      if (best) break;
    }

    if (!best) {
      best = { anchorX: x, anchorY: y, circleX: x, circleY: y, rect: { x: x - 9, y: y - 9, width: 18, height: 18 }, showGuide: false, hidden: true };
    }

    placements.push(best);
  });

  return placements;
}

/**
 * Puerto literal de buildTechnicalSegmentDimensionPlacements
 * (catastroxDeliverables.js:2792-2900): para cada tramo, evalúa una
 * grilla de candidatos (2 normales -- interior/exterior del polígono,
 * decidido con pointInPolygon, no con el signo de un producto punto -- ×
 * 3 desplazamientos normales (según longitud del tramo) × 5
 * desplazamientos a lo largo del tramo), descarta cualquiera que quede
 * fuera del recuadro del mapa o choque con un vértice, una etiqueta ya
 * colocada, o cualquiera de `reservedRects` (rosa de los vientos, escala
 * gráfica, pie de página), y se queda con el de menor puntaje (prioriza
 * desplazamiento normal pequeño, desplazamiento a lo largo pequeño,
 * exterior del polígono). Si ningún candidato es válido, el tramo se omite
 * -- nunca se dibuja una etiqueta superpuesta.
 *
 * @param {(text: string, fontSize: number) => number} measureTextWidth
 * @param {(distanceMeters: number) => string} formatDistanceLabel
 */
export function buildTechnicalSegmentDimensionPlacements({
  measureTextWidth,
  formatDistanceLabel,
  projectedRefs,
  referenceSegments,
  polygonPoints,
  pointPlacements,
  mapRect,
  reservedRects = [],
  // CATX-PDF-PARITY-002 (cierre): índices de segmento a omitir por completo
  // -- usados por linderos hídricos agrupados (catastroxPdfBoundaryAnnotations.js),
  // cuya etiqueta individual de distancia se reemplaza por una única
  // etiqueta agrupada dibujada aparte. Vacío por defecto: comportamiento
  // idéntico al puerto literal original para cualquier predio sin
  // anotaciones de lindero.
  skipSegmentIndices = null,
}) {
  const fontSize = 7.2;
  const blockedRects = [
    ...pointPlacements.filter((placement) => !placement.hidden).map((placement) => placement.rect),
    ...reservedRects,
  ];
  const placements = [];
  let omittedCount = 0;

  referenceSegments.forEach((segment, index) => {
    if (skipSegmentIndices?.has(index)) return;
    const start = projectedRefs[index];
    const end = projectedRefs[(index + 1) % projectedRefs.length];
    if (!start || !end) {
      omittedCount += 1;
      return;
    }

    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length < 10) {
      omittedCount += 1;
      return;
    }

    const text = formatDistanceLabel(segment.distance);
    const textWidth = measureTextWidth(text, fontSize);
    const textHeight = 8;
    const angle = normalizeDimensionAngle(Math.atan2(dy, dx));
    const tangent = { x: dx / length, y: dy / length };
    const normals = [
      { x: -tangent.y, y: tangent.x },
      { x: tangent.y, y: -tangent.x },
    ];
    const midpoint = { x: (start[0] + end[0]) / 2, y: (start[1] + end[1]) / 2 };
    const exteriorFirst = !pointInPolygon([midpoint.x + normals[0].x * 12, midpoint.y + normals[0].y * 12], polygonPoints);
    const orderedNormals = exteriorFirst ? normals : [normals[1], normals[0]];
    const alongOffsets = [0, -12, 12, -22, 22];
    const normalOffsets = length < 34 ? [24, 32, 40] : length < 72 ? [18, 24, 32] : [14, 20, 28];
    let best = null;

    orderedNormals.forEach((normal, normalIndex) => {
      normalOffsets.forEach((normalOffset) => {
        alongOffsets.forEach((alongOffset) => {
          const centerX = midpoint.x + tangent.x * alongOffset + normal.x * normalOffset;
          const centerY = midpoint.y + tangent.y * alongOffset + normal.y * normalOffset;
          const maskWidth = textWidth + 4;
          const maskHeight = textHeight + 2;
          const rect = buildRotatedRect(centerX, centerY, maskWidth, maskHeight, angle);
          const inside =
            rect.x >= mapRect.x + 3 &&
            rect.y >= mapRect.y + 3 &&
            rect.x + rect.width <= mapRect.x + mapRect.width - 3 &&
            rect.y + rect.height <= mapRect.y + mapRect.height - 3;
          if (!inside) return;
          if (blockedRects.some((blockedRect) => rectsOverlap(rect, blockedRect, 3))) return;
          if (placements.some((placement) => rectsOverlap(rect, placement.rect, 4))) return;

          const centerInsidePolygon = pointInPolygon([centerX, centerY], polygonPoints);
          const useGuide = normalOffset >= 20 || length < 42;
          const score = normalOffset + Math.abs(alongOffset) * 0.5 + (centerInsidePolygon ? 10 : 0) + normalIndex * 4;
          if (!best || score < best.score) {
            best = {
              text,
              angle,
              centerX,
              centerY,
              maskWidth,
              maskHeight,
              rect,
              score,
              guideLine: useGuide
                ? {
                    x1: midpoint.x + normal.x * 4,
                    y1: midpoint.y + normal.y * 4,
                    x2: centerX - normal.x * (textHeight * 0.25),
                    y2: centerY - normal.y * (textHeight * 0.25),
                  }
                : null,
            };
          }
        });
      });
    });

    if (!best) {
      omittedCount += 1;
      return;
    }

    placements.push(best);
    blockedRects.push(best.rect);
  });

  return { placements, omittedCount };
}
