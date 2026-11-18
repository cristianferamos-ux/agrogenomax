// FASE 1A -- validación del registro de pesajes posteriores (MANUAL).
// POST /api/ganaderia/animales/:animalId/pesajes. Sin I/O. organizacionId
// NUNCA se acepta del cliente (FORBIDDEN_FIELDS); el tenant sale de la sesión.
import { MAX_PESO_KG, PESO_METODOS, normalizeClientOperationId, normalizeFecha } from './animalValidation.js';

export const MAX_OBSERVACIONES_PESAJE = 500;
// FASE 5A.1b: mismo límite que 0028 (CHECK motivo_anulacion 1..500).
export const MAX_MOTIVO_ANULACION_PESAJE = 500;
const ANULAR_ALLOWED_KEYS = new Set(['motivo', 'clientOperationId']);
const ALLOWED_KEYS = new Set(['fecha', 'pesoKg', 'metodo', 'observaciones', 'clientOperationId']);

function badRequest(code, message) {
  return Object.assign(new Error(message), { status: 400, code });
}

function normalizePesoKg(rawValue) {
  if (typeof rawValue !== 'number' || !Number.isFinite(rawValue) || rawValue <= 0 || rawValue > MAX_PESO_KG) {
    throw badRequest('INVALID_PESO', `pesoKg debe ser un número mayor que 0 y hasta ${MAX_PESO_KG}.`);
  }
  if (Math.round(rawValue * 10) / 10 !== rawValue) {
    throw badRequest('INVALID_PESO', 'pesoKg admite como máximo un decimal.');
  }
  return rawValue;
}

function normalizeMetodo(rawValue) {
  if (typeof rawValue !== 'string' || !PESO_METODOS.includes(rawValue)) {
    throw badRequest('INVALID_METODO', `metodo debe ser ${PESO_METODOS.join(' o ')}.`);
  }
  return rawValue;
}

function normalizeObservacionesPesaje(rawValue) {
  if (rawValue === undefined || rawValue === null) return null;
  if (typeof rawValue !== 'string') throw badRequest('INVALID_OBSERVACIONES', 'observaciones debe ser texto.');
  const normalized = rawValue.replace(/\r\n?/g, '\n').trim();
  if (normalized === '') return null;
  if (normalized.length > MAX_OBSERVACIONES_PESAJE) {
    throw badRequest('INVALID_OBSERVACIONES', `observaciones admite máximo ${MAX_OBSERVACIONES_PESAJE} caracteres.`);
  }
  return normalized;
}

/**
 * Body del POST. `hoy` = fecha de NEGOCIO (America/Bogota): la fecha del
 * pesaje no puede ser futura; se admite histórico desde 1990-01-01.
 */
export function validateCreatePesajeBody(body, { hoy }) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('INVALID_BODY', 'El cuerpo de la solicitud debe ser un objeto JSON.');
  }
  const unknownKeys = Object.keys(body).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) throw badRequest('FORBIDDEN_FIELDS', `Campos no permitidos: ${unknownKeys.join(', ')}`);

  const fecha = normalizeFecha(body.fecha, { code: 'INVALID_FECHA', field: 'fecha', hoy });
  if (!fecha) throw badRequest('INVALID_FECHA', 'fecha es obligatoria.');
  return {
    clientOperationId: normalizeClientOperationId(body.clientOperationId),
    fecha,
    pesoKg: normalizePesoKg(body.pesoKg),
    metodo: normalizeMetodo(body.metodo),
    observaciones: normalizeObservacionesPesaje(body.observaciones),
  };
}

/**
 * FASE 5A.1b -- body de POST .../pesajes/:pesajeId/anular. Solo motivo y
 * clientOperationId: el actor (anulado_por) y el instante (anulado_at) salen
 * de la sesión y de Postgres; cualquier otro campo (anuladoPor, anuladoAt,
 * organizacionId, ...) es FORBIDDEN_FIELDS. `identidadEsperada` lo retira
 * antes el middleware común (security/identidadEsperada.js).
 */
export function validateAnularPesajeBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('INVALID_BODY', 'El cuerpo de la solicitud debe ser un objeto JSON.');
  }
  const unknownKeys = Object.keys(body).filter((key) => !ANULAR_ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) throw badRequest('FORBIDDEN_FIELDS', `Campos no permitidos: ${unknownKeys.join(', ')}`);
  if (typeof body.motivo !== 'string') throw badRequest('INVALID_MOTIVO', 'motivo es obligatorio.');
  const motivo = body.motivo.replace(/\r\n?/g, '\n').trim();
  if (motivo === '') throw badRequest('INVALID_MOTIVO', 'motivo es obligatorio.');
  if (motivo.length > MAX_MOTIVO_ANULACION_PESAJE) {
    throw badRequest('INVALID_MOTIVO', `motivo admite máximo ${MAX_MOTIVO_ANULACION_PESAJE} caracteres.`);
  }
  return { clientOperationId: normalizeClientOperationId(body.clientOperationId), motivo };
}
