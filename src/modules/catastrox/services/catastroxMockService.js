import { catastroxPredios } from '../data/catastroxMockData.js';

function parseCoordinate(value, fallback = 0) {
  const parsed = Number.parseFloat(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function distanceBetweenPoints(latA, lngA, latB, lngB) {
  const latDiff = latA - latB;
  const lngDiff = lngA - lngB;
  return Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
}

export function getCatastroxResultById(id) {
  return catastroxPredios.find((predio) => predio.id === id) || catastroxPredios[0];
}

export function lookupPredioMock({ lat, lng }) {
  const parsedLat = parseCoordinate(lat, catastroxPredios[0].referencePoint.lat);
  const parsedLng = parseCoordinate(lng, catastroxPredios[0].referencePoint.lng);

  const sorted = [...catastroxPredios].sort((left, right) => {
    const leftDistance = distanceBetweenPoints(
      parsedLat,
      parsedLng,
      left.referencePoint.lat,
      left.referencePoint.lng,
    );
    const rightDistance = distanceBetweenPoints(
      parsedLat,
      parsedLng,
      right.referencePoint.lat,
      right.referencePoint.lng,
    );
    return leftDistance - rightDistance;
  });

  return sorted[0];
}

export function calculateRegularizationCost(areaHa) {
  const area = Math.max(0, parseCoordinate(areaHa, 0));

  let subtotal = 3000000;
  if (area > 20 && area <= 100) {
    subtotal = 3000000 + (area - 20) * 50000;
  } else if (area > 100) {
    subtotal = 7000000 + (area - 100) * 30000;
  }

  const iva = subtotal * 0.19;
  const total = subtotal + iva;

  return {
    area,
    subtotal,
    iva,
    total,
    formula:
      area <= 20
        ? 'Hasta 20 ha: base fija de $3.000.000.'
        : area <= 100
          ? 'De 20 a 100 ha: $3.000.000 + $50.000 por cada ha adicional sobre 20.'
          : 'Mas de 100 ha: $7.000.000 + $30.000 por cada ha adicional sobre 100.',
  };
}

export async function createLeadMock(payload) {
  return {
    ok: true,
    leadId: `CX-LEAD-${Date.now()}`,
    createdAt: new Date().toISOString(),
    payload: {
      ...payload,
      areaEstimada: parseCoordinate(payload.areaEstimada, 0),
    },
  };
}
