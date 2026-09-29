// SPRINT-3D10.5 F3a: señal de avisos -- fan-out puro, sin latch global.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_NOTICE_KINDS,
  emitAuthNotice,
  nextAuthNotice,
  subscribeAuthNotice,
} from '../ganaderiaAuthNoticeSignal.js';

test('varios listeners reciben el aviso', () => {
  const a = [];
  const b = [];
  const offA = subscribeAuthNotice((k) => a.push(k));
  const offB = subscribeAuthNotice((k) => b.push(k));
  emitAuthNotice('SESSION_EXPIRED');
  offA();
  offB();
  assert.deepEqual(a, ['SESSION_EXPIRED']);
  assert.deepEqual(b, ['SESSION_EXPIRED']);
});

test('cleanup elimina el listener: no recibe avisos posteriores', () => {
  const got = [];
  const off = subscribeAuthNotice((k) => got.push(k));
  off();
  emitAuthNotice('SESSION_EXPIRED');
  assert.deepEqual(got, []);
});

test('cleanup es idempotente y solo elimina su propia suscripción (misma función suscrita dos veces)', () => {
  const got = [];
  const listener = (k) => got.push(k);
  const off1 = subscribeAuthNotice(listener);
  const off2 = subscribeAuthNotice(listener);
  off1();
  off1();
  emitAuthNotice('NETWORK_ERROR');
  off2();
  emitAuthNotice('NETWORK_ERROR');
  assert.deepEqual(got, ['NETWORK_ERROR']);
});

test('un listener que lanza no afecta a los demás', () => {
  const got = [];
  const off1 = subscribeAuthNotice(() => {
    throw new Error('boom');
  });
  const off2 = subscribeAuthNotice((k) => got.push(k));
  assert.doesNotThrow(() => emitAuthNotice('CSRF_REJECTED'));
  off1();
  off2();
  assert.deepEqual(got, ['CSRF_REJECTED']);
});

test('un listener que se desuscribe durante la emisión no altera la iteración en curso', () => {
  const got = [];
  let off1;
  off1 = subscribeAuthNotice(() => off1());
  const off2 = subscribeAuthNotice((k) => got.push(k));
  emitAuthNotice('SESSION_EXPIRED');
  off2();
  assert.deepEqual(got, ['SESSION_EXPIRED']);
});

test('tipos inválidos se ignoran', () => {
  const got = [];
  const off = subscribeAuthNotice((k) => got.push(k));
  emitAuthNotice('LOGOUT');
  emitAuthNotice(undefined);
  emitAuthNotice('toString');
  off();
  assert.deepEqual(got, []);
});

test('sin latch global: el mismo aviso se re-emite a suscriptores nuevos (Provider por ruta)', () => {
  const first = [];
  const offFirst = subscribeAuthNotice((k) => first.push(k));
  emitAuthNotice('SESSION_EXPIRED');
  offFirst();
  const second = [];
  const offSecond = subscribeAuthNotice((k) => second.push(k));
  emitAuthNotice('SESSION_EXPIRED');
  offSecond();
  assert.deepEqual(first, ['SESSION_EXPIRED']);
  assert.deepEqual(second, ['SESSION_EXPIRED']);
});

test('subscribeAuthNotice rechaza no-funciones', () => {
  assert.throws(() => subscribeAuthNotice(null), TypeError);
});

test('AUTH_NOTICE_KINDS es inmutable', () => {
  assert.ok(Object.isFrozen(AUTH_NOTICE_KINDS));
  assert.deepEqual(Object.keys(AUTH_NOTICE_KINDS).sort(), ['CSRF_REJECTED', 'NETWORK_ERROR', 'SESSION_EXPIRED']);
});

// 19 -- reducer puro de idempotencia/prioridad
test('nextAuthNotice: idempotente (mismo tipo = mismo estado)', () => {
  for (const kind of ['SESSION_EXPIRED', 'CSRF_REJECTED', 'NETWORK_ERROR']) {
    assert.equal(nextAuthNotice(kind, kind), kind);
  }
});

test('nextAuthNotice: desde null toma el aviso entrante', () => {
  assert.equal(nextAuthNotice(null, 'NETWORK_ERROR'), 'NETWORK_ERROR');
});

test('nextAuthNotice: prioridad SESSION_EXPIRED > CSRF_REJECTED > NETWORK_ERROR y nunca degrada', () => {
  assert.equal(nextAuthNotice('NETWORK_ERROR', 'CSRF_REJECTED'), 'CSRF_REJECTED');
  assert.equal(nextAuthNotice('CSRF_REJECTED', 'SESSION_EXPIRED'), 'SESSION_EXPIRED');
  assert.equal(nextAuthNotice('SESSION_EXPIRED', 'NETWORK_ERROR'), 'SESSION_EXPIRED');
  assert.equal(nextAuthNotice('SESSION_EXPIRED', 'CSRF_REJECTED'), 'SESSION_EXPIRED');
  assert.equal(nextAuthNotice('CSRF_REJECTED', 'NETWORK_ERROR'), 'CSRF_REJECTED');
});

test('nextAuthNotice: ráfaga de avisos (paneles múltiples) converge a un único aviso', () => {
  const burst = ['NETWORK_ERROR', 'SESSION_EXPIRED', 'SESSION_EXPIRED', 'CSRF_REJECTED', 'SESSION_EXPIRED'];
  assert.equal(burst.reduce(nextAuthNotice, null), 'SESSION_EXPIRED');
});

test('nextAuthNotice: entrante inválido conserva el estado', () => {
  assert.equal(nextAuthNotice('CSRF_REJECTED', 'X'), 'CSRF_REJECTED');
  assert.equal(nextAuthNotice(null, undefined), null);
});
