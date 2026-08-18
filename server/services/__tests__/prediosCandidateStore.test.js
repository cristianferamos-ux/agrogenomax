// SPRINT-3C1-MIS-PREDIOS-API §23 + SPRINT-3C1.1 §1/§3: pruebas del
// candidate store en memoria (server/services/ganaderia/prediosCandidateStore.js),
// incluida la state machine AVAILABLE -> PROCESSING -> CONSUMED (con
// release() de vuelta a AVAILABLE tras un fallo de negocio).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPredioCandidate,
  reservePredioCandidate,
  commitPredioCandidate,
  releasePredioCandidate,
  __resetPrediosCandidateStoreForTests,
  __hasPredioCandidateForTests,
  __getPredioCandidateStateForTests,
} from '../ganaderia/prediosCandidateStore.js';

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const CUENTA_A = 'cuenta-a';
const CUENTA_A2 = 'cuenta-a2'; // otra cuenta de la MISMA organización A
const CUENTA_B = 'cuenta-b';
const SAMPLE_PREDIO = { codigoPredial: '186001000000000010001000000000', nombrePredio: 'Finca X' };

test.beforeEach(() => {
  __resetPrediosCandidateStoreForTests();
});

test('createPredioCandidate: estado inicial AVAILABLE', () => {
  const candidateId = createPredioCandidate({ organizacionId: ORG_A, cuentaId: CUENTA_A, predio: SAMPLE_PREDIO });
  assert.equal(__getPredioCandidateStateForTests(candidateId), 'AVAILABLE');
});

// 1/2: candidato A creado, A puede reservarlo y confirmarlo.
test('reservePredioCandidate + commitPredioCandidate: el dueño reserva y confirma su propio candidato', () => {
  const candidateId = createPredioCandidate({ organizacionId: ORG_A, cuentaId: CUENTA_A, predio: SAMPLE_PREDIO });

  const reserved = reservePredioCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A });
  assert.equal(reserved.status, 'ok');
  assert.deepEqual(reserved.predio, SAMPLE_PREDIO);
  assert.equal(__getPredioCandidateStateForTests(candidateId), 'PROCESSING');

  commitPredioCandidate(candidateId);
  assert.equal(__getPredioCandidateStateForTests(candidateId), 'CONSUMED');
});

// 3: B (otra organización) no puede reservarlo.
test('reservePredioCandidate: otra organización -> forbidden', () => {
  const candidateId = createPredioCandidate({ organizacionId: ORG_A, cuentaId: CUENTA_A, predio: SAMPLE_PREDIO });
  const result = reservePredioCandidate({ candidateId, organizacionId: ORG_B, cuentaId: CUENTA_B });
  assert.equal(result.status, 'forbidden');
  assert.equal(__getPredioCandidateStateForTests(candidateId), 'AVAILABLE', 'un intento forbidden no debe cambiar el estado');
});

// 4: otra cuenta (misma organización) no puede reservarlo -- MVP: ligado a cuenta + organización.
test('reservePredioCandidate: otra cuenta de la misma organización -> forbidden', () => {
  const candidateId = createPredioCandidate({ organizacionId: ORG_A, cuentaId: CUENTA_A, predio: SAMPLE_PREDIO });
  const result = reservePredioCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A2 });
  assert.equal(result.status, 'forbidden');
});

// 5: expirado no funciona.
test('reservePredioCandidate: candidato expirado -> expired, y se elimina del store', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const candidateId = createPredioCandidate({ organizacionId: ORG_A, cuentaId: CUENTA_A, predio: SAMPLE_PREDIO });

  t.mock.timers.tick(15 * 60 * 1000 + 1);

  const result = reservePredioCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A });
  assert.equal(result.status, 'expired');
  assert.equal(__hasPredioCandidateForTests(candidateId), false);
});

// 6: consumido no funciona dos veces.
test('reservePredioCandidate: segundo intento sobre un candidato ya CONSUMED -> consumed', () => {
  const candidateId = createPredioCandidate({ organizacionId: ORG_A, cuentaId: CUENTA_A, predio: SAMPLE_PREDIO });
  const first = reservePredioCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A });
  assert.equal(first.status, 'ok');
  commitPredioCandidate(candidateId);

  const second = reservePredioCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A });
  assert.equal(second.status, 'consumed');
});

// 8: candidateId alterado/inexistente rechazado.
test('reservePredioCandidate: candidateId inexistente/alterado -> not_found', () => {
  const candidateId = createPredioCandidate({ organizacionId: ORG_A, cuentaId: CUENTA_A, predio: SAMPLE_PREDIO });
  const tampered = `${candidateId}x`;
  const result = reservePredioCandidate({ candidateId: tampered, organizacionId: ORG_A, cuentaId: CUENTA_A });
  assert.equal(result.status, 'not_found');

  const random = reservePredioCandidate({ candidateId: 'pcand_does-not-exist', organizacionId: ORG_A, cuentaId: CUENTA_A });
  assert.equal(random.status, 'not_found');
});

test('createPredioCandidate: candidateId no es secuencial ni predecible', () => {
  const id1 = createPredioCandidate({ organizacionId: ORG_A, cuentaId: CUENTA_A, predio: SAMPLE_PREDIO });
  const id2 = createPredioCandidate({ organizacionId: ORG_A, cuentaId: CUENTA_A, predio: SAMPLE_PREDIO });
  assert.notEqual(id1, id2);
  // 32 bytes en base64url son 43 caracteres -- suficiente entropía, no un contador.
  assert.match(id1.replace('pcand_', ''), /^[A-Za-z0-9_-]{40,}$/);
});

// ---------------------------------------------------------------------
// SPRINT-3C1.1 §1/§2/§3: state machine -- concurrencia y release()
// ---------------------------------------------------------------------

// C: dos reservas "concurrentes" sobre el MISMO candidateId -- solo una
// puede ganar. reservePredioCandidate() es síncrona (sin await interno),
// así que dos llamadas consecutivas sin awaits entre medio son la
// simulación fiel de dos solicitudes HTTP concurrentes cuyo primer paso
// (reserve, antes de abrir la transacción DB) ocurre en el mismo tick.
test('reservePredioCandidate: dos reservas concurrentes sobre el mismo candidato -> solo una gana, la otra ve in_use', () => {
  const candidateId = createPredioCandidate({ organizacionId: ORG_A, cuentaId: CUENTA_A, predio: SAMPLE_PREDIO });

  const first = reservePredioCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A });
  const second = reservePredioCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A });

  assert.equal(first.status, 'ok');
  assert.equal(second.status, 'in_use');
  assert.equal(__getPredioCandidateStateForTests(candidateId), 'PROCESSING');
});

test('releasePredioCandidate: tras un fallo de negocio, el candidato vuelve a AVAILABLE y puede reservarse de nuevo', () => {
  const candidateId = createPredioCandidate({ organizacionId: ORG_A, cuentaId: CUENTA_A, predio: SAMPLE_PREDIO });

  const reserved = reservePredioCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A });
  assert.equal(reserved.status, 'ok');

  releasePredioCandidate(candidateId);
  assert.equal(__getPredioCandidateStateForTests(candidateId), 'AVAILABLE');

  const retried = reservePredioCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A });
  assert.equal(retried.status, 'ok');
});

test('releasePredioCandidate: no-op si el candidato ya está CONSUMED (nunca revierte un commit)', () => {
  const candidateId = createPredioCandidate({ organizacionId: ORG_A, cuentaId: CUENTA_A, predio: SAMPLE_PREDIO });
  reservePredioCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A });
  commitPredioCandidate(candidateId);

  releasePredioCandidate(candidateId);
  assert.equal(__getPredioCandidateStateForTests(candidateId), 'CONSUMED');
});

test('releasePredioCandidate/commitPredioCandidate: no-op silencioso sobre candidateId inexistente', () => {
  assert.doesNotThrow(() => releasePredioCandidate('pcand_does-not-exist'));
  assert.doesNotThrow(() => commitPredioCandidate('pcand_does-not-exist'));
});
