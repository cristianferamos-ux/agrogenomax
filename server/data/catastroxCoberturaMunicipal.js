export const CATASTROX_COVERAGE_STATUS = {
  CUBIERTO_IGAC: 'CUBIERTO_IGAC',
  GESTOR_DIFERENTE: 'GESTOR_DIFERENTE',
  NO_CARGADO: 'NO_CARGADO',
  PENDIENTE_VALIDACION: 'PENDIENTE_VALIDACION',
};

const coberturaMunicipal = {
  '18029': {
    codigoMunicipio: '18029',
    municipio: 'Albania',
    departamento: 'Caqueta',
    gestorCatastral: 'IGAC',
    estadoCobertura: CATASTROX_COVERAGE_STATUS.CUBIERTO_IGAC,
    heuristicBounds: {
      minLat: 1.18,
      maxLat: 1.47,
      minLng: -76.05,
      maxLng: -75.72,
    },
  },
  '18001': {
    codigoMunicipio: '18001',
    municipio: 'Florencia',
    departamento: 'Caqueta',
    gestorCatastral: 'Gestor catastral diferente al IGAC',
    estadoCobertura: CATASTROX_COVERAGE_STATUS.GESTOR_DIFERENTE,
    heuristicBounds: {
      minLat: 1.45,
      maxLat: 1.75,
      minLng: -75.78,
      maxLng: -75.48,
    },
  },
};

function isInsideBounds(lat, lng, bounds) {
  if (!bounds) return false;

  return (
    lat >= bounds.minLat &&
    lat <= bounds.maxLat &&
    lng >= bounds.minLng &&
    lng <= bounds.maxLng
  );
}

export function getMunicipalCoverageByCode(codigoMunicipio) {
  if (!codigoMunicipio) return null;
  return coberturaMunicipal[String(codigoMunicipio)] || null;
}

export function estimateMunicipalCoverageByPoint(lat, lng) {
  for (const coverage of Object.values(coberturaMunicipal)) {
    if (isInsideBounds(lat, lng, coverage.heuristicBounds)) {
      return coverage;
    }
  }

  return {
    codigoMunicipio: null,
    municipio: null,
    departamento: 'Caqueta',
    gestorCatastral: null,
    estadoCobertura: CATASTROX_COVERAGE_STATUS.PENDIENTE_VALIDACION,
  };
}
