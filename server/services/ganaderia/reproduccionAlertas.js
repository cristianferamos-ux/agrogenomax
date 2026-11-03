// FASE 4C -- alertas reproductivas DERIVADAS (no persistidas) y validación
// de la query del tablero reproductivo de la organización. Sin I/O.
//
// Las alertas se calculan en SQL (reproduccionTableroRepository.js) a partir
// de agx.reproduccion_eventos ACTIVO con la MISMA máquina de estados que
// reproduccionEstado.js (paridad exigida por la integración). Solo aplican a
// hembras con registro ACTIVO y situación EN_HATO: un animal cerrado o
// anulado no requiere seguimiento operativo.
//
//   DIAGNOSTICO_PENDIENTE  SERVIDA, sin diagnóstico activo posterior al último
//                          servicio y >= diasDiagnosticoPendiente desde él.
//   PARTO_PROXIMO          PRENADA con fecha probable de parto (derivada por el
//                          backend) a <= diasPartoProximo; incluye una fecha ya
//                          vencida mientras siga PRENADA.
//   DIAGNOSTICO_DUDOSO     el último diagnóstico activo es DUDOSA y no hay
//                          servicio, parto ni aborto posterior.
//   SIN_SEGUIMIENTO_REPRODUCTIVO  sin eventos activos y edad >= la mínima (o
//                          edad desconocida: no se fabrica).
import { ESTADOS_REPRODUCTIVOS } from './reproduccionEstado.js';
import { normalizeId } from './animalValidation.js';

/**
 * UMBRALES PROVISIONALES CONFIGURABLES (reglas operativas iniciales,
 * aprobadas para la Fase 4C). No son una recomendación veterinaria ni una
 * regla productiva oficial; no hay configuración por organización todavía.
 *   diasDiagnosticoPendiente  35 -- la ecografía suele confirmar la preñez
 *                             desde ~30 días post servicio.
 *   diasPartoProximo          30 -- ventana de preparación del preparto.
 *   edadMinimaSinSeguimientoMeses 12 -- excluye terneras de la alerta de
 *                             hembras sin historial reproductivo.
 */
export const CONFIGURACION_ALERTAS_REPRODUCCION = Object.freeze({
  diasDiagnosticoPendiente: 35,
  diasPartoProximo: 30,
  edadMinimaSinSeguimientoMeses: 12,
});

// Niveles simples (sin semáforos clínicos).
export const NIVELES_ALERTA = Object.freeze({ ATENCION: 'ATENCION', PROXIMA_ACCION: 'PROXIMA_ACCION', INFORMATIVA: 'INFORMATIVA' });

export const ALERTAS_REPRODUCCION = Object.freeze({
  PARTO_PROXIMO: NIVELES_ALERTA.ATENCION,
  DIAGNOSTICO_DUDOSO: NIVELES_ALERTA.ATENCION,
  DIAGNOSTICO_PENDIENTE: NIVELES_ALERTA.PROXIMA_ACCION,
  SIN_SEGUIMIENTO_REPRODUCTIVO: NIVELES_ALERTA.INFORMATIVA,
});
export const CODIGOS_ALERTA_REPRODUCCION = Object.freeze(Object.keys(ALERTAS_REPRODUCCION));

// Estados que aparecen en el tablero (solo hembras: NO_APLICA nunca).
export const ESTADOS_TABLERO = Object.freeze(Object.values(ESTADOS_REPRODUCTIVOS).filter((e) => e !== 'NO_APLICA'));
export const SITUACIONES_TABLERO = Object.freeze(['EN_HATO', 'SALIDO', 'MUERTO', 'TODOS']);
export const REGISTROS_TABLERO = Object.freeze(['ACTIVO', 'ANULADO', 'TODOS']);

export const TABLERO_DEFAULT_LIMIT = 50;
export const TABLERO_MAX_LIMIT = 200;
export const TABLERO_MAX_OFFSET = 100000;
const MAX_QUERY_LENGTH = 80;

export function badRequest(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_QUERY' });
}

export function rejectUnknown(query, allowed) {
  const unknown = Object.keys(query || {}).filter((key) => !allowed.has(key));
  if (unknown.length) throw badRequest(`Parámetros no permitidos: ${unknown.join(', ')}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (typeof value !== 'string') throw badRequest(`Parámetro ${key} inválido.`);
  }
}

function enumParam(raw, allowed, fallback, field) {
  if (raw === undefined || raw === '') return fallback;
  if (!allowed.includes(raw)) throw badRequest(`${field} debe ser uno de: ${allowed.join(', ')}.`);
  return raw;
}

function intParam(raw, { min, max, fallback }) {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,6}$/.test(raw)) throw badRequest('Parámetro de paginación inválido.');
  const n = Number(raw);
  if (n < min || n > max) throw badRequest('Parámetro de paginación fuera de rango.');
  return n;
}

export function predioParam(raw) {
  return raw === undefined || raw === '' ? null : normalizeId(raw, { code: 'INVALID_QUERY', field: 'predioId' });
}

const RESUMEN_KEYS = new Set(['predioId']);
const LISTADO_KEYS = new Set(['predioId', 'estadoReproductivo', 'alerta', 'q', 'situacion', 'registro', 'limit', 'offset']);

/** GET /api/ganaderia/reproduccion/resumen -- siempre hato actual (ACTIVO + EN_HATO). */
export function validateResumenTableroQuery(query) {
  rejectUnknown(query, RESUMEN_KEYS);
  return { predioId: predioParam(query?.predioId) };
}

/** GET /api/ganaderia/reproduccion/animales -- por defecto ACTIVO + EN_HATO. */
export function validateListadoTableroQuery(query) {
  rejectUnknown(query, LISTADO_KEYS);
  const q = query?.q === undefined ? null : query.q.replace(/\s+/g, ' ').trim() || null;
  if (q !== null && q.length > MAX_QUERY_LENGTH) throw badRequest(`q admite máximo ${MAX_QUERY_LENGTH} caracteres.`);
  return {
    predioId: predioParam(query?.predioId),
    estadoReproductivo: enumParam(query?.estadoReproductivo, ESTADOS_TABLERO, null, 'estadoReproductivo'),
    alerta: enumParam(query?.alerta, CODIGOS_ALERTA_REPRODUCCION, null, 'alerta'),
    q,
    situacion: enumParam(query?.situacion, SITUACIONES_TABLERO, 'EN_HATO', 'situacion'),
    registro: enumParam(query?.registro, REGISTROS_TABLERO, 'ACTIVO', 'registro'),
    limit: intParam(query?.limit, { min: 1, max: TABLERO_MAX_LIMIT, fallback: TABLERO_DEFAULT_LIMIT }),
    offset: intParam(query?.offset, { min: 0, max: TABLERO_MAX_OFFSET, fallback: 0 }),
  };
}
