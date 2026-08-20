// SPRINT-3D3-POTREROS-API-FOUNDATION: pruebas del candidate store de
// Potreros en memoria (state machine AVAILABLE -> PROCESSING -> CONSUMED,
// TTL, single-use, concurrencia, y el scoping adicional por predioId que
// no existe en prediosCandidateStore.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPotreroCandidate,
  reservePotreroCandidate,
  commitPotreroCandidate,
  releasePotreroCandidate,
  __resetPotrerosCandidateStoreForTests,
  __hasPotreroCandidateForTests,
  __getPotreroCandidateStateForTests,
} from '../ganaderia/potrerosCandidateStore.js';

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const CUENTA_A = 'cuenta-a';
const CUENTA_A2 = 'cuenta-a2';
const CUENTA_B = 'cuenta-b';
const PREDIO_LA_PRIMAVERA = '101';
const PREDIO_OTRO = '202';
const SAMPLE_GEOMETRY = { type: 'Polygon', coordinates: [[[-75.5, 1.3], [-75.4, 1.3], [-75.4, 1.4], [-75.5, 1.3]]] };

function candidatePayload(overrides = {}) {
  return {
    organizacionId: ORG_A,
    cuentaId: CUENTA_A,
    predioId: PREDIO_LA_PRIMAVERA,
    geometry: SAMPLE_GEOMETRY,
    areaHa: 5.2,
    metodoDelimitacion: 'coordenadas',
    ...overrides,
  };
}

test.beforeEach(() => {
  __resetPotrerosCandidateStoreForTests();
});

// K: candidate ligado a predio.
test('createPotreroCandidate: estado inicial AVAILABLE, candidateId no predecible', () => {
  const id1 = createPotreroCandidate(candidatePayload());
  const id2 = createPotreroCandidate(candidatePayload());
  assert.equal(__getPotreroCandidateStateForTests(id1), 'AVAILABLE');
  assert.notEqual(id1, id2);
  assert.match(id1.replace('potcand_', ''), /^[A-Za-z0-9_-]{40,}$/);
});

test('reservePotreroCandidate + commitPotreroCandidate: el dueño reserva y confirma sobre el predio correcto', () => {
  const candidateId = createPotreroCandidate(candidatePayload());

  const reserved = reservePotreroCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A, predioId: PREDIO_LA_PRIMAVERA });
  assert.equal(reserved.status, 'ok');
  assert.deepEqual(reserved.geometry, SAMPLE_GEOMETRY);
  assert.equal(reserved.areaHa, 5.2);
  assert.equal(reserved.metodoDelimitacion, 'coordenadas');
  assert.equal(__getPotreroCandidateStateForTests(candidateId), 'PROCESSING');

  commitPotreroCandidate(candidateId);
  assert.equal(__getPotreroCandidateStateForTests(candidateId), 'CONSUMED');
});

// K (regla crítica del dominio): candidate de LA PRIMAVERA no puede
// confirmarse usando otro predioId, aunque sea la misma cuenta/org.
test('reservePotreroCandidate: mismo dueño pero OTRO predioId -> scope_mismatch (no crea el potrero en el predio equivocado)', () => {
  const candidateId = createPotreroCandidate(candidatePayload());
  const result = reservePotreroCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A, predioId: PREDIO_OTRO });
  assert.equal(result.status, 'scope_mismatch');
  assert.equal(__getPotreroCandidateStateForTests(candidateId), 'AVAILABLE', 'scope_mismatch no debe consumir ni bloquear el candidate');
});

// L: candidate ligado a cuenta/organización (cross-tenant real).
test('reservePotreroCandidate: otra organización -> forbidden (nunca scope_mismatch, no revela nada del predio)', () => {
  const candidateId = createPotreroCandidate(candidatePayload());
  const result = reservePotreroCandidate({ candidateId, organizacionId: ORG_B, cuentaId: CUENTA_B, predioId: PREDIO_LA_PRIMAVERA });
  assert.equal(result.status, 'forbidden');
});

test('reservePotreroCandidate: otra cuenta de la misma organización -> forbidden', () => {
  const candidateId = createPotreroCandidate(candidatePayload());
  const result = reservePotreroCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A2, predioId: PREDIO_LA_PRIMAVERA });
  assert.equal(result.status, 'forbidden');
});

// M: TTL.
test('reservePotreroCandidate: candidato expirado -> expired, y se elimina del store', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const candidateId = createPotreroCandidate(candidatePayload());

  t.mock.timers.tick(15 * 60 * 1000 + 1);

  const result = reservePotreroCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A, predioId: PREDIO_LA_PRIMAVERA });
  assert.equal(result.status, 'expired');
  assert.equal(__hasPotreroCandidateForTests(candidateId), false);
});

// N: single-use.
test('reservePotreroCandidate: segundo intento sobre un candidato ya CONSUMED -> consumed', () => {
  const candidateId = createPotreroCandidate(candidatePayload());
  const first = reservePotreroCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A, predioId: PREDIO_LA_PRIMAVERA });
  assert.equal(first.status, 'ok');
  commitPotreroCandidate(candidateId);

  const second = reservePotreroCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A, predioId: PREDIO_LA_PRIMAVERA });
  assert.equal(second.status, 'consumed');
});

test('reservePotreroCandidate: candidateId inexistente/alterado -> not_found', () => {
  const candidateId = createPotreroCandidate(candidatePayload());
  const tampered = `${candidateId}x`;
  const result = reservePotreroCandidate({ candidateId: tampered, organizacionId: ORG_A, cuentaId: CUENTA_A, predioId: PREDIO_LA_PRIMAVERA });
  assert.equal(result.status, 'not_found');
});

// Concurrencia (§8): dos reservas sobre el mismo candidateId, solo una gana.
test('reservePotreroCandidate: dos reservas concurrentes -> solo una gana, la otra ve in_use', () => {
  const candidateId = createPotreroCandidate(candidatePayload());

  const first = reservePotreroCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A, predioId: PREDIO_LA_PRIMAVERA });
  const second = reservePotreroCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A, predioId: PREDIO_LA_PRIMAVERA });

  assert.equal(first.status, 'ok');
  assert.equal(second.status, 'in_use');
});

// O: rollback candidate si la transacción de negocio falla.
test('releasePotreroCandidate: tras un fallo de negocio, el candidato vuelve a AVAILABLE y puede reintentarse', () => {
  const candidateId = createPotreroCandidate(candidatePayload());

  const reserved = reservePotreroCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A, predioId: PREDIO_LA_PRIMAVERA });
  assert.equal(reserved.status, 'ok');

  releasePotreroCandidate(candidateId);
  assert.equal(__getPotreroCandidateStateForTests(candidateId), 'AVAILABLE');

  const retried = reservePotreroCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A, predioId: PREDIO_LA_PRIMAVERA });
  assert.equal(retried.status, 'ok');
});

test('releasePotreroCandidate: no-op si el candidato ya está CONSUMED (nunca revierte un commit)', () => {
  const candidateId = createPotreroCandidate(candidatePayload());
  reservePotreroCandidate({ candidateId, organizacionId: ORG_A, cuentaId: CUENTA_A, predioId: PREDIO_LA_PRIMAVERA });
  commitPotreroCandidate(candidateId);

  releasePotreroCandidate(candidateId);
  assert.equal(__getPotreroCandidateStateForTests(candidateId), 'CONSUMED');
});

test('releasePotreroCandidate/commitPotreroCandidate: no-op silencioso sobre candidateId inexistente', () => {
  assert.doesNotThrow(() => releasePotreroCandidate('potcand_does-not-exist'));
  assert.doesNotThrow(() => commitPotreroCandidate('potcand_does-not-exist'));
});
