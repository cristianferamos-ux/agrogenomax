import {
  getPointBounds,
  getRingBounds,
  normalizeRing,
  perpendicularDistanceMeters,
  projectRingToLocalMeters,
  simplifyRingIndices,
  turnDegrees,
} from './GeometryCore.js';

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
