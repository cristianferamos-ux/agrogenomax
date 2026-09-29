// SPRINT-3D10.5 F3b: modelo puro (sin React, sin window) de la UX de
// avisos de sesión y del resultado del logout. Testeable con node:test;
// GanaderiaAuthNotice.jsx, GanaderiaAuthContext.jsx, GanaderiaSidebar.jsx y
// GanaderiaAdminShell.jsx solo lo consumen.
import { AUTH_NOTICE_KINDS } from './ganaderiaAuthNoticeSignal.js';
import { LOGOUT_OUTCOMES } from './ganaderiaAuthedRequest.js';

export const AUTH_NOTICE_CTA = Object.freeze({
  LOGIN: 'LOGIN',
  RELOAD: 'RELOAD',
});

export const AUTH_NOTICE_CONTENT = Object.freeze({
  [AUTH_NOTICE_KINDS.SESSION_EXPIRED]: Object.freeze({
    message: 'Tu sesión terminó. Inicia sesión nuevamente para continuar.',
    ctaLabel: 'Iniciar sesión',
    cta: AUTH_NOTICE_CTA.LOGIN,
    dismissible: false,
  }),
  [AUTH_NOTICE_KINDS.CSRF_REJECTED]: Object.freeze({
    message: 'No pudimos verificar la seguridad de esta solicitud y no se aplicó. Recarga la página e inténtalo de nuevo. Si el problema continúa, contacta a soporte.',
    ctaLabel: 'Recargar página',
    cta: AUTH_NOTICE_CTA.RELOAD,
    dismissible: true,
  }),
  [AUTH_NOTICE_KINDS.NETWORK_ERROR]: Object.freeze({
    message: 'Se perdió la conexión antes de recibir respuesta. No sabemos si la operación se guardó. Recarga para ver el estado actual antes de volver a intentarlo.',
    ctaLabel: 'Recargar página',
    cta: AUTH_NOTICE_CTA.RELOAD,
    dismissible: true,
  }),
});

export function getAuthNoticeContent(kind) {
  return AUTH_NOTICE_CONTENT[kind] ?? null;
}

// Cerrar un aviso: solo los cerrables vuelven a null. SESSION_EXPIRED
// nunca se descarta -- la única salida es el CTA "Iniciar sesión".
export function dismissAuthNotice(current) {
  const content = getAuthNoticeContent(current);
  if (!content) return null;
  return content.dismissible ? null : current;
}

// Un aviso solo tiene sentido mientras hay una sesión local vigente. Tras
// terminar la sesión localmente (CTA/logout) o durante la carga, una
// respuesta tardía de una request en vuelo nunca reabre el banner.
export function shouldAcceptAuthNotice(status) {
  return status === 'authenticated' || status === 'authenticated_without_org';
}

const LOGOUT_GENERIC_ERROR = 'No fue posible cerrar la sesión. Intenta nuevamente.';

const LOGOUT_UI_ACTIONS = Object.freeze({
  [LOGOUT_OUTCOMES.LOGGED_OUT]: Object.freeze({ endSession: true, message: null }),
  [LOGOUT_OUTCOMES.ALREADY_LOGGED_OUT]: Object.freeze({ endSession: true, message: null }),
  [LOGOUT_OUTCOMES.CSRF_REJECTED]: Object.freeze({
    endSession: false,
    message: 'No pudimos cerrar la sesión de forma segura. Recarga la página e inténtalo de nuevo.',
  }),
  [LOGOUT_OUTCOMES.NETWORK_ERROR]: Object.freeze({
    endSession: false,
    message: 'No fue posible confirmar el cierre de sesión. Verifica tu conexión e inténtalo nuevamente.',
  }),
  [LOGOUT_OUTCOMES.FAILED]: Object.freeze({ endSession: false, message: LOGOUT_GENERIC_ERROR }),
});

// Resultado desconocido -> genérico, nunca termina la sesión local.
export function resolveLogoutUiAction(outcome) {
  return LOGOUT_UI_ACTIONS[outcome] ?? LOGOUT_UI_ACTIONS[LOGOUT_OUTCOMES.FAILED];
}
