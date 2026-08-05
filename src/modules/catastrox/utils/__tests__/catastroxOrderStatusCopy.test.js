// CATX-POSTPAYMENT-UX-001: pruebas de las utilidades puras usadas para
// corregir los defectos A (retorno Wompi congelado en "En proceso") y B
// (monto crudo en centavos) -- sin red, sin DOM, sin montar componentes.
//
// Nota sobre alcance: este repositorio no tiene un harness de pruebas de
// componentes React (jsdom/@testing-library) -- todas las pruebas
// existentes de src/modules/catastrox/**/__tests__ ejercitan funciones
// puras exportadas, nunca un componente montado. Por eso la lógica de
// decisión del polling (cuándo iniciar, qué hacer en cada tick, qué copy
// mostrar) se extrajo a funciones puras en catastroxOrderStatusCopy.js
// (mismo patrón ya usado por recoverLookupForPending en
// CatastroXWompiReturnPage.jsx) -- se prueba esa lógica exhaustivamente
// aquí; el cableado de React (useEffect/setInterval/setState) en el propio
// componente no tiene cobertura automatizada de este tipo en este repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCopFromCents,
  isTerminalDeliveryStatus,
  shouldStartDeliveryPolling,
  resolveDeliveryPollTick,
  getWompiReturnDeliveryCopy,
} from '../catastroxOrderStatusCopy.js';

// --- formatCopFromCents (defecto B) ----------------------------------------

test('formatCopFromCents) 3990000 centavos -> "$39.900 COP" (caso exacto del defecto reportado)', () => {
  assert.equal(formatCopFromCents(3990000), '$39.900 COP');
});

test('formatCopFromCents) 100 centavos -> "$1 COP"', () => {
  assert.equal(formatCopFromCents(100), '$1 COP');
});

test('formatCopFromCents) 123456789 centavos -> "$1.234.567,89 COP" (decimales solo cuando no son cero)', () => {
  assert.equal(formatCopFromCents(123456789), '$1.234.567,89 COP');
});

test('formatCopFromCents) 0 centavos -> "$0 COP", nunca "Monto no disponible" (cero es un valor válido)', () => {
  assert.equal(formatCopFromCents(0), '$0 COP');
});

test('formatCopFromCents) acepta cadenas numéricas ("3990000" igual que 3990000)', () => {
  assert.equal(formatCopFromCents('3990000'), formatCopFromCents(3990000));
});

test('formatCopFromCents) null/undefined/NaN/cadena no numérica -> texto seguro, nunca lanza ni produce "NaN COP"', () => {
  for (const value of [null, undefined, NaN, 'no-es-un-numero', {}, []]) {
    const result = formatCopFromCents(value);
    assert.equal(typeof result, 'string');
    assert.ok(!result.includes('NaN'), `no debe contener "NaN" para ${JSON.stringify(value)}: "${result}"`);
  }
});

test('formatCopFromCents) nunca muta ni depende de estado externo -- misma entrada, misma salida siempre', () => {
  assert.equal(formatCopFromCents(3990000), formatCopFromCents(3990000));
});

// --- isTerminalDeliveryStatus / shouldStartDeliveryPolling (defecto A) ----

test('isTerminalDeliveryStatus) SENT/DELIVERED/FAILED/EXPIRED son terminales', () => {
  ['SENT', 'DELIVERED', 'FAILED', 'EXPIRED'].forEach((status) => {
    assert.equal(isTerminalDeliveryStatus(status), true, status);
  });
});

test('isTerminalDeliveryStatus) QUEUED/GENERATING/READY/SENDING/null NO son terminales', () => {
  ['QUEUED', 'GENERATING', 'READY', 'SENDING', null, undefined].forEach((status) => {
    assert.equal(isTerminalDeliveryStatus(status), false, String(status));
  });
});

test('shouldStartDeliveryPolling) pago APPROVED + delivery PROCESSING (GENERATING) -> inicia polling', () => {
  assert.equal(
    shouldStartDeliveryPolling({ paymentStatus: 'approved', orderToken: 'tok_1', currentDeliveryStatus: 'GENERATING' }),
    true,
  );
});

test('shouldStartDeliveryPolling) sin orderToken -> nunca inicia, aunque el pago esté aprobado', () => {
  assert.equal(
    shouldStartDeliveryPolling({ paymentStatus: 'approved', orderToken: null, currentDeliveryStatus: 'GENERATING' }),
    false,
  );
});

test('shouldStartDeliveryPolling) pago no aprobado (pending/error) -> nunca inicia', () => {
  assert.equal(shouldStartDeliveryPolling({ paymentStatus: 'pending', orderToken: 'tok_1' }), false);
  assert.equal(shouldStartDeliveryPolling({ paymentStatus: 'error', orderToken: 'tok_1' }), false);
});

test('shouldStartDeliveryPolling) estado de entrega ya terminal (SENT) -> no inicia (no tiene sentido seguir consultando)', () => {
  assert.equal(
    shouldStartDeliveryPolling({ paymentStatus: 'approved', orderToken: 'tok_1', currentDeliveryStatus: 'SENT' }),
    false,
  );
});

// --- resolveDeliveryPollTick ------------------------------------------------

test('resolveDeliveryPollTick) elapsedMs < max y sin estado terminal -> continue', () => {
  const outcome = resolveDeliveryPollTick({ elapsedMs: 4000, maxDurationMs: 30000, nextDeliveryStatus: 'GENERATING' });
  assert.equal(outcome.action, 'continue');
});

test('resolveDeliveryPollTick) cambia a SENT -> stop (detiene el polling)', () => {
  const outcome = resolveDeliveryPollTick({ elapsedMs: 6000, maxDurationMs: 30000, nextDeliveryStatus: 'SENT' });
  assert.equal(outcome.action, 'stop');
});

test('resolveDeliveryPollTick) cambia a FAILED -> stop (detiene el polling, no reintenta el envío por su cuenta)', () => {
  const outcome = resolveDeliveryPollTick({ elapsedMs: 6000, maxDurationMs: 30000, nextDeliveryStatus: 'FAILED' });
  assert.equal(outcome.action, 'stop');
});

test('resolveDeliveryPollTick) elapsedMs >= maxDurationMs -> timeout (nunca "stop", nunca se confunde con éxito/fallo)', () => {
  const outcome = resolveDeliveryPollTick({ elapsedMs: 30000, maxDurationMs: 30000 });
  assert.equal(outcome.action, 'timeout');
});

test('resolveDeliveryPollTick) el chequeo de vencimiento tiene prioridad -- si ambos se cumplen, es timeout, no stop', () => {
  const outcome = resolveDeliveryPollTick({ elapsedMs: 30000, maxDurationMs: 30000, nextDeliveryStatus: 'SENT' });
  assert.equal(outcome.action, 'timeout');
});

// --- getWompiReturnDeliveryCopy (copy exacto pedido) ------------------------

test('getWompiReturnDeliveryCopy) SENT -> "Entrega completada" / "Tu diagnóstico predial está disponible."', () => {
  const copy = getWompiReturnDeliveryCopy('SENT');
  assert.equal(copy.label, 'Entrega completada');
  assert.equal(copy.message, 'Tu diagnóstico predial está disponible.');
  assert.equal(copy.tone, 'success');
});

test('getWompiReturnDeliveryCopy) DELIVERED -> mismo copy exacto que SENT', () => {
  assert.deepEqual(getWompiReturnDeliveryCopy('DELIVERED'), getWompiReturnDeliveryCopy('SENT'));
});

test('getWompiReturnDeliveryCopy) FAILED -> "Envío no completado" con mensaje amigable (ya cumplía, se conserva)', () => {
  const copy = getWompiReturnDeliveryCopy('FAILED');
  assert.equal(copy.label, 'Envío no completado');
  assert.ok(copy.message.length > 0);
});

test('getWompiReturnDeliveryCopy) GENERATING/QUEUED -> nunca usa lenguaje de "enviado/entregado" (sigue "En proceso"/"En preparación")', () => {
  ['GENERATING', 'SENDING', 'READY', 'QUEUED'].forEach((status) => {
    const copy = getWompiReturnDeliveryCopy(status);
    assert.ok(
      !/enviad|entregad/i.test(copy.label) && !/enviad|entregad/i.test(copy.message),
      `estado ${status} no debe insinuar "enviado/entregado": ${copy.label} / ${copy.message}`,
    );
  });
});
