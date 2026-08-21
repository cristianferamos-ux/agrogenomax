// SPRINT-3D5.2-OPERATIONAL-SPATIAL-TOLERANCE (ajuste final de umbrales):
// pruebas puras (sin DB) de decideToleranceStatus/validateGpsAccuracyList/
// gpsToleranceFromAccuracy -- la parte que SÍ habla con PostGIS real
// (computeCoverageMetrics) se prueba en
// server/services/__tests__/potrerosRepositoryIntegration.test.js contra
// un Postgres/PostGIS desechable real (ver db/agx-business/migrations/README.md).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOLERANCE_STATUS,
  TOLERANCE_KML_KMZ,
  TOLERANCE_COORDENADAS,
  GPS_MAX_ACCURACY_M,
  GPS_FALLBACK_NO_ACCURACY,
  gpsToleranceFromAccuracy,
  decideToleranceStatus,
  validateGpsAccuracyList,
} from '../potreroSpatialTolerance.js';

describe('decideToleranceStatus: covered_by=true siempre STRICT_OK sin importar el método', () => {
  test('STRICT_OK para coordenadas/kml/kmz/gps_movil', () => {
    for (const metodoDelimitacion of ['coordenadas', 'kml', 'kmz', 'gps_movil']) {
      const result = decideToleranceStatus({
        coveredBy: true,
        areaTotalM2: 100,
        porcentajeFuera: 0,
        distanciaMaximaFueraM: 0,
        metodoDelimitacion,
      });
      assert.equal(result.status, TOLERANCE_STATUS.STRICT_OK);
      assert.equal(result.toleranceApplied, null);
    }
  });
});

// ---------------------------------------------------------------------
// KML/KMZ -- §2: distancia<=1.0m Y porcentaje<=0.25%.
// ---------------------------------------------------------------------
describe('decideToleranceStatus: KML/KMZ (distancia<=1.0m Y porcentaje<=0.25%)', () => {
  test('0.5 m fuera + porcentaje pequeño -> TOLERANCE_OK', () => {
    const result = decideToleranceStatus({
      coveredBy: false,
      areaTotalM2: 200000, // predio grande -> 0.5m de franja pesa poco en %
      porcentajeFuera: 0.05,
      distanciaMaximaFueraM: 0.5,
      metodoDelimitacion: 'kml',
    });
    assert.equal(result.status, TOLERANCE_STATUS.TOLERANCE_OK);
    assert.equal(result.toleranceApplied.kind, 'kml_kmz');
  });

  test('justo <= 1.0 m (límite inclusive) con porcentaje que cumple -> TOLERANCE_OK', () => {
    const result = decideToleranceStatus({
      coveredBy: false,
      areaTotalM2: 200000,
      porcentajeFuera: 0.1,
      distanciaMaximaFueraM: TOLERANCE_KML_KMZ.distanciaMaximaFueraMaxM,
      metodoDelimitacion: 'kmz',
    });
    assert.equal(result.status, TOLERANCE_STATUS.TOLERANCE_OK);
  });

  test('justo > 1.0 m -> OUTSIDE aunque el porcentaje sea mínimo', () => {
    const result = decideToleranceStatus({
      coveredBy: false,
      areaTotalM2: 200000,
      porcentajeFuera: 0.05,
      distanciaMaximaFueraM: TOLERANCE_KML_KMZ.distanciaMaximaFueraMaxM + 0.01,
      metodoDelimitacion: 'kml',
    });
    assert.equal(result.status, TOLERANCE_STATUS.OUTSIDE);
  });

  test('porcentaje > 0.25% -> OUTSIDE aunque distancia <= 1 m', () => {
    const result = decideToleranceStatus({
      coveredBy: false,
      areaTotalM2: 100,
      porcentajeFuera: 0.3,
      distanciaMaximaFueraM: 0.3,
      metodoDelimitacion: 'kml',
    });
    assert.equal(result.status, TOLERANCE_STATUS.OUTSIDE);
  });

  test('exactamente en el umbral de porcentaje (<=0.25%) -> TOLERANCE_OK', () => {
    const result = decideToleranceStatus({
      coveredBy: false,
      areaTotalM2: 100,
      porcentajeFuera: TOLERANCE_KML_KMZ.porcentajeFueraMax,
      distanciaMaximaFueraM: 0.3,
      metodoDelimitacion: 'kmz',
    });
    assert.equal(result.status, TOLERANCE_STATUS.TOLERANCE_OK);
  });

  test('area_fuera_m2 NUNCA es hard gate para KML/KMZ -- un área grande con % y distancia pequeños sigue TOLERANCE_OK', () => {
    // Predio gigantesco: 5000 m2 de excedente es enorme en términos
    // absolutos, pero solo 0.05% de un predio de 10.000.000 m2 (1000 ha).
    const result = decideToleranceStatus({
      coveredBy: false,
      areaTotalM2: 10_000_000,
      porcentajeFuera: 0.05,
      distanciaMaximaFueraM: 0.8,
      metodoDelimitacion: 'kml',
    });
    assert.equal(result.status, TOLERANCE_STATUS.TOLERANCE_OK);
  });
});

// ---------------------------------------------------------------------
// COORDENADAS -- §2: distancia<=3.0m Y porcentaje<=0.5%.
// ---------------------------------------------------------------------
describe('decideToleranceStatus: coordenadas (distancia<=3.0m Y porcentaje<=0.5%, margen mayor que KML/KMZ)', () => {
  test('<= 3 m y <= 0.5% -> TOLERANCE_OK', () => {
    const result = decideToleranceStatus({
      coveredBy: false,
      areaTotalM2: 200000,
      porcentajeFuera: 0.15,
      distanciaMaximaFueraM: 3.0,
      metodoDelimitacion: 'coordenadas',
    });
    assert.equal(result.status, TOLERANCE_STATUS.TOLERANCE_OK);
    assert.equal(result.toleranceApplied.kind, 'coordenadas');
  });

  test('> 3 m -> OUTSIDE', () => {
    const result = decideToleranceStatus({
      coveredBy: false,
      areaTotalM2: 200000,
      porcentajeFuera: 0.15,
      distanciaMaximaFueraM: 3.01,
      metodoDelimitacion: 'coordenadas',
    });
    assert.equal(result.status, TOLERANCE_STATUS.OUTSIDE);
  });

  test('> 0.5% -> OUTSIDE aunque la distancia cumpla', () => {
    const result = decideToleranceStatus({
      coveredBy: false,
      areaTotalM2: 100,
      porcentajeFuera: 0.6,
      distanciaMaximaFueraM: 0.6,
      metodoDelimitacion: 'coordenadas',
    });
    assert.equal(result.status, TOLERANCE_STATUS.OUTSIDE);
  });

  test('mismo caso límite (1 m fuera, % ínfimo) es OUTSIDE para KML pero TOLERANCE_OK para coordenadas -- métodos con margen distinto', () => {
    const shared = { coveredBy: false, areaTotalM2: 200000, porcentajeFuera: 0.05, distanciaMaximaFueraM: 1.5 };
    assert.equal(decideToleranceStatus({ ...shared, metodoDelimitacion: 'kml' }).status, TOLERANCE_STATUS.OUTSIDE);
    assert.equal(decideToleranceStatus({ ...shared, metodoDelimitacion: 'coordenadas' }).status, TOLERANCE_STATUS.TOLERANCE_OK);
  });
});

// ---------------------------------------------------------------------
// Casos de control generales (completamente fuera -- cualquier método).
// ---------------------------------------------------------------------
describe('decideToleranceStatus: geometría completamente fuera -> siempre OUTSIDE', () => {
  test('100% fuera, distancia grande -> OUTSIDE para cualquier método', () => {
    for (const metodoDelimitacion of ['coordenadas', 'kml', 'kmz', 'gps_movil']) {
      const result = decideToleranceStatus({
        coveredBy: false,
        areaTotalM2: 5000,
        porcentajeFuera: 100,
        distanciaMaximaFueraM: 500,
        metodoDelimitacion,
        gpsAccuracyMaxM: 10,
      });
      assert.equal(result.status, TOLERANCE_STATUS.OUTSIDE);
    }
  });
});

describe('decideToleranceStatus: gps_movil -- §8', () => {
  test('con accuracy confirmada baja (5m) -> distanciaMaximaFueraMaxM=5, dentro -> TOLERANCE_OK', () => {
    const result = decideToleranceStatus({
      coveredBy: false,
      areaTotalM2: 5000,
      porcentajeFuera: 0.2,
      distanciaMaximaFueraM: 4.9,
      metodoDelimitacion: 'gps_movil',
      gpsAccuracyMaxM: 5,
    });
    assert.equal(result.status, TOLERANCE_STATUS.TOLERANCE_OK);
    assert.equal(result.toleranceApplied.distanciaMaximaFueraMaxM, 5);
  });

  test('con accuracy alta (90m) el margen de distancia queda acotado a 10m (min(maxAccuracy,10)), nunca 90m', () => {
    const result = decideToleranceStatus({
      coveredBy: false,
      areaTotalM2: 5000,
      porcentajeFuera: 0.2,
      distanciaMaximaFueraM: 15,
      metodoDelimitacion: 'gps_movil',
      gpsAccuracyMaxM: 90,
    });
    assert.equal(result.toleranceApplied.distanciaMaximaFueraMaxM, 10);
    assert.equal(result.status, TOLERANCE_STATUS.OUTSIDE); // 15 > 10
  });

  test('sin accuracy (null) aplica GPS_FALLBACK_NO_ACCURACY -- más estricto que el mejor caso con accuracy', () => {
    const result = decideToleranceStatus({
      coveredBy: false,
      areaTotalM2: 5000,
      porcentajeFuera: 0.2,
      distanciaMaximaFueraM: 6,
      metodoDelimitacion: 'gps_movil',
      gpsAccuracyMaxM: null,
    });
    assert.equal(result.toleranceApplied.kind, 'gps_fallback');
    assert.deepEqual(
      { porcentajeFueraMax: result.toleranceApplied.porcentajeFueraMax, distanciaMaximaFueraMaxM: result.toleranceApplied.distanciaMaximaFueraMaxM },
      GPS_FALLBACK_NO_ACCURACY,
    );
    assert.equal(result.status, TOLERANCE_STATUS.OUTSIDE); // 6 > 5
  });

  test('sin accuracy, distancia dentro del fallback -> TOLERANCE_OK', () => {
    const result = decideToleranceStatus({
      coveredBy: false,
      areaTotalM2: 5000,
      porcentajeFuera: 0.1,
      distanciaMaximaFueraM: 4,
      metodoDelimitacion: 'gps_movil',
      gpsAccuracyMaxM: null,
    });
    assert.equal(result.status, TOLERANCE_STATUS.TOLERANCE_OK);
  });

  test('porcentaje fuera > 1% -> OUTSIDE aunque la distancia cumpla el cap de accuracy (§5 nuevo)', () => {
    const result = decideToleranceStatus({
      coveredBy: false,
      areaTotalM2: 100,
      porcentajeFuera: 2,
      distanciaMaximaFueraM: 1,
      metodoDelimitacion: 'gps_movil',
      gpsAccuracyMaxM: 8,
    });
    assert.equal(result.status, TOLERANCE_STATUS.OUTSIDE);
  });

  test('exactamente en el umbral de porcentaje GPS con accuracy (<=1%) -> TOLERANCE_OK', () => {
    const result = decideToleranceStatus({
      coveredBy: false,
      areaTotalM2: 1000,
      porcentajeFuera: 1,
      distanciaMaximaFueraM: 5,
      metodoDelimitacion: 'gps_movil',
      gpsAccuracyMaxM: 8,
    });
    assert.equal(result.status, TOLERANCE_STATUS.TOLERANCE_OK);
  });
});

describe('decideToleranceStatus: guarda areaTotalM2 <= 0 (§4)', () => {
  test('lanza INVALID_POTRERO_GEOMETRY si areaTotalM2 es 0', () => {
    assert.throws(
      () =>
        decideToleranceStatus({
          coveredBy: false,
          areaTotalM2: 0,
          porcentajeFuera: 0,
          distanciaMaximaFueraM: 0,
          metodoDelimitacion: 'kml',
        }),
      (error) => error.status === 422 && error.code === 'INVALID_POTRERO_GEOMETRY',
    );
  });
});

describe('gpsToleranceFromAccuracy', () => {
  test('acota siempre a un máximo absoluto de 10 m', () => {
    assert.equal(gpsToleranceFromAccuracy(3).distanciaMaximaFueraMaxM, 3);
    assert.equal(gpsToleranceFromAccuracy(10).distanciaMaximaFueraMaxM, 10);
    assert.equal(gpsToleranceFromAccuracy(100).distanciaMaximaFueraMaxM, 10);
  });
});

describe('validateGpsAccuracyList -- §7', () => {
  test('ningún punto trae accuracy -> maxAccuracyM=null (permitido por compatibilidad)', () => {
    const result = validateGpsAccuracyList([{ latitud: 1, longitud: -75 }, { latitud: 2, longitud: -76 }]);
    assert.equal(result.maxAccuracyM, null);
  });

  test('todos los puntos traen accuracy válida -> devuelve el máximo', () => {
    const result = validateGpsAccuracyList([{ accuracy: 4 }, { accuracy: 12 }, { accuracy: 7 }]);
    assert.equal(result.maxAccuracyM, 12);
  });

  test('accuracy absurda (<=0) -> INVALID_GPS_ACCURACY', () => {
    assert.throws(
      () => validateGpsAccuracyList([{ accuracy: 0 }]),
      (error) => error.status === 400 && error.code === 'INVALID_GPS_ACCURACY',
    );
    assert.throws(
      () => validateGpsAccuracyList([{ accuracy: -5 }]),
      (error) => error.status === 400 && error.code === 'INVALID_GPS_ACCURACY',
    );
  });

  test(`accuracy > GPS_MAX_ACCURACY_M (${GPS_MAX_ACCURACY_M}) -> GPS_ACCURACY_TOO_LOW`, () => {
    assert.throws(
      () => validateGpsAccuracyList([{ accuracy: GPS_MAX_ACCURACY_M + 1 }]),
      (error) => error.status === 422 && error.code === 'GPS_ACCURACY_TOO_LOW',
    );
  });

  test(`accuracy == GPS_MAX_ACCURACY_M (${GPS_MAX_ACCURACY_M}) -> aceptada (límite inclusive)`, () => {
    const result = validateGpsAccuracyList([{ accuracy: GPS_MAX_ACCURACY_M }]);
    assert.equal(result.maxAccuracyM, GPS_MAX_ACCURACY_M);
  });

  test('mezcla de puntos con y sin accuracy -- solo se valida/promedia sobre los que la traen', () => {
    const result = validateGpsAccuracyList([{ accuracy: 6 }, { latitud: 1, longitud: -75 }]);
    assert.equal(result.maxAccuracyM, 6);
  });
});
