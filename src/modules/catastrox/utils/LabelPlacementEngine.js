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
const GUIDE_LINE_MIN_CENTER_DISPLACEMENT_PX = 40;
const DEFAULT_EDGE_FALLBACK_RADII = [48, 64, 80, 88, 96];
const DEFAULT_EDGE_FALLBACK_ANGLE_OFFSETS = [0, -15, 15, -30, 30, -45, 45, -60, 60, -75, 75, -90, 90, -120, 120, -150, 150, 180];

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

function normalizeAngleDegrees(angle) {
  const normalized = angle % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function determineNearestMapEdge(midX, midY, mapZone) {
  const distances = {
    left: Math.abs(midX - mapZone.x),
    right: Math.abs(mapZone.x + mapZone.width - midX),
    top: Math.abs(midY - mapZone.y),
    bottom: Math.abs(mapZone.y + mapZone.height - midY),
  };
  return Object.entries(distances).sort((a, b) => a[1] - b[1])[0]?.[0] || 'right';
}

function buildEdgeFallbackAngles(midX, midY, mapZone, center, options = {}) {
  const nearestEdge = determineNearestMapEdge(midX, midY, mapZone);
  const inwardBaseAngles = {
    left: 0,
    right: 180,
    top: 90,
    bottom: 270,
  };
  const edgeBaseAngle = inwardBaseAngles[nearestEdge] ?? 180;
  const offsets = options.edgeFallbackAngleOffsets || DEFAULT_EDGE_FALLBACK_ANGLE_OFFSETS;
  const mapCenterX = mapZone.x + mapZone.width / 2;
  const mapCenterY = mapZone.y + mapZone.height / 2;
  const mapCenterAngle = normalizeAngleDegrees((Math.atan2(mapCenterY - midY, mapCenterX - midX) * 180) / Math.PI);
  const polygonCenterAngle = normalizeAngleDegrees((Math.atan2(center[1] - midY, center[0] - midX) * 180) / Math.PI);
  const angleSet = new Set();
  const orderedAngles = [];

  const pushAngle = (angle) => {
    const normalized = normalizeAngleDegrees(angle);
    if (!angleSet.has(normalized)) {
      angleSet.add(normalized);
      orderedAngles.push(normalized);
    }
  };

  pushAngle(edgeBaseAngle);
  pushAngle(mapCenterAngle);
  pushAngle(polygonCenterAngle);
  offsets.forEach((offset) => pushAngle(edgeBaseAngle + offset));
  offsets.forEach((offset) => pushAngle(mapCenterAngle + offset));
  offsets.forEach((offset) => pushAngle(polygonCenterAngle + offset));

  return orderedAngles;
}

function evaluateLabelCandidate({
  textWidth,
  textHeight,
  labelCenterX,
  labelCenterY,
  mapZone,
  polygonPoints,
  placements,
  blockedRects,
  radius = 0,
  candidateStrategy = 'primary-offset',
}) {
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
  const overlapsPlacements = placements.filter((entry) => rectsOverlap(rect, entry.rect, 6));
  const overlapsBlocked = blockedRects.filter((blockedRect) => rectsOverlap(rect, blockedRect, 6));
  const outsidePolygon = !pointInPolygon([labelCenterX, labelCenterY], polygonPoints);
  const collisionScore =
    (inside ? 0 : 1000) +
    overlapsPlacements.length * 200 +
    overlapsBlocked.length * 200 +
    (outsidePolygon ? 0 : 50) +
    radius;

  return {
    rect,
    labelCenterX,
    labelCenterY,
    inside,
    overlapsPlacements,
    overlapsBlocked,
    outsidePolygon,
    collisionScore,
    candidateStrategy,
    radius,
  };
}

function shouldTryEdgeFallback(baseAttemptStats) {
  return (
    baseAttemptStats.outsideMapFailures > 0 &&
    baseAttemptStats.outsideMapFailures >= baseAttemptStats.insidePolygonFailures &&
    baseAttemptStats.outsideMapFailures >= baseAttemptStats.collisionFailures
  );
}

function buildEdgeAngularFallbackCandidate({
  model,
  center,
  mapZone,
  polygonPoints,
  placements,
  blockedRects,
  options = {},
}) {
  const radii = options.edgeFallbackRadii || DEFAULT_EDGE_FALLBACK_RADII;
  const angles = buildEdgeFallbackAngles(model.midX, model.midY, mapZone, center, options);
  let bestCandidate = null;

  for (const angle of angles) {
    const radians = (angle * Math.PI) / 180;
    for (const radius of radii) {
      const labelCenterX = model.midX + Math.cos(radians) * radius;
      const labelCenterY = model.midY + Math.sin(radians) * radius;
      const candidate = evaluateLabelCandidate({
        textWidth: model.textWidth,
        textHeight: model.textHeight,
        labelCenterX,
        labelCenterY,
        mapZone,
        polygonPoints,
        placements,
        blockedRects,
        radius,
        candidateStrategy: 'edge-angular-fallback',
      });

      if (!candidate.inside) continue;
      if (candidate.overlapsPlacements.length || candidate.overlapsBlocked.length) continue;

      if (
        !bestCandidate ||
        candidate.collisionScore < bestCandidate.collisionScore ||
        (candidate.collisionScore === bestCandidate.collisionScore &&
          candidate.outsidePolygon &&
          !bestCandidate.outsidePolygon)
      ) {
        bestCandidate = {
          ...candidate,
          angleDeg: angle,
        };
      }
    }
  }

  return bestCandidate;
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

function isValidRect(rect) {
  return !!(
    rect &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function bumpGuideLineReason(auditReport, reason) {
  if (!reason) return;
  auditReport.guideLineReasons[reason] = (auditReport.guideLineReasons[reason] || 0) + 1;
}

function shouldSuggestGuideLine(model, placement, options = {}) {
  if (!model || !placement || placement.status === 'hidden') return false;
  if (placement.candidateStrategy !== 'edge-angular-fallback') return false;
  if (model.segmentClass !== 'short' && model.segmentClass !== 'micro') return false;

  const dx = (placement.labelCenterX ?? 0) - model.midX;
  const dy = (placement.labelCenterY ?? 0) - model.midY;
  const displacementPx = Math.hypot(dx, dy);

  return displacementPx > GUIDE_LINE_MIN_CENTER_DISPLACEMENT_PX;
}

function buildGuideLineForPlacement(model, placement, options = {}) {
  if (!model || !placement || placement.status === 'hidden') {
    return {
      guideLine: null,
      skipped: true,
      reason: 'hidden',
    };
  }
  if (!isValidRect(placement.rect)) {
    return {
      guideLine: null,
      skipped: true,
      reason: 'invalid-rect',
    };
  }

  const anchorOnSegment = {
    x: model.midX,
    y: model.midY,
  };
  const anchorOnLabel = {
    x: clamp(anchorOnSegment.x, placement.rect.x, placement.rect.x + placement.rect.width),
    y: clamp(anchorOnSegment.y, placement.rect.y, placement.rect.y + placement.rect.height),
  };
  const lengthPx = Math.hypot(
    anchorOnLabel.x - anchorOnSegment.x,
    anchorOnLabel.y - anchorOnSegment.y
  );

  if (lengthPx < 10) {
    return {
      guideLine: null,
      skipped: true,
      reason: 'too-short',
    };
  }
  if (lengthPx > 110) {
    return {
      guideLine: null,
      skipped: true,
      reason: 'too-long',
    };
  }

  const reason = `${placement.candidateStrategy}-${model.segmentClass}-displaced`;
  return {
    guideLine: {
      x1: anchorOnSegment.x,
      y1: anchorOnSegment.y,
      x2: anchorOnLabel.x,
      y2: anchorOnLabel.y,
      anchorOnSegment,
      anchorOnLabel,
      reason,
      lengthPx,
      auditOnly: true,
      rendered: false,
    },
    skipped: false,
    reason,
  };
}

export function buildDistanceLabelPlacements(projectedRefs, referenceSegments, mapZone, polygonPoints = [], blockedRects = [], options = {}) {
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
      guideLinesSuggested: 0,
      guideLinesRendered: 0,
      guideLinesSkipped: 0,
      guideLineReasons: {},
      warnings: referenceSegments.length ? ['no_projected_reference_points'] : [],
    };
    return emptyPlacements;
  }
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
    edgeFallbacksApplied: 0,
    outsideMapRecoveries: 0,
    guideLinesSuggested: 0,
    guideLinesRendered: 0,
    guideLinesSkipped: 0,
    guideLineReasons: {},
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
    const baseAttemptStats = {
      outsideMapFailures: 0,
      insidePolygonFailures: 0,
      collisionFailures: 0,
    };
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
        const candidate = evaluateLabelCandidate({
          textWidth,
          textHeight,
          labelCenterX,
          labelCenterY,
          mapZone,
          polygonPoints,
          placements,
          blockedRects,
          radius: offset,
        });
        const collides = candidate.overlapsPlacements.length > 0 || candidate.overlapsBlocked.length > 0;
        if (!candidate.inside) {
          baseAttemptStats.outsideMapFailures += 1;
        }
        if (!candidate.outsidePolygon) {
          baseAttemptStats.insidePolygonFailures += 1;
        }
        if (collides) {
          collisionDetectedForSegment = true;
          baseAttemptStats.collisionFailures += 1;
        }
        if (candidate.inside && !collides && candidate.outsidePolygon) {
          best = {
            rect: candidate.rect,
            labelCenterX: candidate.labelCenterX,
            labelCenterY: candidate.labelCenterY,
            collisionScore: candidate.collisionScore,
            candidateStrategy: candidate.candidateStrategy,
          };
          break;
        }
      }
      if (best) break;
      offset += 18;
    }

    if (!best && shouldTryEdgeFallback(baseAttemptStats)) {
      const fallbackCandidate = buildEdgeAngularFallbackCandidate({
        model,
        center,
        mapZone,
        polygonPoints,
        placements,
        blockedRects,
        options,
      });
      if (fallbackCandidate) {
        best = {
          rect: fallbackCandidate.rect,
          labelCenterX: fallbackCandidate.labelCenterX,
          labelCenterY: fallbackCandidate.labelCenterY,
          collisionScore: fallbackCandidate.collisionScore,
          candidateStrategy: fallbackCandidate.candidateStrategy,
        };
        auditReport.edgeFallbacksApplied += 1;
        auditReport.outsideMapRecoveries += 1;
      }
    }

    if (best) {
      const placement = {
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
        candidateStrategy: best.candidateStrategy || 'primary-offset',
      };

      if (shouldSuggestGuideLine(model, placement, options)) {
        const guideLineResult = buildGuideLineForPlacement(model, placement, options);
        if (guideLineResult.skipped) {
          auditReport.guideLinesSkipped += 1;
          bumpGuideLineReason(auditReport, guideLineResult.reason);
        } else {
          placement.guideLine = guideLineResult.guideLine;
          auditReport.guideLinesSuggested += 1;
          bumpGuideLineReason(auditReport, guideLineResult.reason);
        }
      }

      if (collisionDetectedForSegment) {
        auditReport.collisionsDetected += 1;
        auditReport.collisionsResolved += 1;
      }
      placements.push(placement);
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
