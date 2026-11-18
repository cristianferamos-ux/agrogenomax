// FASE 5A.2 -- modelo PURO (sin React ni red) de la anulación de pesajes y
// de la presentación del historial ACTIVO / ANULADO.
//
// Contrato del backend (FASE 5A.1b):
//   POST /api/ganaderia/animales/:animalId/pesajes/:pesajeId/anular
//   body { motivo, clientOperationId, identidadEsperada? }
//   200 { ok, yaExistia, pesaje, resumen } | 400 INVALID_MOTIVO | 403 ROLE_FORBIDDEN |
//   404 PESAJE_NOT_FOUND / ANIMAL_NOT_FOUND | 409 PESAJE_YA_ANULADO /
//   CLIENT_OPERATION_ID_REUSED / IDENTIDAD_NO_COINCIDE / ANIMAL_ANULADO.
//
// Reglas:
//   * La acción "Anular" es SOLO UX: se muestra a owner/admin
//     (capacidad anularPesaje) sobre pesajes ACTIVOS; la autoridad es el
//     backend (403 ROLE_FORBIDDEN).
//   * Solo online (5A.2). Sin conexión NO se encola nada: el soporte offline
//     llega en 5A.3.
//   * El motivo se valida con la MISMA regla que el backend
//     (pesajeValidation.validateAnularPesajeBody): CRLF -> LF, trim, 1..500.
//   * Una intención = un clientOperationId. Se conserva tras un resultado
//     incierto (sin red / 5xx: reintentar no duplica) y se renueva tras éxito
//     o CLIENT_OPERATION_ID_REUSED.
//   * Nunca se muestran el actor, ni clientOperationId, ni ids internos.
import { fechaHoyNegocio } from '../engine/fechaNegocio.js';
import { conCodigoSeguimiento } from '../api/errorModel.js';
import { MENSAJE_ROLE_FORBIDDEN } from '../auth/ganaderiaPermisos.js';
import { formatDiferenciaKg, formatFecha, formatKg } from './pesajesModel.js';

export const MAX_MOTIVO_ANULACION_PESAJE = 500;

export const ADVERTENCIA_ANULACION_PESAJE =
  'El pesaje no se eliminará. Quedará registrado como anulado y dejará de participar en los cálculos productivos.';
export const MENSAJE_ANULACION_REQUIERE_CONEXION =
  'La anulación de pesajes requiere conexión. El soporte sin conexión llegará en una actualización posterior.';
export const TEXTO_MEDICION_NO_USADA = 'No usada para GMD: existe una medición posterior el mismo día.';

/** ¿Se ofrece "Anular" para este pesaje? Solo UX: decide el backend. */
export function accionAnularPesaje({ puedeAnular, pesaje, admitePesajes = true, online = true } = {}) {
  const activo = pesaje?.estadoRegistro !== 'ANULADO';
  const visible = Boolean(puedeAnular && activo && admitePesajes && pesaje?.pesajeId);
  return { visible, habilitado: visible && Boolean(online), motivoBloqueo: visible && !online ? MENSAJE_ANULACION_REQUIERE_CONEXION : null };
}

/** Misma normalización que el backend. { valido, motivo, error }. */
export function validarMotivoAnulacion(raw) {
  if (typeof raw !== 'string') return { valido: false, motivo: '', error: 'Escribe el motivo de la anulación.' };
  const motivo = raw.replace(/\r\n?/g, '\n').trim();
  if (motivo === '') return { valido: false, motivo, error: 'Escribe el motivo de la anulación.' };
  if (motivo.length > MAX_MOTIVO_ANULACION_PESAJE) {
    return { valido: false, motivo, error: `El motivo admite máximo ${MAX_MOTIVO_ANULACION_PESAJE} caracteres.` };
  }
  return { valido: true, motivo, error: null };
}

/** Cuerpo exacto del POST. identidadEsperada solo si hay sesión real (la compara el servidor). */
export function buildAnularPesajeBody({ motivo, clientOperationId, identidadEsperada = null }) {
  return {
    motivo,
    clientOperationId,
    ...(identidadEsperada ? { identidadEsperada } : {}),
  };
}

const MENSAJES_ANULACION = Object.freeze({
  PESAJE_YA_ANULADO: 'Este pesaje ya estaba anulado. Actualizamos el historial.',
  CLIENT_OPERATION_ID_REUSED: 'Esta solicitud ya se había usado con otros datos. Revisa el historial e inténtalo de nuevo si el pesaje sigue activo.',
  IDENTIDAD_NO_COINCIDE: 'Tu sesión cambió (otra cuenta u organización). Recarga la página e inténtalo de nuevo.',
  INVALID_MOTIVO: `Escribe el motivo de la anulación (máximo ${MAX_MOTIVO_ANULACION_PESAJE} caracteres).`,
  ROLE_FORBIDDEN: MENSAJE_ROLE_FORBIDDEN,
  PESAJE_NOT_FOUND: 'Este pesaje ya no está disponible. Actualizamos el historial.',
  ANIMAL_NOT_FOUND: 'Este animal no está disponible.',
  ANIMAL_ANULADO: 'Este animal está anulado: sus pesajes no admiten cambios.',
});

/**
 * Traduce el resultado de postJsonWithCsrf ({ ok, status, data, failure, correlationId })
 * a la acción de UI. tipo:
 *   ANULADO      -> éxito (nuevo o yaExistia): cerrar diálogo, recargar, nueva intención;
 *   INCIERTO     -> sin respuesta / 5xx: el servidor pudo anular; reintentar es seguro (mismo id);
 *   NO_ENVIADO   -> el POST no salió (CSRF): reintentar es seguro;
 *   CAMPO        -> motivo inválido (se muestra junto al campo);
 *   RECARGAR     -> el estado del servidor cambió (ya anulado / no existe): cerrar y recargar;
 *   NUEVA_INTENCION -> id reutilizado: renovar clientOperationId;
 *   PERMISOS | SESION | IDENTIDAD | ERROR.
 */
export function resultadoAnulacion(result) {
  const code = result?.data?.error;
  if (result?.ok && result.data?.pesaje?.estadoRegistro === 'ANULADO') {
    return {
      tipo: 'ANULADO',
      exito: true,
      mensaje: result.data.yaExistia ? 'El pesaje ya estaba anulado con esta misma solicitud.' : 'Pesaje anulado. Ya no participa en los cálculos productivos.',
    };
  }
  if (code === 'NETWORK_ERROR' || result?.status >= 500) {
    return { tipo: 'INCIERTO', mensaje: conCodigoSeguimiento('No pudimos confirmar si el pesaje se anuló. Puedes reintentar: no se duplicará.', result?.correlationId) };
  }
  if (code === 'CSRF_UNAVAILABLE') return { tipo: 'NO_ENVIADO', mensaje: 'No pudimos enviar la anulación. Revisa tu conexión e inténtalo de nuevo.' };
  if (code === 'ROLE_FORBIDDEN' || result?.failure === 'ROLE_FORBIDDEN') return { tipo: 'PERMISOS', mensaje: MENSAJES_ANULACION.ROLE_FORBIDDEN };
  if (code === 'IDENTIDAD_NO_COINCIDE') return { tipo: 'IDENTIDAD', mensaje: MENSAJES_ANULACION.IDENTIDAD_NO_COINCIDE };
  if (result?.status === 401 || result?.status === 403 || code === 'SESSION_EXPIRED') {
    return { tipo: 'SESION', mensaje: 'Tu sesión expiró o no es válida. Vuelve a iniciar sesión.' };
  }
  if (code === 'INVALID_MOTIVO') return { tipo: 'CAMPO', campo: 'motivo', mensaje: MENSAJES_ANULACION.INVALID_MOTIVO };
  if (code === 'PESAJE_YA_ANULADO' || code === 'PESAJE_NOT_FOUND') return { tipo: 'RECARGAR', mensaje: MENSAJES_ANULACION[code] };
  if (code === 'CLIENT_OPERATION_ID_REUSED') return { tipo: 'NUEVA_INTENCION', mensaje: MENSAJES_ANULACION.CLIENT_OPERATION_ID_REUSED };
  if (code === 'ANIMAL_ANULADO' || code === 'ANIMAL_NOT_FOUND') return { tipo: 'RECARGAR', mensaje: MENSAJES_ANULACION[code] };
  return { tipo: 'ERROR', mensaje: 'No fue posible anular el pesaje en este momento. Intenta nuevamente.' };
}

/**
 * Controlador de UNA intención de anulación (doble clic / reintentos):
 *   - mientras hay un POST en curso, cualquier otro envío se ignora (devuelve null);
 *   - el clientOperationId se conserva entre reintentos de la MISMA intención
 *     (mismo motivo) y se renueva si el motivo cambia (otra intención: nunca el
 *     mismo id con datos distintos), tras éxito, RECARGAR o NUEVA_INTENCION.
 * `enviar({ clientOperationId, motivo })` devuelve el resultado crudo; `nuevoId()` genera ids.
 */
export function crearControladorAnulacion({ enviar, nuevoId }) {
  let enCurso = false;
  let clientOperationId = null;
  let motivoIntencion = null;
  return {
    get enCurso() { return enCurso; },
    get clientOperationId() { return clientOperationId; },
    async anular(motivo) {
      if (enCurso) return null;
      enCurso = true;
      try {
        if (clientOperationId && motivo !== motivoIntencion) clientOperationId = null;
        if (!clientOperationId) {
          clientOperationId = nuevoId();
          motivoIntencion = motivo;
        }
        if (!clientOperationId) return { tipo: 'ERROR', mensaje: 'Este navegador no permite anular el pesaje de forma segura. Actualízalo e inténtalo de nuevo.' };
        let resultado;
        try {
          resultado = resultadoAnulacion(await enviar({ clientOperationId, motivo }));
        } catch {
          resultado = resultadoAnulacion({ data: { error: 'NETWORK_ERROR' } });
        }
        if (resultado.exito || resultado.tipo === 'NUEVA_INTENCION' || resultado.tipo === 'RECARGAR') clientOperationId = null;
        return resultado;
      } finally {
        enCurso = false;
      }
    },
  };
}

/** Fecha calendario de negocio (America/Bogota) de un instante ISO, formateada. */
function fechaNegocioDe(iso) {
  if (typeof iso !== 'string') return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return formatFecha(fechaHoyNegocio({ ahora: d }));
}

/**
 * Presentación de una fila del historial (ACTIVO / ANULADO / medición previa
 * del mismo día). Nunca incluye actor ni identificadores internos.
 */
export function presentarFilaHistorial(p) {
  const anulado = p?.estadoRegistro === 'ANULADO';
  const fechaAnulacion = anulado ? fechaNegocioDe(p.anulacion?.anuladoEn) : null;
  return {
    estado: anulado ? 'ANULADO' : 'ACTIVO',
    etiquetaEstado: anulado ? 'Anulado' : 'Activo',
    // Sin derivaciones: anulado o medición previa del mismo día (representativoDelDia === false).
    sinDerivaciones: anulado || p?.representativoDelDia === false,
    notaCalculo: anulado
      ? `Anulado el ${fechaAnulacion ?? 'fecha no disponible'}. Motivo: ${p.anulacion?.motivo ?? 'no indicado'}. No participa en los cálculos.`
      : p?.representativoDelDia === false ? TEXTO_MEDICION_NO_USADA : null,
    notaMismoDia: !anulado && p?.mismoDia?.mediciones >= 2
      ? `Último de ${p.mismoDia.mediciones} pesajes activos del día (de ${formatKg(p.mismoDia.primerPesoKg)} a ${formatKg(p.mismoDia.ultimoPesoKg)}, ${formatDiferenciaKg(p.mismoDia.diferenciaKg)}).`
      : null,
  };
}

/** Historial a mostrar: `historial` (ACTIVOS + ANULADOS) o, si la API no lo trae, `pesajes`. */
export function filasHistorial(data) {
  if (Array.isArray(data?.historial)) return data.historial;
  return Array.isArray(data?.pesajes) ? data.pesajes : [];
}
