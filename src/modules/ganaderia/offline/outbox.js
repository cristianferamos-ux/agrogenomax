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
//
// FASE 4E.1 -- campos opcionales (una operación anterior no los tiene):
//   claveOrden          cadena causal FIFO: 'repro:animal:<animalId>'
//   origen              { organizacionId, cuentaId } de quien la creó. Nunca se
//                       envía autenticada como otra cuenta ni se reasigna.
//   posibleEnServidor   true si pudo llegar al servidor (resultado incierto): se
//                       persiste ANTES de enviar. Con true la intención ya no
//                       puede cambiar: un id nuevo duplicaría el evento.
//   runtimeNoSoporta    { at } si este runtime no conoce el tipo de operación

export const OUTBOX_ESTADOS = Object.freeze({
  PENDIENTE: 'PENDIENTE',
  SINCRONIZANDO: 'SINCRONIZANDO',
  SINCRONIZADO: 'SINCRONIZADO',
  ERROR_REINTENTABLE: 'ERROR_REINTENTABLE',
  CONFLICTO: 'CONFLICTO',
  RECHAZADO: 'RECHAZADO',
  BLOQUEADA_POR_IDENTIDAD: 'BLOQUEADA_POR_IDENTIDAD',
});

export const REPRODUCCION_EVENTO_CREAR = 'REPRODUCCION_EVENTO_CREAR';
// FASE 4E.2B -- operaciones administrativas sobre un evento YA confirmado:
//   ANULAR    payload { animalId, eventoId, motivo }
//   CORREGIR  payload { animalId, eventoId, motivo, evento }
// Comparten la cadena del animal con CREAR, pero no crean un evento pendiente: nunca
// entran en la reconstrucción causal de eventos.
export const REPRODUCCION_EVENTO_ANULAR = 'REPRODUCCION_EVENTO_ANULAR';
export const REPRODUCCION_EVENTO_CORREGIR = 'REPRODUCCION_EVENTO_CORREGIR';

export const esOperacionAdministrativa = (tipo) => tipo === REPRODUCCION_EVENTO_ANULAR || tipo === REPRODUCCION_EVENTO_CORREGIR;
export const esOperacionReproductiva = (tipo) => tipo === REPRODUCCION_EVENTO_CREAR || esOperacionAdministrativa(tipo);

/**
 * Clave en el outbox de la operación administrativa de un evento: como es la misma
 * para ANULAR y CORREGIR, el store garantiza una sola por evento también entre
 * pestañas (mutate es atómico). Nunca viaja al servidor.
 */
export const claveOperacionAdministrativa = (eventoId) => `repro-admin:${eventoId}`;

/** Misma normalización que aplica el servidor al motivo antes de guardarlo. */
export function normalizarMotivo(motivo) {
  return typeof motivo === 'string' ? motivo.replace(/\r\n?/g, '\n').trim() : '';
}

export const ADVERTENCIA_CORRECCION_DIFERIDA = 'La corrección quedará pendiente y puede aplicarse más adelante cuando se restablezca la conexión. El estado reproductivo visible puede cambiar al sincronizar.';

export const ESTADOS_ENVIABLES = Object.freeze([OUTBOX_ESTADOS.PENDIENTE, OUTBOX_ESTADOS.ERROR_REINTENTABLE]);
export const ESTADOS_BLOQUEADOS = Object.freeze([OUTBOX_ESTADOS.CONFLICTO, OUTBOX_ESTADOS.RECHAZADO]);

/** Reenviar el mismo id solo repetiría estos errores: el servidor ya decidió sobre este dato. */
export const CODIGOS_SIN_REINTENTO = Object.freeze(['CONCILIACION_INTENCION_DISTINTA', 'CLIENT_OPERATION_ID_REUSED', 'EVENTO_YA_ANULADO', 'EVENTO_NOT_FOUND']);

/** Sin lock exclusivo, una operación SINCRONIZANDO más reciente puede estar enviándose en otro motor. */
export const SINCRONIZANDO_LEASE_MS = 2 * 60_000;

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 10 * 60_000;

/** Backoff exponencial con jitter (±20 %): 5 s, 10 s, 20 s ... máx. 10 min. */
export function backoffMs(intentos, random = Math.random) {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, intentos - 1));
  return Math.round(base * (0.8 + random() * 0.4));
}

/** Cadena causal de los eventos reproductivos de un animal confirmado por el servidor. */
export function claveOrdenAnimal(animalId) {
  return `repro:animal:${animalId}`;
}

/**
 * Siguiente createdAt de una cadena: nunca anterior ni igual al último, para
 * que un reloj del dispositivo que retrocede no altere el orden FIFO.
 */
export function instanteEnCadena(cadena, now) {
  const ultimo = cadena.reduce((max, op) => (op.createdAt > max ? op.createdAt : max), '');
  return ultimo && ultimo >= now.toISOString() ? new Date(new Date(ultimo).getTime() + 1) : now;
}

/** Intención normalizada de un evento: no depende del orden de sus campos. */
export function firmaIntencion(evento) {
  return JSON.stringify(Object.keys(evento).sort().map((campo) => [campo, evento[campo]]));
}

/** Lo que impide purgar la base de una organización, incluidas las bloqueadas por identidad. */
export function contarOutboxNoSincronizado(operaciones) {
  return operaciones.filter((op) => op.estado !== OUTBOX_ESTADOS.SINCRONIZADO).length;
}

const esIdentificador = (valor) => typeof valor === 'string' && valor.length > 0;

/** `origen` completo. Sin él no se puede demostrar de quién es: la operación no sale. */
export function origenVerificable(op) {
  return esIdentificador(op?.origen?.cuentaId) && esIdentificador(op?.origen?.organizacionId);
}

/** La operación es de esa cuenta. Sin `origen` verificable no es de nadie. */
export function identidadCoincide(op, cuentaId) {
  return origenVerificable(op) && op.origen.cuentaId === cuentaId;
}

export function newOperation({ tipoOperacion, entidad, localUuid, clientOperationId, payload, deviceId, now, uuid, claveOrden = null, origen = null }) {
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
    ...(claveOrden ? { claveOrden, origen, posibleEnServidor: false, runtimeNoSoporta: null } : {}),
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

/**
 * Operaciones a las que les toca salir: lo que los disparadores automáticos deben
 * mirar. Una operación retenida detrás de otra de su cadena (o de su mismo animal
 * local), en un tipo que este runtime no conoce o ya en conflicto NO cuenta: seguir
 * disparando por ella no la enviaría y mantendría un ciclo de sincronización sin fin.
 */
export function operacionesEnTurno(operaciones, { soportado = () => true } = {}) {
  const detenidas = new Set();
  const turno = [];
  const activa = (op) => ESTADOS_ENVIABLES.includes(op.estado) || op.estado === OUTBOX_ESTADOS.SINCRONIZANDO;
  for (const op of ordenarOutbox(operaciones)) {
    const clave = op.claveOrden ?? op.localUuid;
    if (detenidas.has(clave)) continue;
    if (!soportado(op) || !activa(op)) {
      detenidas.add(clave);
      continue;
    }
    if (op.claveOrden) detenidas.add(clave);
    turno.push(op);
  }
  return turno;
}

/**
 * El servidor pidió esperar (408/429/5xx) y la espera sigue vigente. Ninguna acción
 * manual la adelanta: una ráfaga contra un servidor que acaba de responder así solo
 * lo empeora. Un fallo de RED no entra aquí: no hubo respuesta que respetar.
 */
export function enBackoffHttp(op, now) {
  return op?.estado === OUTBOX_ESTADOS.ERROR_REINTENTABLE
    && !esErrorDeRed(op)
    && Boolean(op.siguienteIntentoAt)
    && op.siguienteIntentoAt > now.toISOString();
}

/**
 * `forzar` ("Sincronizar ahora", preparar) espera su turno y adelanta lo que solo
 * esperaba sin motivo del servidor, pero nunca un backoff HTTP vigente.
 */
export function estaLista(op, now, { forzar = false } = {}) {
  if (!ESTADOS_ENVIABLES.includes(op.estado)) return false;
  if (enBackoffHttp(op, now)) return false;
  if (forzar || !op.siguienteIntentoAt) return true;
  return op.siguienteIntentoAt <= now.toISOString();
}
