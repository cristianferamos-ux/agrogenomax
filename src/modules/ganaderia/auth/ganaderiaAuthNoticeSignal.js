// SPRINT-3D10.5: señal de avisos de sesión/seguridad/red para el frontend
// de Ganadería. JS puro -- sin React, sin window, sin latch global (un
// latch sobreviviría al cambio de GanaderiaAuthProvider entre rutas y
// silenciaría el aviso de la sesión siguiente). La idempotencia vive en
// el estado del consumidor (ver nextAuthNotice).
//
// Nunca redirige, nunca hace logout, nunca refresca sesión, nunca
// reintenta -- solo notifica.

export const AUTH_NOTICE_KINDS = Object.freeze({
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  CSRF_REJECTED: 'CSRF_REJECTED',
  NETWORK_ERROR: 'NETWORK_ERROR',
});

// Mayor número = mayor prioridad. Un aviso nunca se degrada a uno menor.
const NOTICE_PRIORITY = Object.freeze({
  NETWORK_ERROR: 1,
  CSRF_REJECTED: 2,
  SESSION_EXPIRED: 3,
});

function isValidKind(kind) {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(NOTICE_PRIORITY, kind);
}

// Cada suscripción es una entrada propia -- suscribir dos veces la misma
// función produce dos entradas independientes y cada cleanup elimina solo
// la suya.
const subscriptions = new Set();

export function subscribeAuthNotice(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('subscribeAuthNotice requiere una función.');
  }
  const entry = { listener };
  subscriptions.add(entry);
  return function unsubscribeAuthNotice() {
    subscriptions.delete(entry);
  };
}

export function emitAuthNotice(kind) {
  if (!isValidKind(kind)) return;
  // Copia: un listener que se desuscribe durante la emisión no altera la
  // iteración en curso.
  for (const entry of [...subscriptions]) {
    try {
      entry.listener(kind);
    } catch {
      // Un listener que lanza nunca afecta a los demás ni al helper HTTP.
    }
  }
}

// Reducer puro: estado del aviso visible. Idempotente (mismo tipo = mismo
// estado) y monótono en prioridad (SESSION_EXPIRED > CSRF_REJECTED >
// NETWORK_ERROR).
export function nextAuthNotice(current, incoming) {
  if (!isValidKind(incoming)) return current ?? null;
  if (!isValidKind(current)) return incoming;
  return NOTICE_PRIORITY[incoming] > NOTICE_PRIORITY[current] ? incoming : current;
}
