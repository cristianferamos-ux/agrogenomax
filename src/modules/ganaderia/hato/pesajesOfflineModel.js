// FASE 1D.1 -- modelo PURO de la UI de pesajes sin conexión (sin React ni
// red). Los pesajes PENDIENTES viven en el outbox (PESAJE_CREAR) y se
// presentan SEPARADOS del historial confirmado: nunca entran en KPIs, GMD,
// ganancia acumulada, gráficas, alertas ni PDF hasta que el servidor los
// confirma (los datos Business confirmados son la fuente de verdad).

export const MENSAJE_PESAJE_PENDIENTE = 'Pesaje pendiente de sincronización.';
export const MENSAJE_SIN_ALMACEN_LOCAL = 'Sin conexión, y este dispositivo no puede guardar pesajes para sincronizar. Regístralo cuando vuelva la conexión.';
export const ETIQUETA_PENDIENTE = 'Pendiente';
export const ETIQUETA_CONFIRMADO = 'Confirmado';

/** Texto del botón del formulario según conexión y estado de guardado. */
export function textoBotonPesaje({ online, saving = false, primerPesaje = false }) {
  if (!online) return saving ? 'Guardando...' : 'Guardar para sincronizar';
  if (saving) return 'Guardando pesaje...';
  return primerPesaje ? 'Registrar primer pesaje' : 'Registrar pesaje';
}

export function resumenPendientes(cantidad) {
  return cantidad === 1 ? '1 pesaje pendiente de sincronización' : `${cantidad} pesajes pendientes de sincronización`;
}

const BLOQUEOS = Object.freeze({
  ANIMAL_ANULADO: 'El animal fue anulado: el servidor no aceptó este pesaje.',
  ANIMAL_NOT_FOUND: 'El animal ya no está disponible.',
  CLIENT_OPERATION_ID_REUSED: 'Este registro ya existe en el servidor con otros datos.',
});

/** Motivo de un pesaje que el servidor no aceptó (sin detalles internos). */
export function mensajeBloqueoPesaje(codigo) {
  if (BLOQUEOS[codigo]) return BLOQUEOS[codigo];
  if (typeof codigo === 'string' && codigo.startsWith('INVALID_')) return 'El servidor rechazó los datos de este pesaje.';
  return 'El servidor no aceptó este pesaje.';
}

/**
 * Presentación del estado de un pesaje pendiente (texto, no solo color):
 *   { etiqueta, detalle, bloqueado }
 */
export function estadoPesajePendiente(pendiente) {
  switch (pendiente?.estado) {
    case 'SINCRONIZANDO':
      return { etiqueta: 'Sincronizando', detalle: 'Enviando al servidor...', bloqueado: false };
    case 'ERROR_REINTENTABLE':
      return { etiqueta: ETIQUETA_PENDIENTE, detalle: 'Aún no se pudo enviar; se reintentará automáticamente.', bloqueado: false };
    case 'CONFLICTO':
    case 'RECHAZADO':
      return { etiqueta: 'No sincronizado', detalle: mensajeBloqueoPesaje(pendiente.ultimoError?.codigo), bloqueado: true };
    default:
      return { etiqueta: ETIQUETA_PENDIENTE, detalle: 'Se enviará automáticamente al recuperar la conexión.', bloqueado: false };
  }
}

/** Mensaje para un fallo al GUARDAR en el dispositivo (no del servidor). */
export function mensajeErrorGuardadoLocal(error) {
  if (error?.code === 'PESAJE_REQUIERE_ANIMAL_SINCRONIZADO') return error.message;
  return 'No se pudo guardar el pesaje en este dispositivo. Intenta nuevamente.';
}

/** Identificadores de operación (para detectar confirmaciones y refrescar). */
export function idsPendientes(pendientes) {
  return new Set(pendientes.map((p) => p.localOperationId));
}

/** ¿Desapareció alguna operación conocida? (confirmada por el servidor o descartada) */
export function huboConfirmaciones(anteriores, actuales) {
  for (const id of anteriores) if (!actuales.has(id)) return true;
  return false;
}
