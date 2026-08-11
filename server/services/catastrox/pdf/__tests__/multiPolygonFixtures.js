// R3.5: fixtures GeoJSON sintéticas para las pruebas de regresión de
// MultiPolygon + anillos interiores (huecos) del motor de PDF server-side.
// Ningún dato real de producción -- coordenadas inventadas, mismo estilo que
// SAMPLE_RING de catastroxPdfGenerator.test.js (región Caqueta, [-75, 1]).
//
// LARGE_COMPONENT_OUTER: componente grande, exterior irregular (pentágono no
// convexo simple), con un hueco interior bien contenido dentro de sus
// límites. SMALL_COMPONENT: componente pequeño, separado espacialmente del
// grande (>0.4° de distancia en longitud -- sin superposición posible).
//
// No exportamos "el orden correcto" -- exportamos ambos órdenes
// (small-first / large-first) para que las pruebas puedan demostrar
// independencia de orden explícitamente (sección 17 del encargo).

export const LARGE_COMPONENT_OUTER = [
  [-75.9, 1.11],
  [-75.891, 1.117],
  [-75.882, 1.112],
  [-75.885, 1.098],
  [-75.896, 1.096],
  [-75.9, 1.11],
];

export const LARGE_COMPONENT_HOLE = [
  [-75.892, 1.108],
  [-75.889, 1.11],
  [-75.887, 1.107],
  [-75.889, 1.104],
  [-75.892, 1.108],
];

export const SMALL_COMPONENT_OUTER = [
  [-75.4, 1.11],
  [-75.395, 1.114],
  [-75.39, 1.109],
  [-75.395, 1.104],
  [-75.4, 1.11],
];

// Polygon simple (sin huecos) -- fixture base de no-regresión: debe seguir
// produciendo exactamente 1 parte y el conteo de páginas del básico de
// siempre.
export const SIMPLE_POLYGON_GEOMETRY = Object.freeze({
  type: 'Polygon',
  coordinates: [LARGE_COMPONENT_OUTER],
});

// Polygon + hueco -- sección 14 del encargo: debe seguir siendo 1 sola
// parte/página técnica, el hueco NUNCA debe contarse como una parte
// independiente.
export const POLYGON_WITH_HOLE_GEOMETRY = Object.freeze({
  type: 'Polygon',
  coordinates: [LARGE_COMPONENT_OUTER, LARGE_COMPONENT_HOLE],
});

// MultiPolygon sin huecos, 2 componentes -- sección 15. Variantes de orden
// para la prueba de independencia de orden (sección 17): el componente
// PEQUEÑO va primero en la variante "smallFirst" -- si una implementación
// leyera solo coordinates[0], produciría el componente chico y las pruebas
// fallarían de forma inequívoca.
export const MULTIPOLYGON_NO_HOLES_SMALL_FIRST_GEOMETRY = Object.freeze({
  type: 'MultiPolygon',
  coordinates: [[SMALL_COMPONENT_OUTER], [LARGE_COMPONENT_OUTER]],
});

export const MULTIPOLYGON_NO_HOLES_LARGE_FIRST_GEOMETRY = Object.freeze({
  type: 'MultiPolygon',
  coordinates: [[LARGE_COMPONENT_OUTER], [SMALL_COMPONENT_OUTER]],
});

// MultiPolygon CON hueco en uno de sus componentes -- sección 16, la prueba
// principal de regresión. Mismo principio de orden invertido que arriba.
export const MULTIPOLYGON_WITH_HOLE_SMALL_FIRST_GEOMETRY = Object.freeze({
  type: 'MultiPolygon',
  coordinates: [[SMALL_COMPONENT_OUTER], [LARGE_COMPONENT_OUTER, LARGE_COMPONENT_HOLE]],
});

export const MULTIPOLYGON_WITH_HOLE_LARGE_FIRST_GEOMETRY = Object.freeze({
  type: 'MultiPolygon',
  coordinates: [[LARGE_COMPONENT_OUTER, LARGE_COMPONENT_HOLE], [SMALL_COMPONENT_OUTER]],
});

// Base predioData con la misma forma que resolvePredioDataForDelivery
// (server/routes/catastrox.js) -- reutilizada por todas las fixtures de
// geometría de arriba, solo cambia el campo `geometry`/`polygonGeoJson`.
export function buildMultiPolygonPredioData({ geometry, overrides = {} } = {}) {
  return {
    codigoPredial: '180940002000000020068000000000',
    codigoAnterior: 'No disponible',
    municipio: 'FLORENCIA',
    departamento: 'CAQUETA',
    nombrePredio: 'Predio de prueba MultiPolygon',
    direccionReal: 'Vereda de prueba',
    veredaDisplay: { value: 'Vereda de prueba' },
    barrioNombre: null,
    sectorCodigo: null,
    manzanaCodigo: null,
    areaM2: 1974284.19,
    areaHa: 197.428419,
    perimetroM: 12609.75,
    estadoPredial: 'ACTIVO',
    tipoZona: 'RURAL',
    destinoEconomicoNombre: 'AGROPECUARIO',
    uso1Nombre: 'PASTOS',
    uso2Nombre: null,
    uso3Nombre: null,
    numeroConstrucciones: 1,
    areaConstruidaM2: 80,
    tiposConstruccionResumen: 'Vivienda rural',
    fuente: 'catastrox_clean',
    fechaProceso: '2026-01-01',
    geometry,
    polygonGeoJson: { type: 'Feature', properties: {}, geometry },
    ...overrides,
  };
}
