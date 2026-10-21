// FASE 1C.2: modelo PURO del botón "Descargar reporte productivo" (sin React
// ni red). El PDF lo genera el servidor; aquí solo se traduce el resultado de
// la descarga a un mensaje para el productor.
export const TEXTO_BOTON_REPORTE = 'Descargar reporte productivo';
export const TEXTO_BOTON_REPORTE_CARGANDO = 'Generando reporte...';
export const AVISO_REPORTE_SIN_CONEXION = 'Descargar el reporte requiere conexión.';

/** Mensaje amigable para un resultado fallido (o null si la red falló). */
export function mensajeErrorReporte(result) {
  if (!result) return 'No pudimos descargar el reporte. Revisa tu conexión e inténtalo de nuevo.';
  if (result.status === 401 || result.status === 403) {
    return 'Tu sesión expiró o no es válida. Vuelve a iniciar sesión para descargar el reporte.';
  }
  if (result.status === 404) return 'Este animal no está disponible.';
  return 'No fue posible generar el reporte en este momento. Intenta nuevamente.';
}
