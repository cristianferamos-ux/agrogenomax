// FASE 4E.1 -- modelo PURO de la UI de eventos reproductivos sin conexión (sin
// React ni red). Un evento pendiente vive en el outbox, se presenta SEPARADO del
// historial confirmado y no entra en el estado reproductivo, alertas, analítica ni
// PDF hasta que el servidor lo confirma. Estos permisos son solo UX: el repositorio
// y el servidor vuelven a comprobar cuenta, estado y rol.
import { derivarEstadoReproductivo } from '../engine/reproduccion.js';
import {
  ADVERTENCIA_CORRECCION_DIFERIDA,
  CODIGOS_SIN_REINTENTO,
  OUTBOX_ESTADOS,
  REPRODUCCION_EVENTO_ANULAR,
  REPRODUCCION_EVENTO_CORREGIR,
  esErrorDeRed,
  esOperacionAdministrativa,
} from '../offline/outbox.js';
import { MENSAJES_ERROR_REPRODUCCION, ordenarHistorial, torosDesdeListado } from './reproduccionModel.js';

export { ADVERTENCIA_CORRECCION_DIFERIDA };
export const MENSAJE_EVENTO_PENDIENTE = 'Evento guardado en este dispositivo. Está pendiente de sincronización y aún no cuenta para el estado reproductivo.';
export const MENSAJE_ANULACION_PENDIENTE = 'Anulación guardada en este dispositivo. Está pendiente de sincronización y el evento sigue contando hasta que el servidor la confirme.';
export const MENSAJE_CORRECCION_PENDIENTE = `Corrección guardada en este dispositivo. ${ADVERTENCIA_CORRECCION_DIFERIDA}`;
export const MENSAJE_ADMIN_NO_CONFIRMADA = 'No se recibió confirmación del servidor. La operación se conservó en este dispositivo y se reintentará con el mismo identificador.';
export const MENSAJE_GUARDADO_LOCAL = 'No se pudo guardar el evento en este dispositivo. Intenta nuevamente.';
export const TEXTO_COPIA_LOCAL = 'Copia guardada en este dispositivo: puede no incluir los últimos cambios del servidor.';
export const TEXTO_PENDIENTES_NO_CUENTAN = 'Aún no están confirmados: no cambian el estado reproductivo ni la fecha probable de parto.';

const BLOQUEOS_IDENTIDAD = Object.freeze({
  IDENTIDAD_NO_COINCIDE: 'Lo registró otra cuenta. Se enviará cuando esa cuenta inicie sesión en este dispositivo.',
  SESION_NO_VERIFICABLE: 'No se pudo verificar la sesión. Se enviará cuando se confirme la cuenta que lo registró.',
  ORIGEN_NO_VERIFICABLE: 'No se puede confirmar qué cuenta lo registró, así que no se enviará.',
});

const BLOQUEOS_SERVIDOR = Object.freeze({
  CONCILIACION_INTENCION_DISTINTA: 'El servidor tiene este registro con datos distintos. Revísalo en la ficha antes de descartarlo.',
  CLIENT_OPERATION_ID_REUSED: 'Este registro ya existe en el servidor con otros datos.',
  ROLE_FORBIDDEN: 'Tu rol actual no permite esta operación reproductiva.',
});

const SESION_EXPIRADA = new Set(['SESSION_EXPIRED', 'CSRF_REJECTED']);

/** Motivo de un evento que no se sincronizó (nunca el `message` del servidor). */
export function mensajeBloqueoReproduccion(codigo) {
  return BLOQUEOS_IDENTIDAD[codigo]
    ?? BLOQUEOS_SERVIDOR[codigo]
    ?? MENSAJES_ERROR_REPRODUCCION[codigo]
    ?? 'El servidor no aceptó este evento.';
}

/**
 * Presentación del estado de un pendiente (texto, no solo color). Un HTTP 400, 403,
 * 404, 409 o 5xx nunca se presenta como falta de conexión: el servidor contestó.
 */
export function estadoEventoPendiente(pendiente) {
  const incierto = pendiente?.posibleEnServidor ? ' Pudo haber llegado al servidor: se confirmará al sincronizar.' : '';
  switch (pendiente?.estado) {
    case OUTBOX_ESTADOS.SINCRONIZANDO:
      return { etiqueta: 'Sincronizando', detalle: 'Enviando al servidor...', clase: 'pendiente' };
    case OUTBOX_ESTADOS.ERROR_REINTENTABLE:
      if (esErrorDeRed({ ultimoError: pendiente.ultimoError ?? { status: 0 } })) {
        return { etiqueta: 'Pendiente', detalle: `Se enviará automáticamente al recuperar la conexión.${incierto}`, clase: 'pendiente' };
      }
      return { etiqueta: 'Error temporal', detalle: `El servidor no pudo procesarlo; se reintentará automáticamente.${incierto}`, clase: 'pendiente' };
    case OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD:
      return { etiqueta: 'Sesión requerida', detalle: `${mensajeBloqueoReproduccion(pendiente.ultimoError?.codigo ?? 'IDENTIDAD_NO_COINCIDE')}${incierto}`, clase: 'bloqueado' };
    case OUTBOX_ESTADOS.CONFLICTO:
      return { etiqueta: 'Conflicto', detalle: `${mensajeBloqueoReproduccion(pendiente.ultimoError?.codigo)}${incierto}`, clase: 'bloqueado' };
    case OUTBOX_ESTADOS.RECHAZADO:
      return { etiqueta: 'Rechazado', detalle: `${mensajeBloqueoReproduccion(pendiente.ultimoError?.codigo)}${incierto}`, clase: 'bloqueado' };
    default:
      if (SESION_EXPIRADA.has(pendiente?.ultimoError?.codigo) || pendiente?.ultimoError?.status === 401) {
        return { etiqueta: 'Sesión requerida', detalle: `Inicia sesión para enviarlo.${incierto}`, clase: 'bloqueado' };
      }
      return { etiqueta: 'Pendiente', detalle: `Se enviará automáticamente al recuperar la conexión.${incierto}`, clase: 'pendiente' };
  }
}

/** Título de una operación administrativa en la lista de pendientes; null si es un registro. */
export function tituloOperacionPendiente(pendiente) {
  if (pendiente?.tipoOperacion === REPRODUCCION_EVENTO_ANULAR) return 'Anulación de evento';
  if (pendiente?.tipoOperacion === REPRODUCCION_EVENTO_CORREGIR) return 'Corrección de evento';
  return null;
}

/** La operación administrativa pendiente de un evento confirmado, si la hay (solo puede haber una). */
export function operacionAdministrativaDe(pendientes, eventoId) {
  return pendientes.find((p) => esOperacionAdministrativa(p.tipoOperacion) && p.eventoObjetivoId === eventoId) ?? null;
}

/**
 * Identidad esperada de la sesión real: la compara el servidor. Sin cuenta u
 * organización se omite (no hay nada que afirmar) y decide la cookie.
 */
export function identidadEsperadaDe(auth) {
  const cuentaId = auth?.cuenta?.cuentaId;
  const organizacionId = auth?.organizacionActiva?.organizacionId;
  return cuentaId && organizacionId ? { cuentaId, organizacionId } : null;
}

/**
 * Intento online de anular o corregir sin resultado definitivo: qué debe persistirse
 * con el MISMO clientOperationId. null si el servidor ya decidió (400, 403, 404, 409)
 * o la sesión venció (reintentar a mano tras volver a entrar es seguro: el id se conserva).
 */
export function persistenciaTrasFallo(result) {
  if (result?.failure === 'REQUEST_NOT_SENT' || result?.data?.error === 'CSRF_UNAVAILABLE') return { posibleEnServidor: false, fallo: null };
  if (result?.failure === 'SESSION_EXPIRED' || result?.failure === 'CSRF_REJECTED' || result?.status === 401) return null;
  const status = result?.status ?? 0;
  const codigo = result?.data?.error ?? result?.failure ?? 'ERROR';
  if (!result || status === 0) return { posibleEnServidor: true, fallo: { codigo, status: 0, tipo: 'red' } };
  if (status === 408 || status === 429 || status >= 500) return { posibleEnServidor: true, fallo: { codigo, status, tipo: 'http' } };
  return null;
}

/**
 * Qué puede hacer esta cuenta con un pendiente. Otra cuenta no puede hacer nada: la
 * operación espera a la que la creó. Con posibleEnServidor no se puede cambiar la
 * intención (un id nuevo duplicaría el evento); solo un conflicto o rechazo se
 * descarta, confirmando que pudo haberse registrado. Una anulación no se edita; una
 * corrección solo con permiso de administración y si el servidor no decidió ya.
 */
export function accionesEventoPendiente(pendiente, { cuentaId, puedeRegistrar, puedeAdministrar = false }) {
  const ninguna = { editar: false, cancelar: false, reintentar: false, confirmarIncierto: false };
  if (!cuentaId || pendiente?.cuentaOrigenId !== cuentaId || pendiente.estado === OUTBOX_ESTADOS.SINCRONIZANDO) return ninguna;
  const incierto = Boolean(pendiente.posibleEnServidor);
  const bloqueada = pendiente.estado === OUTBOX_ESTADOS.CONFLICTO || pendiente.estado === OUTBOX_ESTADOS.RECHAZADO;
  const administrativa = esOperacionAdministrativa(pendiente.tipoOperacion);
  const editable = administrativa
    ? pendiente.tipoOperacion === REPRODUCCION_EVENTO_CORREGIR && Boolean(puedeAdministrar) && pendiente.estado !== OUTBOX_ESTADOS.CONFLICTO
    : true;
  return {
    editar: !incierto && editable,
    cancelar: !incierto || bloqueada,
    // Un 408/429/5xx se reintenta solo al vencer su backoff: sin botón para adelantarlo.
    reintentar: Boolean(administrativa ? puedeAdministrar : puedeRegistrar)
      && (bloqueada || (pendiente.estado === OUTBOX_ESTADOS.ERROR_REINTENTABLE && (!pendiente.ultimoError || esErrorDeRed(pendiente))))
      && !CODIGOS_SIN_REINTENTO.includes(pendiente.ultimoError?.codigo),
    confirmarIncierto: incierto && bloqueada,
  };
}

/**
 * Registrar, anular o corregir online con operaciones pendientes del animal adelantaría
 * a la cadena FIFO y dejaría esos pendientes con fecha anterior al historial: se encola.
 */
export function destinoRegistro({ online, pendientes = [] }) {
  return online && pendientes.length === 0 ? 'servidor' : 'local';
}

/** Un pendiente con la forma que esperan el formulario y el detalle del historial. */
export function eventoDesdePendiente(pendiente) {
  return { ...pendiente, detalle: pendiente };
}

/** Pestaña desde la copia local: solo eventos confirmados, plegados con la fuente común. */
export function estadoCargaLocal({ sexo, eventos, hoy }) {
  return {
    status: 'ok',
    origen: 'local',
    sexo,
    estado: derivarEstadoReproductivo({ sexo, eventos, hoy }),
    eventos: ordenarHistorial(eventos),
    mensaje: null,
  };
}

/** null si el dispositivo aún no descargó el historial reproductivo completo. */
export async function leerCopiaLocal(repo, { animalId, sexo, hoy }) {
  if (!repo || !(await repo.getMeta()).reproduccionListaAt) return null;
  return estadoCargaLocal({ sexo, eventos: await repo.listEventosReproductivos(animalId), hoy });
}

/** Machos de la copia local, con la misma forma que el listado del servidor. */
export async function torosLocales(repo, identidad) {
  const animales = await repo.listAnimales({ estado: 'TODOS', estadoOperativo: 'TODOS' });
  return torosDesdeListado({ ok: true, data: { animales } }, identidad);
}
