// FASE 1B -- modelo PURO de la UI de pesajes de la ficha del animal
// (sin React ni red). Consume la respuesta de la API Business de Fase 1A
// (GET/POST /api/ganaderia/animales/:id/pesajes): la API ya entrega las
// derivaciones (diferencia, días, GMD, resumen, ganancia acumulada) con el
// motor canónico; aquí solo se valida el formulario, se presenta y se
// preparan los puntos de las gráficas. Nunca se redondean los datos fuente:
// el redondeo ocurre solo al formatear.
//
// Reglas de presentación: el primer pesaje de la serie es "Primer peso
// registrado" -- NUNCA "peso al nacimiento". Sin umbrales de GMD
// (Excelente/Aceptable/Crítico): no existe todavía una configuración oficial.
import { numeroDeDia } from '../engine/fechas.js';
import { PESO_METODOS } from './hatoFormModel.js';

export const MAX_PESO_KG = 2000;
export const MAX_OBSERVACIONES_PESAJE = 500;
export const SIN_DATO = 'Sin dato';
const MS_DIA = 86400000;

export const METODO_LABELS = Object.freeze(Object.fromEntries(PESO_METODOS.map((m) => [m.value, m.label])));

export function initialPesajeForm(hoy) {
  return { fecha: hoy, pesoKg: '', metodo: 'BASCULA', observaciones: '' };
}

function parsePeso(raw) {
  const texto = String(raw ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(texto)) return null;
  return Number(texto);
}

/**
 * Validación del cliente (el backend sigue siendo la autoridad). Devuelve
 * { valido, errores: { campo: mensaje } }.
 */
export function validatePesajeForm(form, { hoy }) {
  const errores = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.fecha ?? '') || numeroDeDia(form.fecha) === null) {
    errores.fecha = 'Indica una fecha válida.';
  } else if (hoy && form.fecha > hoy) {
    errores.fecha = 'La fecha no puede ser futura.';
  } else if (form.fecha < '1990-01-01') {
    errores.fecha = 'La fecha no puede ser anterior a 1990.';
  }
  const peso = parsePeso(form.pesoKg);
  if (peso === null || !(peso > 0)) errores.pesoKg = 'Indica un peso mayor que 0 kg.';
  else if (peso > MAX_PESO_KG) errores.pesoKg = `El peso no puede superar ${MAX_PESO_KG} kg.`;
  else if (Math.round(peso * 10) / 10 !== peso) errores.pesoKg = 'Usa como máximo un decimal.';
  if (!PESO_METODOS.some((m) => m.value === form.metodo)) errores.metodo = 'Elige cómo se obtuvo el peso.';
  if (String(form.observaciones ?? '').trim().length > MAX_OBSERVACIONES_PESAJE) {
    errores.observaciones = `Las observaciones admiten máximo ${MAX_OBSERVACIONES_PESAJE} caracteres.`;
  }
  return { valido: Object.keys(errores).length === 0, errores };
}

export function buildPesajeBody(form, clientOperationId) {
  const observaciones = String(form.observaciones ?? '').trim();
  return {
    fecha: form.fecha,
    pesoKg: parsePeso(form.pesoKg),
    metodo: form.metodo,
    ...(observaciones ? { observaciones } : {}),
    clientOperationId,
  };
}

const CAMPO_POR_ERROR = Object.freeze({
  INVALID_FECHA: 'fecha',
  INVALID_PESO: 'pesoKg',
  INVALID_METODO: 'metodo',
  INVALID_OBSERVACIONES: 'observaciones',
});

/**
 * Traduce el resultado de postJsonWithCsrf ({ ok, status, data, failure })
 * a la acción de UI. tipo:
 *   CREADO | YA_EXISTIA      -> éxito: refrescar historial y nueva intención;
 *   CAMPO                    -> error de validación en un campo;
 *   ANULADO                  -> deshabilitar el formulario y refrescar;
 *   OPERACION_REUSADA        -> nueva intención (los datos no coinciden);
 *   INCIERTO                 -> sin respuesta o 5xx: reintentar es seguro (mismo id);
 *   NO_ENVIADO               -> el POST no salió: reintentar es seguro;
 *   SESION | NO_ENCONTRADO | ERROR.
 */
export function resultadoRegistro(result) {
  const code = result?.data?.error;
  if (result?.ok && result.data?.pesaje) {
    return result.data.yaExistia
      ? { tipo: 'YA_EXISTIA', mensaje: 'Este pesaje ya estaba registrado (no se duplicó).', exito: true }
      : { tipo: 'CREADO', mensaje: 'Pesaje registrado.', exito: true };
  }
  // Sin respuesta o 5xx (p. ej. 502/504 de un proxy intermedio): el servidor
  // pudo haber guardado. Es incierto, no un fallo definitivo.
  if (code === 'NETWORK_ERROR' || result?.status >= 500) {
    return { tipo: 'INCIERTO', mensaje: 'No pudimos confirmar si el pesaje se guardó. Puedes reintentar: no se duplicará.' };
  }
  if (code === 'CSRF_UNAVAILABLE') {
    return { tipo: 'NO_ENVIADO', mensaje: 'No pudimos enviar el pesaje. Revisa tu conexión e inténtalo de nuevo.' };
  }
  // FASE 2B: 403 ROLE_FORBIDDEN es falta de permisos, nunca sesión expirada.
  if (code === 'ROLE_FORBIDDEN' || result?.failure === 'ROLE_FORBIDDEN') {
    return { tipo: 'PERMISOS', mensaje: 'No tienes permisos para realizar esta acción.' };
  }
  if (result?.status === 401 || result?.status === 403 || code === 'SESSION_EXPIRED') {
    return { tipo: 'SESION', mensaje: 'Tu sesión expiró o no es válida. Vuelve a iniciar sesión para registrar pesajes.' };
  }
  if (result?.status === 400 && CAMPO_POR_ERROR[code]) {
    const campo = CAMPO_POR_ERROR[code];
    return { tipo: 'CAMPO', campo, mensaje: result.data?.message || 'Revisa este dato.' };
  }
  if (code === 'ANIMAL_ANULADO') {
    return { tipo: 'ANULADO', mensaje: 'Este animal está anulado y no admite nuevos pesajes.' };
  }
  // FASE 2B: el animal salió del hato o murió (otro dispositivo / pestaña).
  if (code === 'ANIMAL_YA_SALIDO') {
    return { tipo: 'CERRADO', estadoOperativo: 'SALIDO', mensaje: 'Este animal salió del hato y no admite nuevos pesajes.' };
  }
  if (code === 'ANIMAL_YA_MUERTO') {
    return { tipo: 'CERRADO', estadoOperativo: 'MUERTO', mensaje: 'Este animal está registrado como muerto y no admite nuevos pesajes.' };
  }
  if (code === 'CLIENT_OPERATION_ID_REUSED') {
    return {
      tipo: 'OPERACION_REUSADA',
      mensaje: 'Esta operación ya se había usado con otros datos. Revisa el historial y vuelve a guardar si el pesaje no aparece.',
    };
  }
  if (result?.status === 404) return { tipo: 'NO_ENCONTRADO', mensaje: 'Este animal no está disponible.' };
  return { tipo: 'ERROR', mensaje: 'No fue posible registrar el pesaje en este momento. Intenta nuevamente.' };
}

// ---------------------------------------------------------------------------
// Presentación
// ---------------------------------------------------------------------------

function numero(value, { maxDecimales, minDecimales = 0 } = {}) {
  return Number(value).toLocaleString('es-CO', { minimumFractionDigits: minDecimales, maximumFractionDigits: maxDecimales });
}

export function formatKg(value) {
  return Number.isFinite(value) ? `${numero(value, { maxDecimales: 1 })} kg` : SIN_DATO;
}

/** Diferencia con signo explícito (+ / −) para no depender del color. */
export function formatDiferenciaKg(value) {
  if (!Number.isFinite(value)) return SIN_DATO;
  if (value === 0) return '0 kg';
  return `${value > 0 ? '+' : '−'}${numero(Math.abs(value), { maxDecimales: 1 })} kg`;
}

export function formatGmd(value) {
  if (!Number.isFinite(value)) return SIN_DATO;
  if (value === 0) return '0 kg/día';
  return `${value > 0 ? '+' : '−'}${numero(Math.abs(value), { maxDecimales: 2 })} kg/día`;
}

export function formatDias(value) {
  if (!Number.isFinite(value)) return SIN_DATO;
  return value === 1 ? '1 día' : `${value} días`;
}

export function formatFecha(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return SIN_DATO;
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

export function formatMetodo(metodo) {
  return METODO_LABELS[metodo] ?? metodo ?? SIN_DATO;
}

/** Copia en orden más reciente primero (la fuente ascendente no se altera). */
export function historialParaVista(pesajes = []) {
  return [...pesajes].reverse();
}

/** Seis KPIs a partir del resumen de la API (sin recalcular). */
export function kpisDePesajes(resumen) {
  const r = resumen ?? {};
  const acumulada = r.gananciaAcumulada;
  return [
    { id: 'ultimo', label: 'Último peso', valor: formatKg(r.ultimoPesoKg), detalle: r.fechaUltimoPeso ? formatFecha(r.fechaUltimoPeso) : null },
    { id: 'anterior', label: 'Peso anterior', valor: formatKg(r.pesoAnteriorKg), detalle: null },
    { id: 'diferencia', label: 'Diferencia', valor: formatDiferenciaKg(r.diferenciaKg), detalle: null },
    { id: 'dias', label: 'Días desde el anterior', valor: formatDias(r.diasDesdeAnterior), detalle: null },
    { id: 'gmd', label: 'GMD (ganancia media diaria)', valor: formatGmd(r.gmdKgDia), detalle: null },
    {
      id: 'acumulada',
      label: 'Ganancia acumulada',
      valor: acumulada ? formatDiferenciaKg(acumulada.gananciaKg) : SIN_DATO,
      detalle: acumulada
        ? `Desde el primer peso registrado (${formatKg(acumulada.primerPesoRegistradoKg)}, ${formatFecha(acumulada.fechaPrimerPesoRegistrado)})`
        : null,
    },
  ];
}

// ---------------------------------------------------------------------------
// Gráficas (eje X TEMPORAL real: milisegundos de la fecha calendario en UTC)
// ---------------------------------------------------------------------------

export function fechaATiempo(iso) {
  const dia = numeroDeDia(iso);
  return dia === null ? null : dia * MS_DIA;
}

export function tiempoAFecha(t) {
  return new Date(t).toISOString().slice(0, 10);
}

/** Puntos peso vs fecha (orden ascendente). */
export function puntosPeso(pesajes = []) {
  return pesajes
    .map((p) => ({ t: fechaATiempo(p.fecha), fecha: p.fecha, pesoKg: p.pesoKg, metodo: p.metodo }))
    .filter((p) => p.t !== null && Number.isFinite(p.pesoKg));
}

/** Puntos GMD por período: solo valores no nulos, situados en la fecha final del período. */
export function puntosGmd(pesajes = []) {
  return pesajes
    .filter((p) => Number.isFinite(p.gmdKgDia))
    .map((p) => ({ t: fechaATiempo(p.fecha), fecha: p.fecha, gmdKgDia: p.gmdKgDia, diasDesdeAnterior: p.diasDesdeAnterior }))
    .filter((p) => p.t !== null);
}

/** Dominio temporal [min, max]; con un único día se abre ±3 días para no colapsar el eje. */
export function dominioTemporal(puntos) {
  if (!puntos.length) return null;
  const ts = puntos.map((p) => p.t);
  const min = Math.min(...ts);
  const max = Math.max(...ts);
  return min === max ? [min - 3 * MS_DIA, max + 3 * MS_DIA] : [min, max];
}
