import {
  cumulativeDistances,
  getPointBounds,
  getRingBounds,
  haversineMeters,
  perpendicularDistanceMeters,
  projectRingToLocalMeters,
  ringCentroid,
  ringDistanceForward,
  simplifyRingIndices,
  turnDegrees,
} from './GeometryCore.js';

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
