import { haversineMeters } from './GeometryCore.js';

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
