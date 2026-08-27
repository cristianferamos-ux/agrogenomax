// SPRINT-3D9.1: pruebas unitarias puras de validateIniciarBody/
// validateCancelarBody (sin HTTP, sin DB). Cubre: campos prohibidos
// (nunca fechas ni derivados server-side), motivo obligatorio no vacío
// al cancelar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateIniciarBody, validateCancelarBody } from '../ganaderiaPotreroCicloPastoreo.js';

test('iniciar: body vacío es válido -- el cliente NUNCA está obligado a aportar nada', () => {
  const result = validateIniciarBody({});
  assert.deepEqual(result, { numeroAnimales: undefined, pesoPromedioKg: undefined, categoriaCodigo: undefined });
});

test('iniciar: acepta el ajuste opcional del lote real', () => {
  const result = validateIniciarBody({ numeroAnimales: 9, pesoPromedioKg: 405, categoriaCodigo: 'novillo_ceba' });
  assert.deepEqual(result, { numeroAnimales: 9, pesoPromedioKg: 405, categoriaCodigo: 'novillo_ceba' });
});

test('iniciar: RECHAZA fechaIngresoReal/fechaInicioPastoreo -- el cliente NUNCA aporta una fecha', () => {
  for (const forbidden of ['fechaIngresoReal', 'fechaInicioPastoreo', 'fechaSalidaReal', 'organizacionId', 'cicloId', 'estado']) {
    assert.throws(
      () => validateIniciarBody({ [forbidden]: 'x' }),
      (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
      `debía rechazar el campo ${forbidden}`,
    );
  }
});

test('iniciar: tipos incorrectos son rechazados', () => {
  assert.throws(() => validateIniciarBody({ numeroAnimales: '9' }), (e) => e.code === 'INVALID_NUMERO_ANIMALES_REAL');
  assert.throws(() => validateIniciarBody({ pesoPromedioKg: '405' }), (e) => e.code === 'INVALID_PESO_PROMEDIO_REAL');
  assert.throws(() => validateIniciarBody({ categoriaCodigo: 123 }), (e) => e.code === 'INVALID_CATEGORIA_CODIGO');
});

test('cancelar: motivo obligatorio -- vacío/espacios/ausente son rechazados', () => {
  for (const motivoInvalido of [undefined, null, '', '   ']) {
    assert.throws(
      () => validateCancelarBody({ motivo: motivoInvalido }),
      (e) => e.status === 400 && e.code === 'INVALID_MOTIVO_CANCELACION',
    );
  }
});

test('cancelar: acepta un motivo no vacío', () => {
  const result = validateCancelarBody({ motivo: 'lote trasladado por error' });
  assert.deepEqual(result, { motivo: 'lote trasladado por error' });
});

test('cancelar: RECHAZA campos derivados server-side', () => {
  for (const forbidden of ['fechaSalidaReal', 'estado', 'organizacionId']) {
    assert.throws(
      () => validateCancelarBody({ motivo: 'x', [forbidden]: 'y' }),
      (e) => e.status === 400 && e.code === 'FORBIDDEN_FIELDS',
    );
  }
});
