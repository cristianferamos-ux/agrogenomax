// SPRINT-3D3-POTREROS-API-FOUNDATION: pruebas unitarias puras de las
// funciones de validación de entrada del router (sin HTTP, sin DB).
// Cubren el requisito crítico: geometry/areaHa/metodoDelimitacion/
// predioId/organizacionId enviados por el cliente deben ser RECHAZADOS
// explícitamente (§6/§13), y el cierre/validación estructural del anillo
// de coordenadas de preview (§13) sin depender de PostGIS real (eso lo
// cubre potrerosRepositoryIntegration.test.js contra un Postgres real).
import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePreviewBody, validateCreatePotreroBody } from '../ganaderiaPotreros.js';
import { buildPolygonWktFromPuntos } from '../../services/ganaderia/potrerosRepository.js';

// ---------------------------------------------------------------------
// buildPolygonWktFromPuntos / validatePreviewBody (§13)
// ---------------------------------------------------------------------

const SQUARE = [
  { latitud: 1.3, longitud: -75.5 },
  { latitud: 1.3, longitud: -75.4 },
  { latitud: 1.4, longitud: -75.4 },
];

test('buildPolygonWktFromPuntos: cierra el anillo explícitamente y construye lon/lat', () => {
  const wkt = buildPolygonWktFromPuntos(SQUARE);
  assert.equal(wkt, 'POLYGON((-75.5 1.3, -75.4 1.3, -75.4 1.4, -75.5 1.3))');
});

test('buildPolygonWktFromPuntos: acepta un anillo ya cerrado por el cliente sin duplicar el cierre', () => {
  const closed = [...SQUARE, SQUARE[0]];
  const wkt = buildPolygonWktFromPuntos(closed);
  assert.equal(wkt, 'POLYGON((-75.5 1.3, -75.4 1.3, -75.4 1.4, -75.5 1.3))');
});

test('buildPolygonWktFromPuntos: rechaza menos de 3 vértices', () => {
  assert.throws(
    () => buildPolygonWktFromPuntos([{ latitud: 1, longitud: -75 }, { latitud: 1.1, longitud: -75.1 }]),
    (e) => e.status === 400 && e.code === 'INVALID_POTRERO_COORDINATES',
  );
});

test('buildPolygonWktFromPuntos: rechaza vértices no distintos (todos el mismo punto)', () => {
  const samePoint = { latitud: 1.3, longitud: -75.5 };
  assert.throws(
    () => buildPolygonWktFromPuntos([samePoint, samePoint, samePoint]),
    (e) => e.code === 'INVALID_POTRERO_COORDINATES',
  );
});

test('buildPolygonWktFromPuntos: rechaza coordenadas no numéricas o fuera de rango', () => {
  assert.throws(() => buildPolygonWktFromPuntos([{ latitud: 'x', longitud: -75 }, { latitud: 1, longitud: -75 }, { latitud: 2, longitud: -75 }]));
  assert.throws(() => buildPolygonWktFromPuntos([{ latitud: 91, longitud: -75 }, { latitud: 1, longitud: -75 }, { latitud: 2, longitud: -75 }]));
  assert.throws(() => buildPolygonWktFromPuntos([{ latitud: 1, longitud: 181 }, { latitud: 1, longitud: -75 }, { latitud: 2, longitud: -75 }]));
});

test('buildPolygonWktFromPuntos: rechaza puntos no array / vacío', () => {
  assert.throws(() => buildPolygonWktFromPuntos(undefined), (e) => e.code === 'INVALID_POTRERO_COORDINATES');
  assert.throws(() => buildPolygonWktFromPuntos([]), (e) => e.code === 'INVALID_POTRERO_COORDINATES');
});

test('validatePreviewBody: RECHAZA campos no permitidos (geometry, areaHa, metodoDelimitacion, predioId, organizacionId)', () => {
  for (const forbiddenKey of ['geometry', 'areaHa', 'metodoDelimitacion', 'predioId', 'organizacionId']) {
    assert.throws(
      () => validatePreviewBody({ puntos: SQUARE, [forbiddenKey]: 'x' }),
      (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
      `debía rechazar el campo ${forbiddenKey}`,
    );
  }
});

test('validatePreviewBody: acepta un body válido y devuelve el WKT', () => {
  const wkt = validatePreviewBody({ puntos: SQUARE });
  assert.match(wkt, /^POLYGON\(\(/);
});

// ---------------------------------------------------------------------
// validateCreatePotreroBody (§6)
// ---------------------------------------------------------------------

test('validateCreatePotreroBody: acepta un body mínimo válido', () => {
  const result = validateCreatePotreroBody({ candidateId: 'potcand_x', nombre: 'Potrero 1' });
  assert.equal(result.candidateId, 'potcand_x');
  assert.equal(result.nombre, 'Potrero 1');
  assert.equal(result.capacidadAnimales, null);
  assert.equal(result.observaciones, null);
});

test('validateCreatePotreroBody: RECHAZA geometry/areaHa/metodoDelimitacion/predioId/organizacionId inyectados', () => {
  for (const forbiddenKey of ['geometry', 'areaHa', 'metodoDelimitacion', 'predioId', 'organizacionId']) {
    assert.throws(
      () => validateCreatePotreroBody({ candidateId: 'potcand_x', nombre: 'Potrero 1', [forbiddenKey]: 'x' }),
      (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
      `debía rechazar el campo ${forbiddenKey}`,
    );
  }
});

test('validateCreatePotreroBody: exige candidateId y nombre', () => {
  assert.throws(() => validateCreatePotreroBody({ nombre: 'Potrero 1' }), (e) => e.code === 'INVALID_CANDIDATE_ID');
  assert.throws(() => validateCreatePotreroBody({ candidateId: 'potcand_x' }), (e) => e.code === 'INVALID_NOMBRE');
  assert.throws(() => validateCreatePotreroBody({ candidateId: 'potcand_x', nombre: '   ' }), (e) => e.code === 'INVALID_NOMBRE');
});

test('validateCreatePotreroBody: capacidadAnimales debe ser entero >= 0', () => {
  assert.throws(
    () => validateCreatePotreroBody({ candidateId: 'potcand_x', nombre: 'X', capacidadAnimales: -1 }),
    (e) => e.code === 'INVALID_CAPACIDAD_ANIMALES',
  );
  assert.throws(
    () => validateCreatePotreroBody({ candidateId: 'potcand_x', nombre: 'X', capacidadAnimales: 1.5 }),
    (e) => e.code === 'INVALID_CAPACIDAD_ANIMALES',
  );
  const result = validateCreatePotreroBody({ candidateId: 'potcand_x', nombre: 'X', capacidadAnimales: 40 });
  assert.equal(result.capacidadAnimales, 40);
});

test('validateCreatePotreroBody: observaciones respeta el límite de longitud', () => {
  const tooLong = 'a'.repeat(2001);
  assert.throws(
    () => validateCreatePotreroBody({ candidateId: 'potcand_x', nombre: 'X', observaciones: tooLong }),
    (e) => e.code === 'INVALID_OBSERVACIONES',
  );
});
