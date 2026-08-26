// HOTFIX 3D8.1 (AUTOMATIC GRAZING START): pruebas unitarias puras de
// validatePreviewBody/validateCreateBody (sin HTTP, sin DB). Cubre:
// fechaInicioPastoreo YA NO es un input aceptado (ni en preview ni en
// create -- server-side siempre, ver businessTimezone.js),
// anclarAFechaExistente (booleano, "Actualizar estimación"),
// confirmedFechaInicioPastoreo (create únicamente, eco opcional §14),
// campos prohibidos (spoofing de derivados server-side).
import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePreviewBody, validateCreateBody } from '../ganaderiaPotreroDescansoReentrada.js';

test('preview: body vacío es válido -- "Calcular descanso" es UN CLIC, sin input', () => {
  const result = validatePreviewBody({});
  assert.deepEqual(result, { anclarAFechaExistente: false });
});

test('preview: body undefined (sin Content-Type/body) también es válido', () => {
  const result = validatePreviewBody(undefined);
  assert.deepEqual(result, { anclarAFechaExistente: false });
});

test('preview: acepta anclarAFechaExistente=true ("Actualizar estimación")', () => {
  const result = validatePreviewBody({ anclarAFechaExistente: true });
  assert.equal(result.anclarAFechaExistente, true);
});

test('preview: RECHAZA fechaInicioPastoreo -- ya NO es un input del cliente (HOTFIX 3D8.1)', () => {
  assert.throws(
    () => validatePreviewBody({ fechaInicioPastoreo: '2026-09-01' }),
    (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
  );
});

test('preview: RECHAZA campos derivados server-side, nunca aceptados del cliente', () => {
  for (const forbiddenKey of [
    'fichaId', 'contextoId', 'recomendacionPastoreoId', 'organizacionId', 'predioId', 'potreroId',
    'diasDescansoMin', 'diasDescansoMax', 'diasDescansoRecomendado', 'fechaSalidaEstimada',
    'fechaReingresoMin', 'fechaReingresoMax', 'fechaReingresoRecomendada', 'nivelConfianza',
    'motorVersion', 'condicionesReentrada', 'parametrosFuente', 'confirmedFechaInicioPastoreo',
  ]) {
    assert.throws(
      () => validatePreviewBody({ [forbiddenKey]: 1 }),
      (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
      `debía rechazar el campo ${forbiddenKey}`,
    );
  }
});

test('preview: anclarAFechaExistente con tipo incorrecto (no booleano) se rechaza', () => {
  for (const garbage of ['true', 1, {}, []]) {
    assert.throws(
      () => validatePreviewBody({ anclarAFechaExistente: garbage }),
      (e) => e.status === 400 && e.code === 'INVALID_ANCLAR_A_FECHA_EXISTENTE',
    );
  }
});

test('create: body vacío es válido -- self-suficiente, sin preview previo', () => {
  const result = validateCreateBody({});
  assert.deepEqual(result, { anclarAFechaExistente: false, confirmedFechaInicioPastoreo: undefined });
});

test('create: RECHAZA fechaInicioPastoreo -- ya NO es un input del cliente (HOTFIX 3D8.1)', () => {
  assert.throws(
    () => validateCreateBody({ fechaInicioPastoreo: '2026-09-01' }),
    (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
  );
});

test('create: acepta confirmedFechaInicioPastoreo con formato YYYY-MM-DD válido (eco §14, opcional)', () => {
  const result = validateCreateBody({ confirmedFechaInicioPastoreo: '2026-08-25' });
  assert.equal(result.confirmedFechaInicioPastoreo, '2026-08-25');
});

test('create: rechaza confirmedFechaInicioPastoreo con formato/calendario inválido', () => {
  for (const garbage of ['', '2026/08/25', '25-08-2026', '2026-02-30', 20260825, {}]) {
    assert.throws(
      () => validateCreateBody({ confirmedFechaInicioPastoreo: garbage }),
      (e) => e.status === 400 && e.code === 'INVALID_CONFIRMED_FECHA_INICIO_PASTOREO',
      `confirmedFechaInicioPastoreo=${String(garbage)} debía ser rechazado`,
    );
  }
});

test('create: acepta anclarAFechaExistente + confirmedFechaInicioPastoreo combinados', () => {
  const result = validateCreateBody({ anclarAFechaExistente: true, confirmedFechaInicioPastoreo: '2026-08-25' });
  assert.deepEqual(result, { anclarAFechaExistente: true, confirmedFechaInicioPastoreo: '2026-08-25' });
});

test('create: RECHAZA campos derivados server-side, nunca aceptados del cliente', () => {
  for (const forbiddenKey of [
    'fichaId', 'contextoId', 'recomendacionPastoreoId', 'organizacionId', 'predioId', 'potreroId',
    'diasDescansoMin', 'diasDescansoMax', 'diasDescansoRecomendado', 'fechaSalidaEstimada',
    'fechaReingresoMin', 'fechaReingresoMax', 'fechaReingresoRecomendada', 'nivelConfianza',
    'motorVersion', 'condicionesReentrada', 'parametrosFuente',
  ]) {
    assert.throws(
      () => validateCreateBody({ [forbiddenKey]: 1 }),
      (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
      `debía rechazar el campo ${forbiddenKey}`,
    );
  }
});
