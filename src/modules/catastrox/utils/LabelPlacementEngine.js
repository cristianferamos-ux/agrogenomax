// This engine decides positions for distance labels in the plan.
// It does not draw.
// It does not modify official geometry.
// It does not modify official distances.
// Its output is consumed by the PDF renderer.

import { ringCentroid } from './GeometryCore.js';

const DEFAULT_SEGMENT_CLASS_THRESHOLDS = {
  longMinPx: 120,
  mediumMinPx: 70,
  shortMinPx: 36,
};

function rectsOverlap(a, b, padding = 0) {
  return !(
    a.x + a.width + padding <= b.x ||
    b.x + b.width + padding <= a.x ||
    a.y + a.height + padding <= b.y ||
    b.y + b.height + padding <= a.y
  );
}

function pointInPolygon(point, polygon) {
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

function resolveSegmentClass(lengthPx, thresholds = DEFAULT_SEGMENT_CLASS_THRESHOLDS) {
  if (lengthPx >= thresholds.longMinPx) return 'long';
  if (lengthPx >= thresholds.mediumMinPx) return 'medium';
  if (lengthPx >= thresholds.shortMinPx) return 'short';
  return 'micro';
}

function resolveSegmentPriority(segmentClass, lengthPx) {
  const basePriorityByClass = {
    long: 400,
    medium: 300,
    short: 200,
    micro: 100,
  };
  return (basePriorityByClass[segmentClass] || 0) + Math.round(lengthPx);
}

function buildLabelModel(segment, segmentIndex, current, next, center, options) {
  const thresholds = {
    ...DEFAULT_SEGMENT_CLASS_THRESHOLDS,
    ...(options?.segmentClassThresholds || {}),
  };
  const text = `${Math.round(segment.distance)} m`;
  const textWidth = Math.max(34, text.length * 5);
  const textHeight = 14;
  const midX = (current[0] + next[0]) / 2;
  const midY = (current[1] + next[1]) / 2;
  const dx = next[0] - current[0];
  const dy = next[1] - current[1];
  const lengthPx = Math.hypot(dx, dy) || 1;
  const segmentClass = resolveSegmentClass(lengthPx, thresholds);
  let nx = -dy / lengthPx;
  let ny = dx / lengthPx;
  const toCenterX = midX - center[0];
  const toCenterY = midY - center[1];
  if (nx * toCenterX + ny * toCenterY < 0) {
    nx *= -1;
    ny *= -1;
  }

  return {
    segment,
    segmentIndex,
    current,
    next,
    text,
    textWidth,
    textHeight,
    midX,
    midY,
    dx,
    dy,
    lengthPx,
    segmentClass,
    placementMode: 'offset',
    collisionScore: 0,
    priority: resolveSegmentPriority(segmentClass, lengthPx),
    status: 'pending',
    hiddenReason: null,
    guideLine: null,
    rotationDeg: 0,
    normal: [nx, ny],
  };
}

export function buildDistanceLabelPlacements(projectedRefs, referenceSegments, mapZone, polygonPoints = [], blockedRects = []) {
  if (!projectedRefs.length) {
    const emptyPlacements = [];
    emptyPlacements.auditReport = {
      totalRequested: referenceSegments.length,
      totalPlaced: 0,
      totalHidden: referenceSegments.length,
      placedInline: 0,
      placedOffset: 0,
      placedWithGuide: 0,
      shortSegmentsDetected: 0,
      microSegmentsDetected: 0,
      collisionsDetected: 0,
      collisionsResolved: 0,
      warnings: referenceSegments.length ? ['no_projected_reference_points'] : [],
    };
    return emptyPlacements;
  }

  const options = arguments[5] || {};
  const center = polygonPoints.length ? ringCentroid(polygonPoints) : ringCentroid(projectedRefs);
  const placements = [];
  const auditReport = {
    totalRequested: referenceSegments.length,
    totalPlaced: 0,
    totalHidden: 0,
    placedInline: 0,
    placedOffset: 0,
    placedWithGuide: 0,
    shortSegmentsDetected: 0,
    microSegmentsDetected: 0,
    collisionsDetected: 0,
    collisionsResolved: 0,
    warnings: [],
  };

  referenceSegments.forEach((segment, index) => {
    const current = projectedRefs[index];
    const next = projectedRefs[(index + 1) % projectedRefs.length];
    if (!current || !next) return;

    const model = buildLabelModel(segment, index, current, next, center, options);
    const { text, textWidth, textHeight, midX, midY, segmentClass, lengthPx, priority } = model;
    let [nx, ny] = model.normal;

    if (segmentClass === 'short') auditReport.shortSegmentsDetected += 1;
    if (segmentClass === 'micro') auditReport.microSegmentsDetected += 1;

    let offset = 34;
    let best = null;
    let collisionDetectedForSegment = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const radialMagnitude = Math.hypot(midX - center[0], midY - center[1]) || 1;
      const candidateNormals = [
        [nx, ny],
        [
          nx * 0.88 + ((midX - center[0]) / radialMagnitude) * 0.12,
          ny * 0.88 + ((midY - center[1]) / radialMagnitude) * 0.12,
        ],
      ];
      for (const [dirX, dirY] of candidateNormals) {
        const mag = Math.hypot(dirX, dirY) || 1;
        const ux = dirX / mag;
        const uy = dirY / mag;
        const labelCenterX = midX + ux * offset;
        const labelCenterY = midY + uy * offset;
        const rect = {
          x: labelCenterX - textWidth / 2,
          y: labelCenterY - textHeight / 2,
          width: textWidth,
          height: textHeight,
        };
        const inside =
          rect.x >= mapZone.x &&
          rect.y >= mapZone.y &&
          rect.x + rect.width <= mapZone.x + mapZone.width &&
          rect.y + rect.height <= mapZone.y + mapZone.height;
        const overlapsPlacements = placements.some((entry) => rectsOverlap(rect, entry.rect, 6));
        const overlapsBlocked = blockedRects.some((blockedRect) => rectsOverlap(rect, blockedRect, 6));
        const collides = overlapsPlacements || overlapsBlocked;
        const outsidePolygon = !pointInPolygon([labelCenterX, labelCenterY], polygonPoints);
        if (collides) {
          collisionDetectedForSegment = true;
        }
        if (inside && !collides && outsidePolygon) {
          best = {
            rect,
            labelCenterX,
            labelCenterY,
            collisionScore: collides ? 1 : 0,
          };
          break;
        }
      }
      if (best) break;
      offset += 18;
    }

    if (best) {
      if (collisionDetectedForSegment) {
        auditReport.collisionsDetected += 1;
        auditReport.collisionsResolved += 1;
      }
      placements.push({
        text,
        midX,
        midY,
        labelCenterX: best.labelCenterX,
        labelCenterY: best.labelCenterY,
        rect: best.rect,
        segmentIndex: index,
        lengthPx,
        segmentClass,
        placementMode: 'offset',
        collisionScore: best.collisionScore,
        priority,
        status: 'placed',
        hiddenReason: null,
        guideLine: null,
        rotationDeg: 0,
      });
      auditReport.totalPlaced += 1;
      auditReport.placedOffset += 1;
    } else {
      if (collisionDetectedForSegment) {
        auditReport.collisionsDetected += 1;
      }
      auditReport.totalHidden += 1;
    }
  });

  if (auditReport.totalHidden > 0) {
    auditReport.warnings.push('unplaced_distance_labels');
  }

  placements.auditReport = auditReport;

  return placements;
}
