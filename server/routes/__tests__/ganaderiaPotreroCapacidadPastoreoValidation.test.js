// SPRINT-3D7-CAPACIDAD-PASTOREO: pruebas unitarias puras de
// validateCapacidadPastoreoBody (sin HTTP, sin DB). Cubre: modo
// inválido, campos prohibidos por modo (§18/§22 -- nunca
// biomasaFrescaKg/materiaSecaTotalKg/materiaSecaUtilizableKg/
// demandaDiariaLoteKgMs/diasOcupacionEstimados/capacidadAnimalesPeriodo/
// areaHa/fichaId/organizacionId/predioId/potreroId), guardrails (§28/§29)
// y NaN/Infinity/string basura.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCapacidadPastoreoBody } from '../ganaderiaPotreroCapacidadPastoreo.js';

const BASE_DIAS = {
  modo: 'dias_ocupacion',
  numeroAnimales: 20,
  pesoVivoPromedioKg: 450,
  porcentajeMateriaSeca: 25,
  porcentajeUtilizacion: 50,
  consumoPctPesoVivo: 2.5,
};

const BASE_ANIMALES = {
  modo: 'capacidad_animales',
  periodoObjetivoDias: 1,
  pesoVivoPromedioKg: 450,
  porcentajeMateriaSeca: 25,
  porcentajeUtilizacion: 50,
  consumoPctPesoVivo: 2.5,
};

test('acepta un body válido en modo días de ocupación', () => {
  const result = validateCapacidadPastoreoBody(BASE_DIAS);
  assert.equal(result.modo, 'dias_ocupacion');
  assert.equal(result.numeroAnimales, 20);
  assert.equal(result.pesoVivoPromedioKg, 450);
  assert.equal(result.porcentajeMateriaSeca, 25);
  assert.equal(result.porcentajeUtilizacion, 50);
  assert.equal(result.consumoPctPesoVivo, 2.5);
  assert.equal(result.periodoObjetivoDias, undefined);
  assert.equal(result.observaciones, undefined);
});

test('acepta un body válido en modo capacidad de animales', () => {
  const result = validateCapacidadPastoreoBody(BASE_ANIMALES);
  assert.equal(result.modo, 'capacidad_animales');
  assert.equal(result.periodoObjetivoDias, 1);
  assert.equal(result.numeroAnimales, undefined);
});

test('acepta observaciones solo cuando allowObservaciones=true (create), nunca en preview', () => {
  const withObs = validateCapacidadPastoreoBody({ ...BASE_DIAS, observaciones: 'Lote de recría' }, { allowObservaciones: true });
  assert.equal(withObs.observaciones, 'Lote de recría');

  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_DIAS, observaciones: 'x' }, { allowObservaciones: false }),
    (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
  );
});

test('rechaza modo inválido o ausente', () => {
  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_DIAS, modo: 'rotacion' }),
    (e) => e.status === 400 && e.code === 'INVALID_MODO',
  );
  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_DIAS, modo: undefined }),
    (e) => e.code === 'INVALID_MODO',
  );
});

test('RECHAZA campos derivados server-side (§22 del sprint) en cualquier modo', () => {
  for (const forbiddenKey of [
    'biomasaFrescaKg', 'materiaSecaTotalKg', 'materiaSecaUtilizableKg', 'demandaDiariaLoteKgMs',
    'diasOcupacionEstimados', 'capacidadAnimalesPeriodo', 'areaHa', 'fichaId',
    'organizacionId', 'predioId', 'potreroId',
  ]) {
    assert.throws(
      () => validateCapacidadPastoreoBody({ ...BASE_DIAS, [forbiddenKey]: 1 }),
      (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
      `debía rechazar el campo ${forbiddenKey}`,
    );
  }
});

test('rechaza el campo del OTRO modo -- evita un formulario confuso con ambos activos (§18 del sprint)', () => {
  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_DIAS, periodoObjetivoDias: 5 }),
    (e) => e.code === 'FORBIDDEN_FIELDS',
  );
  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_ANIMALES, numeroAnimales: 5 }),
    (e) => e.code === 'FORBIDDEN_FIELDS',
  );
});

test('pesoVivoPromedioKg: > 0 y <= 2000 kg (§29 del sprint)', () => {
  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_DIAS, pesoVivoPromedioKg: 0 }),
    (e) => e.code === 'INVALID_PESO_VIVO',
  );
  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_DIAS, pesoVivoPromedioKg: -10 }),
    (e) => e.code === 'INVALID_PESO_VIVO',
  );
  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_DIAS, pesoVivoPromedioKg: 2001 }),
    (e) => e.code === 'PESO_VIVO_TOO_HIGH',
  );
  const result = validateCapacidadPastoreoBody({ ...BASE_DIAS, pesoVivoPromedioKg: 2000 });
  assert.equal(result.pesoVivoPromedioKg, 2000);
});

test('porcentajeMateriaSeca y porcentajeUtilizacion: > 0 y <= 100', () => {
  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_DIAS, porcentajeMateriaSeca: 0 }),
    (e) => e.code === 'INVALID_MATERIA_SECA',
  );
  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_DIAS, porcentajeMateriaSeca: 101 }),
    (e) => e.code === 'INVALID_MATERIA_SECA',
  );
  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_DIAS, porcentajeUtilizacion: 0 }),
    (e) => e.code === 'INVALID_UTILIZACION',
  );
  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_DIAS, porcentajeUtilizacion: 101 }),
    (e) => e.code === 'INVALID_UTILIZACION',
  );
  const result = validateCapacidadPastoreoBody({ ...BASE_DIAS, porcentajeMateriaSeca: 100, porcentajeUtilizacion: 100 });
  assert.equal(result.porcentajeMateriaSeca, 100);
  assert.equal(result.porcentajeUtilizacion, 100);
});

test('consumoPctPesoVivo: > 0 y <= 10 (guardrail técnico, §11/§29 del sprint -- nunca un valor universal)', () => {
  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_DIAS, consumoPctPesoVivo: 0 }),
    (e) => e.code === 'INVALID_CONSUMO',
  );
  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_DIAS, consumoPctPesoVivo: 10.1 }),
    (e) => e.code === 'CONSUMO_TOO_HIGH',
  );
  const result = validateCapacidadPastoreoBody({ ...BASE_DIAS, consumoPctPesoVivo: 10 });
  assert.equal(result.consumoPctPesoVivo, 10);
});

test('numeroAnimales: entero >= 1 y <= 100000 (§29 del sprint)', () => {
  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_DIAS, numeroAnimales: 0 }),
    (e) => e.code === 'INVALID_NUMERO_ANIMALES',
  );
  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_DIAS, numeroAnimales: 1.5 }),
    (e) => e.code === 'INVALID_NUMERO_ANIMALES',
  );
  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_DIAS, numeroAnimales: 100001 }),
    (e) => e.code === 'NUMERO_ANIMALES_TOO_HIGH',
  );
});

test('periodoObjetivoDias: > 0 y <= 365 (§29 del sprint)', () => {
  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_ANIMALES, periodoObjetivoDias: 0 }),
    (e) => e.code === 'INVALID_PERIODO_OBJETIVO',
  );
  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_ANIMALES, periodoObjetivoDias: 366 }),
    (e) => e.code === 'PERIODO_OBJETIVO_TOO_HIGH',
  );
  const result = validateCapacidadPastoreoBody({ ...BASE_ANIMALES, periodoObjetivoDias: 365 });
  assert.equal(result.periodoObjetivoDias, 365);
});

test('nunca acepta NaN/Infinity/string basura (§28 del sprint)', () => {
  for (const garbage of ['abc', NaN, Infinity, -Infinity, null, undefined, '']) {
    assert.throws(
      () => validateCapacidadPastoreoBody({ ...BASE_DIAS, pesoVivoPromedioKg: garbage }),
      (e) => e.code === 'INVALID_PESO_VIVO',
      `pesoVivoPromedioKg=${String(garbage)} debía ser rechazado`,
    );
  }
});

test('observaciones respeta el límite de longitud', () => {
  const tooLong = 'a'.repeat(2001);
  assert.throws(
    () => validateCapacidadPastoreoBody({ ...BASE_DIAS, observaciones: tooLong }, { allowObservaciones: true }),
    (e) => e.code === 'INVALID_OBSERVACIONES',
  );
});
