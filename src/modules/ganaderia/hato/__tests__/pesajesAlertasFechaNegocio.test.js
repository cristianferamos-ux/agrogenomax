// FASE 1C.1: las alertas de pesaje usan la fecha calendario de NEGOCIO
// (America/Bogota, UTC-5 sin horario de verano), no la fecha local del
// navegador ni la fecha UTC. Instantes inyectados: determinístico.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ZONA_HORARIA_NEGOCIO, fechaHoyNegocio } from '../../engine/fechaNegocio.js';
import { construirAlertasPesajes } from '../pesajesAlertas.js';
import { resolveFechaHoyNegocio } from '../../../../../server/services/ganaderia/motorDescansoAuto/businessTimezone.js';

const alertasEn = (ahora, fechaUltimo) => construirAlertasPesajes({
  pesajes: [{ fecha: fechaUltimo, pesoKg: 300 }],
  fechaReferencia: fechaHoyNegocio({ ahora }),
});
const severidades = (lista) => lista.map((a) => `${a.severidad}:${a.datos.diasDesdeUltimoPesaje}`);

test('zona del negocio por defecto: America/Bogota', () => {
  assert.equal(ZONA_HORARIA_NEGOCIO, 'America/Bogota');
});

test('1. instante UTC que todavía es el día anterior en Bogotá', () => {
  const ahora = new Date('2026-10-21T02:00:00Z');
  assert.equal(ahora.toISOString().slice(0, 10), '2026-10-21', 'en UTC ya es 21');
  assert.equal(fechaHoyNegocio({ ahora }), '2026-10-20');
});

test('2. instante que ya es el día siguiente en otra zona pero no en Bogotá', () => {
  const ahora = new Date('2026-10-20T20:00:00Z'); // 15:00 en Bogotá
  assert.equal(fechaHoyNegocio({ ahora, timeZone: 'Asia/Tokyo' }), '2026-10-21');
  assert.equal(fechaHoyNegocio({ ahora, timeZone: 'Europe/Madrid' }), '2026-10-20');
  assert.equal(fechaHoyNegocio({ ahora }), '2026-10-20');
});

test('3. cruce de medianoche en Bogotá (05:00Z)', () => {
  assert.equal(fechaHoyNegocio({ ahora: '2026-10-21T04:59:59.999Z' }), '2026-10-20');
  assert.equal(fechaHoyNegocio({ ahora: '2026-10-21T05:00:00Z' }), '2026-10-21');
  assert.equal(fechaHoyNegocio({ ahora: Date.UTC(2026, 11, 31, 4, 59) }), '2026-12-30');
  assert.equal(fechaHoyNegocio({ ahora: Date.UTC(2027, 0, 1, 4, 59) }), '2026-12-31', 'fin de año');
  assert.equal(fechaHoyNegocio({ ahora: Date.UTC(2027, 0, 1, 5, 0) }), '2027-01-01');
});

test('4. 30/31 días se cuentan respecto a Bogotá, no a UTC', () => {
  // UTC ya es 21/10 (contaría 31 días -> ATENCIÓN); en Bogotá es 20/10: 30 días, sin alerta.
  assert.deepEqual(alertasEn('2026-10-21T02:00:00Z', '2026-09-20'), []);
  // Tras la medianoche de Bogotá: 31 días -> ATENCIÓN.
  assert.deepEqual(severidades(alertasEn('2026-10-21T05:00:00Z', '2026-09-20')), ['ATENCION:31']);
});

test('5. 60/61 días se cuentan respecto a Bogotá, no a UTC', () => {
  // UTC 21/10 contaría 61 (URGENTE); Bogotá 20/10: 60 -> ATENCIÓN.
  assert.deepEqual(severidades(alertasEn('2026-10-21T02:00:00Z', '2026-08-21')), ['ATENCION:60']);
  assert.deepEqual(severidades(alertasEn('2026-10-21T05:00:00Z', '2026-08-21')), ['URGENTE:61']);
});

test('la alerta usa la fecha de negocio como referencia en sus datos', () => {
  const [a] = alertasEn('2026-10-21T02:00:00Z', '2026-09-01');
  assert.equal(a.datos.fechaReferencia, '2026-10-20');
});

test('instante inválido -> null (y sin alerta de atraso inventada)', () => {
  assert.equal(fechaHoyNegocio({ ahora: 'no-es-fecha' }), null);
  assert.equal(fechaHoyNegocio({ ahora: Number.NaN }), null);
  assert.deepEqual(alertasEn('no-es-fecha', '2026-01-01'), []);
});

test('sin argumentos lee el reloj una sola vez y devuelve YYYY-MM-DD', () => {
  assert.match(fechaHoyNegocio(), /^\d{4}-\d{2}-\d{2}$/);
});

test('contrato: coincide con resolveFechaHoyNegocio del backend (cota "no futura" del POST)', () => {
  const inicio = Date.UTC(2026, 0, 1, 0, 0);
  // Cada 7 h 13 min durante 2 años: recorre todas las horas del día y meses.
  for (let t = inicio; t < inicio + 2 * 365 * 86400000; t += (7 * 60 + 13) * 60000) {
    const ahora = new Date(t);
    assert.equal(fechaHoyNegocio({ ahora }), resolveFechaHoyNegocio(ahora), ahora.toISOString());
  }
});
