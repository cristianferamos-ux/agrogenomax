// SPRINT-3D11.3 (R1) -- outbox persistente (store 'outbox' de la base de
// la organización). Genérico: cualquier módulo (animales hoy; pesajes,
// vacunas, tratamientos, reproducción, observaciones mañana) encola
// operaciones con este mismo formato y registra su manejador en
// operationHandlers.js.
//
// Operación:
//   operationId         UUID local de la operación (clave del store)
//   clientOperationId   UUID de idempotencia que viaja al servidor
//   tipoOperacion       'ANIMAL_CREAR' | 'ANIMAL_CREAR_CON_CHAPETA' | 'PESAJE_CREAR' (FASE 1D.1) | ...
//   entidad             'animal' | 'pesaje' | ...
//   localUuid           entidad local afectada (un pesaje pendiente tiene el suyo propio:
//                       un pesaje bloqueado nunca frena a los demás)
//   payload             cuerpo de la escritura (sin secretos)
//   createdAt, updatedAt  ISO
//   estado              PENDIENTE | SINCRONIZANDO | SINCRONIZADO | ERROR_REINTENTABLE | CONFLICTO | RECHAZADO
//   intentos            número de envíos realizados
//   ultimoError         { codigo, mensaje, status, tipo? } | null
//                       tipo (FASE-14, opcional): 'red' (sin respuesta) | 'http' (408/429/5xx).
//                       Operaciones anteriores sin `tipo` se interpretan por status (0 = red).
//   siguienteIntentoAt  ISO | null (backoff)
//   deviceId            dispositivo que la creó
// SINCRONIZADO es transitorio: al confirmarse, la operación se elimina del
// store (el outbox queda vacío cuando todo está sincronizado).

export const OUTBOX_ESTADOS = Object.freeze({
  PENDIENTE: 'PENDIENTE',
  SINCRONIZANDO: 'SINCRONIZANDO',
  SINCRONIZADO: 'SINCRONIZADO',
  ERROR_REINTENTABLE: 'ERROR_REINTENTABLE',
  CONFLICTO: 'CONFLICTO',
  RECHAZADO: 'RECHAZADO',
});

export const ESTADOS_ENVIABLES = Object.freeze([OUTBOX_ESTADOS.PENDIENTE, OUTBOX_ESTADOS.ERROR_REINTENTABLE]);
export const ESTADOS_BLOQUEADOS = Object.freeze([OUTBOX_ESTADOS.CONFLICTO, OUTBOX_ESTADOS.RECHAZADO]);

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 10 * 60_000;

/** Backoff exponencial con jitter (±20 %): 5 s, 10 s, 20 s ... máx. 10 min. */
export function backoffMs(intentos, random = Math.random) {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, intentos - 1));
  return Math.round(base * (0.8 + random() * 0.4));
}

export function newOperation({ tipoOperacion, entidad, localUuid, clientOperationId, payload, deviceId, now, uuid }) {
  const at = now.toISOString();
  return {
    operationId: uuid(),
    clientOperationId,
    tipoOperacion,
    entidad,
    localUuid,
    payload,
    createdAt: at,
    updatedAt: at,
    estado: OUTBOX_ESTADOS.PENDIENTE,
    intentos: 0,
    ultimoError: null,
    siguienteIntentoAt: null,
    deviceId,
  };
}

/** Orden de envío: por creación (las dependencias entre entidades se respetan). */
export function ordenarOutbox(operations) {
  return [...operations].sort((a, b) => (a.createdAt === b.createdAt ? a.operationId.localeCompare(b.operationId) : a.createdAt.localeCompare(b.createdAt)));
}

/** El último fallo fue de red (no un 408/429/5xx). Compatible con operaciones sin `tipo`. */
export function esErrorDeRed(op) {
  const error = op?.ultimoError;
  if (!error) return false;
  if (error.tipo) return error.tipo === 'red';
  return (error.status ?? 0) === 0;
}

export function estaLista(op, now, { forzar = false } = {}) {
  if (!ESTADOS_ENVIABLES.includes(op.estado)) return false;
  if (forzar || !op.siguienteIntentoAt) return true;
  return op.siguienteIntentoAt <= now.toISOString();
}
