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
