// FASE 1D.2 -- modelo PURO de la pestaña "Actividad" (sin React ni red).
// Presenta los eventos YA normalizados por el servidor (GET
// /api/ganaderia/animales/:id/timeline): nunca recalcula pesajes ni GMD
// (vienen del motor canónico) y nunca muestra datos técnicos.
import { formatDias, formatDiferenciaKg, formatFecha, formatGmd } from './pesajesModel.js';

export const TEXTO_CARGANDO_ACTIVIDAD = 'Cargando actividad…';
export const TEXTO_SIN_ACTIVIDAD = 'No hay actividad registrada.';
export const TEXTO_ERROR_ACTIVIDAD = 'No fue posible cargar la actividad.';

// Etiqueta de categoría en TEXTO (no depender solo del color/icono).
const ETIQUETAS = Object.freeze({
  ANIMAL_REGISTRADO: 'Registro',
  ANIMAL_CORREGIDO: 'Corrección',
  ANIMAL_ANULADO: 'Anulación',
  PESAJE_REGISTRADO: 'Pesaje',
  QR_ASIGNADO: 'Chapeta QR',
  QR_DESASIGNADO: 'Chapeta QR',
  QR_REEMPLAZADO: 'Chapeta QR',
  // FASE 2B: el cierre del animal tiene etiqueta propia (nunca "Actividad").
  ANIMAL_SALIDO: 'Salida',
  ANIMAL_MUERTO: 'Muerte',
});

export function etiquetaTipoEvento(tipo) {
  return ETIQUETAS[tipo] ?? 'Actividad';
}

/** "dd/mm/yyyy" o "dd/mm/yyyy · HH:mm" (hora de Colombia, la calcula el servidor). */
export function fechaEvento(evento) {
  const fecha = formatFecha(evento?.fecha);
  return evento?.hora ? `${fecha} · ${evento.hora}` : fecha;
}

/** Detalles pertinentes (texto) según el tipo; [] si no aplica. */
export function detallesEvento(evento) {
  const d = evento?.datos ?? {};
  if (evento?.tipo === 'PESAJE_REGISTRADO') {
    const lineas = [];
    if (d.diasDesdeAnterior !== null && d.diasDesdeAnterior !== undefined) {
      lineas.push(`Diferencia: ${formatDiferenciaKg(d.diferenciaKg)}`);
      lineas.push(`Días desde el anterior: ${formatDias(d.diasDesdeAnterior)}`);
      lineas.push(`GMD: ${formatGmd(d.gmdKgDia)}`);
    } else {
      lineas.push('Primer peso registrado');
    }
    if (d.observaciones) lineas.push(`Observaciones: ${d.observaciones}`);
    return lineas;
  }
  return [];
}

/** Resultado de la carga -> estado de la pestaña. */
export function estadoActividad(result) {
  if (result?.ok && Array.isArray(result.data?.eventos)) {
    return {
      status: result.data.eventos.length ? 'ok' : 'vacio',
      eventos: result.data.eventos,
      total: result.data.total ?? result.data.eventos.length,
      truncado: Boolean(result.data.truncado),
    };
  }
  if (result?.status === 404) return { status: 'not_found', eventos: [], total: 0, truncado: false };
  return { status: 'error', eventos: [], total: 0, truncado: false };
}
