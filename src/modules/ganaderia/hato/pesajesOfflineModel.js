// FASE 1D.1 -- modelo PURO de la UI de pesajes sin conexión (sin React ni
// red). Los pesajes PENDIENTES viven en el outbox (PESAJE_CREAR) y se
// presentan SEPARADOS del historial confirmado: nunca entran en KPIs, GMD,
// ganancia acumulada, gráficas, alertas ni PDF hasta que el servidor los
// confirma (los datos Business confirmados son la fuente de verdad).
import { MENSAJE_OFFLINE_ROLE_FORBIDDEN } from '../auth/ganaderiaPermisos.js';

export const MENSAJE_PESAJE_PENDIENTE = 'Pesaje pendiente de sincronización.';
export const MENSAJE_SIN_ALMACEN_LOCAL = 'Sin conexión, y este dispositivo no puede guardar pesajes para sincronizar. Regístralo cuando vuelva la conexión.';
// FASE 5A.3c: terminología única de estados (ver pesajesOfflineVista.js).
export const ETIQUETA_PENDIENTE = 'Pendiente de sincronización';
export const ETIQUETA_PENDIENTE_CONFIRMAR = 'Pendiente de confirmar';
export const ETIQUETA_CONFIRMADO = 'Sincronizado';
export const ETIQUETA_CONFLICTO = 'Conflicto';
export const ETIQUETA_RECHAZADO = 'Rechazado';
export const ETIQUETA_IDENTIDAD = 'Bloqueado por cambio de cuenta';
export const MENSAJE_IDENTIDAD_OPERACION = 'Esta operación fue creada con otra cuenta u organización y no se enviará desde la sesión actual.';
export const MENSAJE_SESION_NO_VERIFICADA = 'No pudimos verificar tu sesión. Se enviará cuando vuelvas a iniciar sesión con la cuenta que la registró.';
export const MENSAJE_PENDIENTE_CONFIRMAR = 'Pendiente de confirmar con el servidor.';

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
  // FASE 2B: 409 del servidor -> CONFLICTO (syncEngine.classifyResult): se
  // conserva en el dispositivo y NO se reintenta en bucle.
  ANIMAL_YA_SALIDO: 'Este pesaje no se sincronizó porque el animal salió del hato.',
  ANIMAL_YA_MUERTO: 'Este pesaje no se sincronizó porque el animal está registrado como muerto.',
  CLIENT_OPERATION_ID_REUSED: 'Este registro ya existe en el servidor con otros datos.',
  // FASE 3A: 403 por rol -> RECHAZADO terminal (syncEngine), sin reintentos.
  ROLE_FORBIDDEN: MENSAJE_OFFLINE_ROLE_FORBIDDEN,
  // FASE 5A.3c: anulación y conciliación (motor 5A.3b).
  PESAJE_YA_ANULADO: 'El servidor ya tenía este pesaje anulado por otra solicitud: revisa el historial.',
  PESAJE_NOT_FOUND: 'El servidor no encontró este pesaje.',
  CONCILIACION_INTENCION_DISTINTA: 'El servidor tiene este registro con datos distintos. Revísalo antes de continuar.',
  INVALID_MOTIVO: 'El servidor rechazó el motivo de la anulación.',
  IDENTIDAD_NO_COINCIDE: MENSAJE_IDENTIDAD_OPERACION,
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
  // FASE 5A.3c: un envío que pudo llegar (o legacy, siempre incierto) se presenta
  // como "Pendiente de confirmar", nunca como algo que se puede retirar.
  const incierto = Boolean(pendiente?.legacy || pendiente?.posibleEnServidor);
  switch (pendiente?.estado) {
    case 'SINCRONIZANDO':
      return { etiqueta: 'Sincronizando', detalle: 'Enviando al servidor...', bloqueado: false };
    case 'ERROR_REINTENTABLE':
      return incierto
        ? { etiqueta: ETIQUETA_PENDIENTE_CONFIRMAR, detalle: `${MENSAJE_PENDIENTE_CONFIRMAR} Se reintentará automáticamente.`, bloqueado: false }
        : { etiqueta: ETIQUETA_PENDIENTE, detalle: 'Aún no se pudo enviar; se reintentará automáticamente.', bloqueado: false };
    case 'CONFLICTO':
      return { etiqueta: ETIQUETA_CONFLICTO, detalle: mensajeBloqueoPesaje(pendiente.ultimoError?.codigo), bloqueado: true };
    case 'RECHAZADO':
      return { etiqueta: ETIQUETA_RECHAZADO, detalle: mensajeBloqueoPesaje(pendiente.ultimoError?.codigo), bloqueado: true };
    case 'BLOQUEADA_POR_IDENTIDAD':
      return {
        etiqueta: ETIQUETA_IDENTIDAD,
        detalle: pendiente.ultimoError?.codigo === 'SESION_NO_VERIFICABLE' ? MENSAJE_SESION_NO_VERIFICADA : MENSAJE_IDENTIDAD_OPERACION,
        bloqueado: true,
      };
    default:
      return incierto
        ? { etiqueta: ETIQUETA_PENDIENTE_CONFIRMAR, detalle: MENSAJE_PENDIENTE_CONFIRMAR, bloqueado: false }
        : { etiqueta: ETIQUETA_PENDIENTE, detalle: 'Se enviará automáticamente al recuperar la conexión.', bloqueado: false };
  }
}

/** Mensaje para un fallo al GUARDAR en el dispositivo (no del servidor). */
export function mensajeErrorGuardadoLocal(error) {
  if (error?.code === 'PESAJE_REQUIERE_ANIMAL_SINCRONIZADO') return error.message;
  return 'No se pudo guardar el pesaje en este dispositivo. Intenta nuevamente.';
}

/** Estados en los que un pesaje sigue realmente "pendiente de sincronización". */
export const ESTADOS_PESAJE_EN_CURSO = Object.freeze(['PENDIENTE', 'SINCRONIZANDO', 'ERROR_REINTENTABLE']);

export function hayPesajesEnCurso(pendientes) {
  return pendientes.some((p) => ESTADOS_PESAJE_EN_CURSO.includes(p.estado));
}

/**
 * Mensaje tras releer el outbox: el informativo "Pesaje pendiente de
 * sincronización." se retira cuando deja de ser cierto (ningún pesaje de
 * este animal sigue en curso: confirmados, descartados o bloqueados). NO se
 * sustituye por "sincronizado": una operación también desaparece al
 * descartarla. Cualquier otro mensaje (error, validación, éxito online) se
 * conserva. Un pesaje en CONFLICTO/RECHAZADO sigue visible en la sección de
 * pendientes con su motivo.
 */
export function mensajeTrasLeerPendientes(mensaje, pendientes) {
  const esAvisoPendiente = mensaje?.type === 'info' && mensaje.text === MENSAJE_PESAJE_PENDIENTE;
  return esAvisoPendiente && !hayPesajesEnCurso(pendientes) ? null : mensaje;
}

/** Identificadores de operación (para detectar confirmaciones y refrescar). */
export function idsPendientes(pendientes) {
  return new Set(pendientes.map((p) => p.localOperationId));
}

/**
 * FASE 5B: operaciones de pesaje del outbox de un animal (CREATE y ANULAR)
 * de una lectura de leerPesajesLocales. La Actividad solo las usa para saber
 * cuándo releer el servidor: nunca las muestra como hechos.
 */
export function idsOperacionesPesaje(lectura) {
  return idsPendientes([...(lectura?.pendientes ?? []), ...(lectura?.anulaciones ?? [])]);
}

/** ¿Desapareció alguna operación conocida? (confirmada por el servidor o descartada) */
export function huboConfirmaciones(anteriores, actuales) {
  for (const id of anteriores) if (!actuales.has(id)) return true;
  return false;
}
