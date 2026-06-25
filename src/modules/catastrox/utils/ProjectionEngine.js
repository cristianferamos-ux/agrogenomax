import { getRingBounds } from './GeometryCore.js';

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

export function createFitTransform(points, box, padding = 20) {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const usableWidth = Math.max(40, box.width - padding * 2);
  const usableHeight = Math.max(40, box.height - padding * 2);
  const scale = Math.min(usableWidth / spanX, usableHeight / spanY);
  const offsetX = box.x + (box.width - spanX * scale) / 2;
  const offsetY = box.y + (box.height - spanY * scale) / 2;
  return { minX, minY, scale, offsetX, offsetY };
}

export function applyFitTransform(points, transform) {
  return points.map(([x, y]) => [
    transform.offsetX + (x - transform.minX) * transform.scale,
    transform.offsetY + (y - transform.minY) * transform.scale,
  ]);
}

export function buildVisiblePointProjection(referencePoints, mapState, zone) {
  return referencePoints.map((entry) => {
    const point = entry.point || entry;
    const [vx, vy] = projectPointToViewport(point, mapState, zone.width, zone.height);
    return [zone.x + vx, zone.y + vy];
  });
}
