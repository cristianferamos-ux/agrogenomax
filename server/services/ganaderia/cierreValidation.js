// FASE 2A -- validación del cierre operativo del animal (SALIDA / MUERTE).
// POST /api/ganaderia/animales/:animalId/salida | /muerte. Sin I/O.
// organizacionId NUNCA se acepta del cliente (FORBIDDEN_FIELDS); el tenant
// sale de la sesión. Catálogos = CHECK de 0025 (animales_cierre_consistency_check).
import { normalizeClientOperationId, normalizeFecha } from './animalValidation.js';

export const MAX_OBSERVACIONES_CIERRE = 500;

// SALIDA: el animal deja el hato de la organización por una causa operativa.
// TRASLADO = hacia un destino EXTERNO (los movimientos entre predios propios
// no son salida).
export const MOTIVOS_SALIDA = Object.freeze(['VENTA', 'TRASLADO', 'DONACION', 'INTERCAMBIO', 'DEVOLUCION', 'OTRA']);
// MUERTE: el animal falleció. SACRIFICIO es muerte, no salida.
export const CAUSAS_MUERTE = Object.freeze([
  'MUERTE_NATURAL', 'ENFERMEDAD', 'ACCIDENTE', 'SACRIFICIO', 'DEPREDACION', 'DESCONOCIDA', 'OTRA',
]);

export const TIPOS_CIERRE = Object.freeze({
  SALIDA: Object.freeze({
    estadoOperativo: 'SALIDO',
    tipoEvento: 'SALIDO',
    campoFecha: 'fechaSalida',
    campoCausa: 'motivoSalida',
    causas: MOTIVOS_SALIDA,
    codigoCausa: 'INVALID_MOTIVO_SALIDA',
    claveMetadata: 'motivo',
  }),
  MUERTE: Object.freeze({
    estadoOperativo: 'MUERTO',
    tipoEvento: 'MUERTO',
    campoFecha: 'fechaMuerte',
    campoCausa: 'causaMuerte',
    causas: CAUSAS_MUERTE,
    codigoCausa: 'INVALID_CAUSA_MUERTE',
    claveMetadata: 'causa',
  }),
});

function badRequest(code, message) {
  return Object.assign(new Error(message), { status: 400, code });
}

/**
 * 409 para escrituras sobre un animal que ya dejó el hato o murió (pesajes,
 * chapetas QR, nuevo cierre). null si sigue EN_HATO. `accion` completa el
 * mensaje ("no admite nuevos pesajes").
 */
export function errorAnimalCerrado(estadoOperativo, accion) {
  if (estadoOperativo === 'SALIDO') {
    return Object.assign(new Error(`El animal ya salió del hato: ${accion}.`), { status: 409, code: 'ANIMAL_YA_SALIDO' });
  }
  if (estadoOperativo === 'MUERTO') {
    return Object.assign(new Error(`El animal está registrado como muerto: ${accion}.`), { status: 409, code: 'ANIMAL_YA_MUERTO' });
  }
  return null;
}

function normalizeObservacionesCierre(rawValue) {
  if (rawValue === undefined || rawValue === null) return null;
  if (typeof rawValue !== 'string') throw badRequest('INVALID_OBSERVACIONES', 'observaciones debe ser texto.');
  const normalized = rawValue.replace(/\r\n?/g, '\n').trim();
  if (normalized === '') return null;
  if (normalized.length > MAX_OBSERVACIONES_CIERRE) {
    throw badRequest('INVALID_OBSERVACIONES', `observaciones admite máximo ${MAX_OBSERVACIONES_CIERRE} caracteres.`);
  }
  return normalized;
}

/**
 * Body del POST de cierre. `tipo` = 'SALIDA' | 'MUERTE'. `hoy` = fecha de
 * NEGOCIO (America/Bogota): la fecha efectiva no puede ser futura. Los
 * límites que dependen del animal (nacimiento, ingreso, último pesaje) se
 * validan en el repositorio, con el animal bloqueado.
 */
export function validateCierreBody(tipo, body, { hoy }) {
  const config = TIPOS_CIERRE[tipo];
  if (!config) throw new Error(`Tipo de cierre desconocido: ${tipo}`);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('INVALID_BODY', 'El cuerpo de la solicitud debe ser un objeto JSON.');
  }
  const allowed = new Set([config.campoFecha, config.campoCausa, 'observaciones', 'clientOperationId']);
  const unknownKeys = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) throw badRequest('FORBIDDEN_FIELDS', `Campos no permitidos: ${unknownKeys.join(', ')}`);

  const fecha = normalizeFecha(body[config.campoFecha], { code: 'INVALID_FECHA', field: config.campoFecha, hoy });
  if (!fecha) throw badRequest('INVALID_FECHA', `${config.campoFecha} es obligatoria.`);
  const causa = body[config.campoCausa];
  if (typeof causa !== 'string' || !config.causas.includes(causa)) {
    throw badRequest(config.codigoCausa, `${config.campoCausa} debe ser uno de: ${config.causas.join(', ')}.`);
  }
  return {
    tipo,
    clientOperationId: normalizeClientOperationId(body.clientOperationId),
    fecha,
    causa,
    observaciones: normalizeObservacionesCierre(body.observaciones),
  };
}
