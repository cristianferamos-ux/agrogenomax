// SPRINT-3D9.5: helpers de conversión datetime-local <-> ISO UTC --
// precisión deliberada de MINUTO (datetime-local no admite más
// resolución). Tests puros (sin DOM/React), timezone-independent -- nunca
// se compara contra un string humano hardcodeado, siempre contra un
// `Date` construido en el mismo proceso, así que son válidos bajo
// cualquier TZ del entorno donde corran.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isoToDatetimeLocalInput, datetimeLocalInputToIso } from '../dateFormat.js';

// A. ISO con segundos=0/ms=0 -> roundtrip exacto (mismo epoch).
test('roundtrip exacto cuando el ISO original ya está en el minuto (segundos=0, ms=0)', () => {
  const original = new Date(2026, 5, 15, 9, 30, 0, 0); // hora LOCAL del proceso -- nunca UTC hardcodeado
  const iso = original.toISOString();
  const local = isoToDatetimeLocalInput(iso);
  const roundtrip = datetimeLocalInputToIso(local);
  assert.equal(new Date(roundtrip).getTime(), original.getTime());
});

// B. ISO con segundos/ms distintos de cero -> el roundtrip reconstruye el
// INICIO del mismo minuto local, nunca el instante exacto original.
test('un ISO con segundos/ms se normaliza al inicio del mismo minuto local (no roundtrip exacto)', () => {
  const original = new Date(2026, 5, 15, 9, 30, 47, 250);
  const iso = original.toISOString();
  const local = isoToDatetimeLocalInput(iso);
  const roundtrip = datetimeLocalInputToIso(local);

  const inicioDeMinuto = new Date(original);
  inicioDeMinuto.setSeconds(0, 0);

  assert.equal(new Date(roundtrip).getTime(), inicioDeMinuto.getTime());
  assert.notEqual(new Date(roundtrip).getTime(), original.getTime());
});

// C. Inputs inválidos -> '' / null, nunca un Date basura ni una excepción.
test('isoToDatetimeLocalInput: valor no parseable como fecha -> string vacío', () => {
  assert.equal(isoToDatetimeLocalInput('no-es-una-fecha'), '');
  assert.equal(isoToDatetimeLocalInput(null), '');
  assert.equal(isoToDatetimeLocalInput(undefined), '');
});

test('datetimeLocalInputToIso: vacío/formato inválido -> null', () => {
  assert.equal(datetimeLocalInputToIso(''), null);
  assert.equal(datetimeLocalInputToIso(null), null);
  assert.equal(datetimeLocalInputToIso(undefined), null);
  assert.equal(datetimeLocalInputToIso('basura'), null);
  assert.equal(datetimeLocalInputToIso('2026-06-15'), null); // sin componente de hora
  assert.equal(datetimeLocalInputToIso('2026-06-15T09:30:00'), null); // con segundos -- fuera del formato de minuto exacto
});

// Hardening: fecha de calendario imposible (Date normaliza silenciosamente
// en vez de fallar) -> rechazada explícitamente, nunca aceptada corrida a
// otro día/mes.
test('datetimeLocalInputToIso: fecha de calendario imposible (31 de febrero) -> null, nunca corrida a marzo', () => {
  assert.equal(datetimeLocalInputToIso('2026-02-31T10:00'), null);
});

test('datetimeLocalInputToIso: hora imposible (25:00) -> null', () => {
  assert.equal(datetimeLocalInputToIso('2026-06-15T25:00'), null);
});

// D. Medianoche.
test('medianoche: roundtrip exacto', () => {
  const original = new Date(2026, 5, 15, 0, 0, 0, 0);
  const local = isoToDatetimeLocalInput(original.toISOString());
  assert.equal(local, '2026-06-15T00:00');
  assert.equal(new Date(datetimeLocalInputToIso(local)).getTime(), original.getTime());
});

// E. Cambio de día/mes/año -- ida y vuelta preserva el día correcto, sin off-by-one.
test('cambio de año: 31-dic 23:59 <-> 1-ene 00:00 no se confunden entre sí', () => {
  const finDeAnio = new Date(2025, 11, 31, 23, 59, 0, 0);
  const inicioDeAnio = new Date(2026, 0, 1, 0, 0, 0, 0);

  const localFin = isoToDatetimeLocalInput(finDeAnio.toISOString());
  const localInicio = isoToDatetimeLocalInput(inicioDeAnio.toISOString());

  assert.equal(localFin, '2025-12-31T23:59');
  assert.equal(localInicio, '2026-01-01T00:00');
  assert.equal(new Date(datetimeLocalInputToIso(localFin)).getTime(), finDeAnio.getTime());
  assert.equal(new Date(datetimeLocalInputToIso(localInicio)).getTime(), inicioDeAnio.getTime());
});

// F. Timezone del dispositivo -- ninguna assertion depende de una zona
// hardcodeada (America/Bogota ni ninguna otra): siempre se compara contra
// un `Date` construido en el mismo proceso que ejecuta el test.
test('isoToDatetimeLocalInput/datetimeLocalInputToIso nunca hardcodean una zona horaria', () => {
  const ahora = new Date();
  const local = isoToDatetimeLocalInput(ahora.toISOString());
  const [datePart, timePart] = local.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  assert.equal(y, ahora.getFullYear());
  assert.equal(m, ahora.getMonth() + 1);
  assert.equal(d, ahora.getDate());
  assert.equal(h, ahora.getHours());
  assert.equal(mi, ahora.getMinutes());
});
