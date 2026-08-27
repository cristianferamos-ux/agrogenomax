// SPRINT-3D9.1 (DESIGN REVISION 1, Guardrail 2): clasificación de errores
// de FASE B ("Finalizar pastoreo") -- PENDIENTE (condición transitoria,
// reintentable) vs ERROR_TECNICO (excepción inesperada/bug). Prueba
// pura, sin DB -- no requiere reproducir un error transitorio real de
// Postgres.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFaseBError } from '../potreroCicloPastoreoRepository.js';

const CODIGOS_TRANSITORIOS = ['40001', '40P01', '53300', '57014', '08000', '08003', '08006'];

test('códigos Postgres transitorios/reintentables se clasifican PENDIENTE', () => {
  for (const code of CODIGOS_TRANSITORIOS) {
    assert.equal(classifyFaseBError({ code }), 'PENDIENTE', `código ${code} debía ser PENDIENTE`);
  }
});

test('cualquier otro código (o ausencia de código) se clasifica ERROR_TECNICO', () => {
  assert.equal(classifyFaseBError({ code: '23503' }), 'ERROR_TECNICO'); // violación de FK -- nunca transitorio
  assert.equal(classifyFaseBError({ code: 'NO_PASTURE_PROFILE' }), 'ERROR_TECNICO'); // error semántico del motor
  assert.equal(classifyFaseBError(new Error('boom')), 'ERROR_TECNICO'); // excepción sin código Postgres
  assert.equal(classifyFaseBError({}), 'ERROR_TECNICO');
  assert.equal(classifyFaseBError(null), 'ERROR_TECNICO');
});
