// FASE 4E.1 -- modelo PURO de la UI de eventos reproductivos sin conexión (sin
// React ni red). Un evento pendiente vive en el outbox, se presenta SEPARADO del
// historial confirmado y no entra en el estado reproductivo, alertas, analítica ni
// PDF hasta que el servidor lo confirma. Estos permisos son solo UX: el repositorio
// y el servidor vuelven a comprobar cuenta, estado y rol.
import { derivarEstadoReproductivo } from '../engine/reproduccion.js';
import { CODIGOS_SIN_REINTENTO, OUTBOX_ESTADOS } from '../offline/outbox.js';
import { MENSAJES_ERROR_REPRODUCCION, ordenarHistorial, torosDesdeListado } from './reproduccionModel.js';

export const MENSAJE_EVENTO_PENDIENTE = 'Evento guardado en este dispositivo. Está pendiente de sincronización y aún no cuenta para el estado reproductivo.';
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
  ROLE_FORBIDDEN: 'Tu rol actual no permite registrar eventos reproductivos.',
});

/** Motivo de un evento que no se sincronizó (nunca el `message` del servidor). */
export function mensajeBloqueoReproduccion(codigo) {
  return BLOQUEOS_IDENTIDAD[codigo]
    ?? BLOQUEOS_SERVIDOR[codigo]
    ?? MENSAJES_ERROR_REPRODUCCION[codigo]
    ?? 'El servidor no aceptó este evento.';
}

/** Presentación del estado de un evento pendiente (texto, no solo color). */
export function estadoEventoPendiente(pendiente) {
  const incierto = pendiente?.posibleEnServidor ? ' Pudo haber llegado al servidor: se confirmará al sincronizar.' : '';
  switch (pendiente?.estado) {
    case OUTBOX_ESTADOS.SINCRONIZANDO:
      return { etiqueta: 'Sincronizando', detalle: 'Enviando al servidor...', clase: 'pendiente' };
    case OUTBOX_ESTADOS.ERROR_REINTENTABLE:
      return { etiqueta: 'Pendiente', detalle: `Aún no se pudo enviar; se reintentará automáticamente.${incierto}`, clase: 'pendiente' };
    case OUTBOX_ESTADOS.BLOQUEADA_POR_IDENTIDAD:
      return { etiqueta: 'Esperando su cuenta', detalle: `${mensajeBloqueoReproduccion(pendiente.ultimoError?.codigo ?? 'IDENTIDAD_NO_COINCIDE')}${incierto}`, clase: 'bloqueado' };
    case OUTBOX_ESTADOS.CONFLICTO:
    case OUTBOX_ESTADOS.RECHAZADO:
      return { etiqueta: 'No sincronizado', detalle: `${mensajeBloqueoReproduccion(pendiente.ultimoError?.codigo)}${incierto}`, clase: 'bloqueado' };
    default:
      return { etiqueta: 'Pendiente', detalle: `Se enviará automáticamente al recuperar la conexión.${incierto}`, clase: 'pendiente' };
  }
}

/**
 * Qué puede hacer esta cuenta con un evento pendiente. Otra cuenta no puede hacer
 * nada: la operación espera a la que la creó. Con posibleEnServidor no se puede
 * cambiar la intención (un id nuevo duplicaría el evento); solo un conflicto o
 * rechazo se descarta, confirmando que pudo haberse registrado.
 */
export function accionesEventoPendiente(pendiente, { cuentaId, puedeRegistrar }) {
  const ninguna = { editar: false, cancelar: false, reintentar: false, confirmarIncierto: false };
  if (!cuentaId || pendiente?.cuentaOrigenId !== cuentaId || pendiente.estado === OUTBOX_ESTADOS.SINCRONIZANDO) return ninguna;
  const incierto = Boolean(pendiente.posibleEnServidor);
  const bloqueada = pendiente.estado === OUTBOX_ESTADOS.CONFLICTO || pendiente.estado === OUTBOX_ESTADOS.RECHAZADO;
  return {
    editar: !incierto,
    cancelar: !incierto || bloqueada,
    reintentar: Boolean(puedeRegistrar)
      && (bloqueada || pendiente.estado === OUTBOX_ESTADOS.ERROR_REINTENTABLE)
      && !CODIGOS_SIN_REINTENTO.includes(pendiente.ultimoError?.codigo),
    confirmarIncierto: incierto && bloqueada,
  };
}

/**
 * Registrar online con eventos pendientes del animal adelantaría a la cadena FIFO
 * y dejaría esos pendientes con fecha anterior al historial: también se encola.
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
