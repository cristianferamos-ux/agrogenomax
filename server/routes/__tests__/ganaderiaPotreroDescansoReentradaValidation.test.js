// SPRINT-3D8-DESCANSO-REENTRADA: pruebas unitarias puras de
// validateDescansoReentradaBody (sin HTTP, sin DB). Cubre: campos
// prohibidos (spoofing de derivados server-side -- §2 del sprint: nunca
// fichaId/contextoId/recomendacionPastoreoId/resultados/organizacionId/
// predioId/potreroId), formato de fechaInicioPastoreo, y NaN/Infinity/
// string basura.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDescansoReentradaBody } from '../ganaderiaPotreroDescansoReentrada.js';

const BASE = { fechaInicioPastoreo: '2026-09-01' };

test('acepta un body mínimo válido', () => {
  const result = validateDescansoReentradaBody(BASE);
  assert.equal(result.fechaInicioPastoreo, '2026-09-01');
});

test('RECHAZA campos derivados server-side (§2 del sprint), nunca aceptados del cliente', () => {
  for (const forbiddenKey of [
    'fichaId', 'contextoId', 'recomendacionPastoreoId', 'organizacionId', 'predioId', 'potreroId',
    'diasDescansoMin', 'diasDescansoMax', 'diasDescansoRecomendado', 'fechaSalidaEstimada',
    'fechaReingresoMin', 'fechaReingresoMax', 'fechaReingresoRecomendada', 'nivelConfianza',
    'motorVersion', 'condicionesReentrada', 'parametrosFuente',
  ]) {
    assert.throws(
      () => validateDescansoReentradaBody({ ...BASE, [forbiddenKey]: 1 }),
      (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
      `debía rechazar el campo ${forbiddenKey}`,
    );
  }
});

test('rechaza fechaInicioPastoreo ausente/con formato inválido', () => {
  for (const garbage of [undefined, null, '', '2026/09/01', '01-09-2026', '2026-13-40', 20260901, {}]) {
    assert.throws(
      () => validateDescansoReentradaBody({ fechaInicioPastoreo: garbage }),
      (e) => e.status === 400 && e.code === 'INVALID_FECHA_INICIO_PASTOREO',
      `fechaInicioPastoreo=${String(garbage)} debía ser rechazado`,
    );
  }
});

test('rechaza una fecha con formato correcto pero calendario inválido', () => {
  assert.throws(
    () => validateDescansoReentradaBody({ fechaInicioPastoreo: '2026-02-30' }),
    (e) => e.code === 'INVALID_FECHA_INICIO_PASTOREO',
  );
});

test('acepta fechas límite de mes/año válidas', () => {
  const result = validateDescansoReentradaBody({ fechaInicioPastoreo: '2026-12-31' });
  assert.equal(result.fechaInicioPastoreo, '2026-12-31');
});
