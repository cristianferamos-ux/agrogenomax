// HOTFIX 3D8.1: resolveFechaHoyNegocio -- fecha LOCAL del negocio
// (America/Bogota, UTC-5 todo el año), nunca UTC directo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFechaHoyNegocio, BUSINESS_TIMEZONE } from '../businessTimezone.js';

test('BUSINESS_TIMEZONE es America/Bogota', () => {
  assert.equal(BUSINESS_TIMEZONE, 'America/Bogota');
});

test('caso normal: mediodía UTC -> mismo día calendario en Bogotá (UTC-5)', () => {
  // 2026-08-25T15:00:00Z = 2026-08-25 10:00 hora Bogotá.
  const resultado = resolveFechaHoyNegocio(new Date('2026-08-25T15:00:00Z'));
  assert.equal(resultado, '2026-08-25');
});

// HOTFIX 3D8.1 test A: nunca usar la fecha UTC directamente -- produce
// desfase de un día completo en la franja 00:00-04:59 UTC (19:00-23:59 del
// día ANTERIOR en Bogotá).
test('test A: instante UTC de madrugada -> el día calendario en Bogotá es el ANTERIOR (nunca UTC directo)', () => {
  // 2026-08-26T02:00:00Z = 2026-08-25 21:00 hora Bogotá -- todavía 25.
  const instanteUtc = new Date('2026-08-26T02:00:00Z');
  const resultado = resolveFechaHoyNegocio(instanteUtc);
  assert.equal(resultado, '2026-08-25', 'debe ser el día Bogotá (25), NUNCA el día UTC (26)');
  assert.notEqual(resultado, instanteUtc.toISOString().slice(0, 10), 'confirma que .toISOString() directo habría dado el día equivocado');
});

test('justo en el límite: 05:00:00 UTC = 00:00:00 Bogotá -- ya es el día siguiente', () => {
  const resultado = resolveFechaHoyNegocio(new Date('2026-08-26T05:00:00Z'));
  assert.equal(resultado, '2026-08-26');
});

test('justo antes del límite: 04:59:59 UTC = 23:59:59 Bogotá del día anterior', () => {
  const resultado = resolveFechaHoyNegocio(new Date('2026-08-26T04:59:59Z'));
  assert.equal(resultado, '2026-08-25');
});

test('fixture del sprint: instante que corresponde a 2026-08-25 en Bogotá', () => {
  const resultado = resolveFechaHoyNegocio(new Date('2026-08-25T18:30:00Z')); // 13:30 Bogotá
  assert.equal(resultado, '2026-08-25');
});

test('sin argumento, usa la fecha real actual (Date.now) -- nunca lanza', () => {
  const resultado = resolveFechaHoyNegocio();
  assert.match(resultado, /^\d{4}-\d{2}-\d{2}$/);
});
