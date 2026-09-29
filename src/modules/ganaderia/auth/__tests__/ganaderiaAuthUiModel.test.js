// SPRINT-3D10.5 F3b: modelo puro de la UX de avisos de sesión y logout.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_NOTICE_CONTENT,
  AUTH_NOTICE_CTA,
  dismissAuthNotice,
  getAuthNoticeContent,
  resolveLogoutUiAction,
  shouldAcceptAuthNotice,
} from '../ganaderiaAuthUiModel.js';
import { nextAuthNotice } from '../ganaderiaAuthNoticeSignal.js';
import { LOGOUT_OUTCOMES } from '../ganaderiaAuthedRequest.js';

// 1/2 -- prioridad + idempotencia (el Provider usa exactamente este reducer)
test('prioridad SESSION_EXPIRED > CSRF_REJECTED > NETWORK_ERROR y repetición idempotente', () => {
  assert.equal(['NETWORK_ERROR', 'CSRF_REJECTED'].reduce(nextAuthNotice, null), 'CSRF_REJECTED');
  assert.equal(['CSRF_REJECTED', 'SESSION_EXPIRED', 'NETWORK_ERROR'].reduce(nextAuthNotice, null), 'SESSION_EXPIRED');
  assert.equal(['NETWORK_ERROR', 'NETWORK_ERROR', 'NETWORK_ERROR'].reduce(nextAuthNotice, null), 'NETWORK_ERROR');
});

// 3
test('SESSION_EXPIRED: copy exacto, CTA "Iniciar sesión" (LOGIN), NO cerrable', () => {
  const c = getAuthNoticeContent('SESSION_EXPIRED');
  assert.equal(c.message, 'Tu sesión terminó. Inicia sesión nuevamente para continuar.');
  assert.equal(c.ctaLabel, 'Iniciar sesión');
  assert.equal(c.cta, AUTH_NOTICE_CTA.LOGIN);
  assert.equal(c.dismissible, false);
  assert.equal(dismissAuthNotice('SESSION_EXPIRED'), 'SESSION_EXPIRED');
});

// 4
test('CSRF_REJECTED: copy exacto, CTA "Recargar página", cerrable, nunca menciona sesión expirada', () => {
  const c = getAuthNoticeContent('CSRF_REJECTED');
  assert.equal(
    c.message,
    'No pudimos verificar la seguridad de esta solicitud y no se aplicó. Recarga la página e inténtalo de nuevo. Si el problema continúa, contacta a soporte.',
  );
  assert.equal(c.ctaLabel, 'Recargar página');
  assert.equal(c.cta, AUTH_NOTICE_CTA.RELOAD);
  assert.equal(c.dismissible, true);
  assert.doesNotMatch(c.message, /sesión terminó|sesión expir/i);
  assert.equal(dismissAuthNotice('CSRF_REJECTED'), null);
});

// 5
test('NETWORK_ERROR: copy exacto (resultado incierto, no invita a repetir), CTA "Recargar página", cerrable', () => {
  const c = getAuthNoticeContent('NETWORK_ERROR');
  assert.equal(
    c.message,
    'Se perdió la conexión antes de recibir respuesta. No sabemos si la operación se guardó. Recarga para ver el estado actual antes de volver a intentarlo.',
  );
  assert.equal(c.ctaLabel, 'Recargar página');
  assert.equal(c.cta, AUTH_NOTICE_CTA.RELOAD);
  assert.equal(c.dismissible, true);
  assert.equal(dismissAuthNotice('NETWORK_ERROR'), null);
});

test('contenido inmutable y sin avisos desconocidos', () => {
  assert.ok(Object.isFrozen(AUTH_NOTICE_CONTENT));
  assert.deepEqual(Object.keys(AUTH_NOTICE_CONTENT).sort(), ['CSRF_REJECTED', 'NETWORK_ERROR', 'SESSION_EXPIRED']);
  assert.equal(getAuthNoticeContent('LOGOUT'), null);
  assert.equal(getAuthNoticeContent(null), null);
  assert.equal(dismissAuthNotice(null), null);
});

// 7 -- el Provider solo acepta avisos con sesión local vigente: tras el CTA
// o el logout (anonymous) una respuesta tardía nunca reabre el banner.
test('shouldAcceptAuthNotice: solo con sesión local vigente', () => {
  assert.equal(shouldAcceptAuthNotice('authenticated'), true);
  assert.equal(shouldAcceptAuthNotice('authenticated_without_org'), true);
  assert.equal(shouldAcceptAuthNotice('anonymous'), false);
  assert.equal(shouldAcceptAuthNotice('loading'), false);
});

// 9-13 -- resultado del logout -> acción de UI
test('logout LOGGED_OUT y ALREADY_LOGGED_OUT: terminan la sesión local, sin mensaje', () => {
  for (const outcome of [LOGOUT_OUTCOMES.LOGGED_OUT, LOGOUT_OUTCOMES.ALREADY_LOGGED_OUT]) {
    assert.deepEqual({ ...resolveLogoutUiAction(outcome) }, { endSession: true, message: null });
  }
});

test('logout CSRF_REJECTED: permanece autenticado con mensaje humano', () => {
  const a = resolveLogoutUiAction(LOGOUT_OUTCOMES.CSRF_REJECTED);
  assert.equal(a.endSession, false);
  assert.equal(a.message, 'No pudimos cerrar la sesión de forma segura. Recarga la página e inténtalo de nuevo.');
});

test('logout NETWORK_ERROR: permanece autenticado con el copy exacto', () => {
  const a = resolveLogoutUiAction(LOGOUT_OUTCOMES.NETWORK_ERROR);
  assert.equal(a.endSession, false);
  assert.equal(a.message, 'No fue posible confirmar el cierre de sesión. Verifica tu conexión e inténtalo nuevamente.');
});

test('logout FAILED o desconocido: comportamiento genérico previo, permanece autenticado', () => {
  for (const outcome of [LOGOUT_OUTCOMES.FAILED, 'X', undefined]) {
    const a = resolveLogoutUiAction(outcome);
    assert.equal(a.endSession, false);
    assert.equal(a.message, 'No fue posible cerrar la sesión. Intenta nuevamente.');
  }
});

test('ningún mensaje de logout usa el copy engañoso "No fue posible conectar con el servicio"', () => {
  for (const outcome of Object.values(LOGOUT_OUTCOMES)) {
    assert.doesNotMatch(String(resolveLogoutUiAction(outcome).message), /conectar con el servicio/);
  }
});
