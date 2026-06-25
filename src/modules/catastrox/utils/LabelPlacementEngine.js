// This engine decides positions for distance labels in the plan.
// It does not draw.
// It does not modify official geometry.
// It does not modify official distances.
// Its output is consumed by the PDF renderer.

import { ringCentroid } from './GeometryCore.js';

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

export function buildDistanceLabelPlacements(projectedRefs, referenceSegments, mapZone, polygonPoints = [], blockedRects = []) {
  if (!projectedRefs.length) return [];
  const center = polygonPoints.length ? ringCentroid(polygonPoints) : ringCentroid(projectedRefs);
  const placements = [];

  referenceSegments.forEach((segment, index) => {
    const current = projectedRefs[index];
    const next = projectedRefs[(index + 1) % projectedRefs.length];
    if (!current || !next) return;

    const text = `${Math.round(segment.distance)} m`;
    const textWidth = Math.max(34, text.length * 5);
    const textHeight = 14;
    const midX = (current[0] + next[0]) / 2;
    const midY = (current[1] + next[1]) / 2;
    const dx = next[0] - current[0];
    const dy = next[1] - current[1];
    const segmentLength = Math.hypot(dx, dy) || 1;
    let nx = -dy / segmentLength;
    let ny = dx / segmentLength;
    const toCenterX = midX - center[0];
    const toCenterY = midY - center[1];
    if (nx * toCenterX + ny * toCenterY < 0) {
      nx *= -1;
      ny *= -1;
    }

    let offset = 34;
    let best = null;
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
        const collides =
          placements.some((entry) => rectsOverlap(rect, entry.rect, 6)) ||
          blockedRects.some((blockedRect) => rectsOverlap(rect, blockedRect, 6));
        const outsidePolygon = !pointInPolygon([labelCenterX, labelCenterY], polygonPoints);
        if (inside && !collides && outsidePolygon) {
          best = { rect, labelCenterX, labelCenterY };
          break;
        }
      }
      if (best) break;
      offset += 18;
    }

    if (best) {
      placements.push({
        text,
        midX,
        midY,
        labelCenterX: best.labelCenterX,
        labelCenterY: best.labelCenterY,
        rect: best.rect,
      });
    }
  });

  return placements;
}
