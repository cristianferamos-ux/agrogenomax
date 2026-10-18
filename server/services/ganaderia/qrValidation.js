// SPRINT-3D11.3 (R1) -- validación de entrada del inventario QR (Super
// Admin) y del uso de chapetas (organización). Ningún cuerpo de
// organización acepta organizacionId, token, estado ni animal_id; el
// Super Admin solo elige la organización destino de una asignación.
import { CODIGO_LEGACY_PATTERN, normalizeCodigoVisible } from './qrCodigos.js';
import { isValidPositiveId, normalizeClientOperationId } from './animalValidation.js';

const MAX_MOTIVO = 500;
const MAX_LOTE = 5000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ESTADOS_CHAPETA = Object.freeze([
  'EN_INVENTARIO', 'ASIGNADO_ORGANIZACION', 'ASIGNADO_ANIMAL', 'REVOCADO', 'DANADO', 'REEMPLAZADO',
]);
const ESTADOS_CHAPETA_ORGANIZACION = ESTADOS_CHAPETA.filter((estado) => estado !== 'EN_INVENTARIO');

function badRequest(code, message) {
  return Object.assign(new Error(message), { status: 400, code });
}

function rejectUnknownKeys(body, allowedKeys) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('INVALID_BODY', 'El cuerpo de la solicitud debe ser un objeto JSON.');
  }
  const unknownKeys = Object.keys(body).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw badRequest('FORBIDDEN_FIELDS', `Campos no permitidos: ${unknownKeys.join(', ')}`);
  }
}

function optionalText(rawValue, max, code) {
  if (rawValue === undefined || rawValue === null) return null;
  if (typeof rawValue !== 'string') throw badRequest(code, 'Texto inválido.');
  const value = rawValue.replace(/\s+/g, ' ').trim();
  if (value.length > max) throw badRequest(code, `Máximo ${max} caracteres.`);
  return value === '' ? null : value;
}

function requiredMotivo(rawValue) {
  const motivo = typeof rawValue === 'string' ? rawValue.replace(/\s+/g, ' ').trim() : '';
  if (motivo === '' || motivo.length > MAX_MOTIVO) {
    throw badRequest('INVALID_MOTIVO', `El motivo es obligatorio (máximo ${MAX_MOTIVO} caracteres).`);
  }
  return motivo;
}

function positiveInt(rawValue, { min, max, code }) {
  if (!Number.isInteger(rawValue) || rawValue < min || rawValue > max) {
    throw badRequest(code, `Debe ser un entero entre ${min} y ${max}.`);
  }
  return rawValue;
}

/** Código de chapeta en path/body -> canónico o 400. */
export function requireCodigoVisible(rawValue, code = 'INVALID_CODIGO') {
  const codigo = normalizeCodigoVisible(rawValue);
  if (!codigo) throw badRequest(code, 'Código de chapeta inválido.');
  return codigo;
}

function parseListParams(query, allowed) {
  const unknown = Object.keys(query).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw badRequest('INVALID_QUERY', `Parámetros no permitidos: ${unknown.join(', ')}`);
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw badRequest('INVALID_QUERY', 'limit inválido.');
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) throw badRequest('INVALID_QUERY', 'offset inválido.');
  return { limit, offset };
}

// ---------------------------------------------------------------------
// Super Admin
// ---------------------------------------------------------------------

export function validateCrearLoteBody(body) {
  rejectUnknownKeys(body, new Set(['cantidad', 'proveedor', 'observaciones', 'clientOperationId']));
  return {
    cantidad: positiveInt(body.cantidad, { min: 1, max: MAX_LOTE, code: 'INVALID_CANTIDAD' }),
    proveedor: optionalText(body.proveedor, 160, 'INVALID_PROVEEDOR'),
    observaciones: optionalText(body.observaciones, 1000, 'INVALID_OBSERVACIONES'),
    clientOperationId: normalizeClientOperationId(body.clientOperationId),
  };
}

export function validateImportarLegacyBody(body) {
  rejectUnknownKeys(body, new Set(['codigos', 'observaciones', 'clientOperationId']));
  if (!Array.isArray(body.codigos) || body.codigos.length < 1 || body.codigos.length > MAX_LOTE) {
    throw badRequest('INVALID_CODIGOS', `Envía entre 1 y ${MAX_LOTE} códigos.`);
  }
  const codigos = body.codigos.map((raw) => normalizeCodigoVisible(raw));
  if (codigos.some((codigo) => !codigo || !CODIGO_LEGACY_PATTERN.test(codigo))) {
    throw badRequest('INVALID_CODIGOS', 'Solo se importan códigos legacy con formato AGX-000000.');
  }
  if (new Set(codigos).size !== codigos.length) throw badRequest('INVALID_CODIGOS', 'Hay códigos repetidos.');
  return {
    codigos,
    observaciones: optionalText(body.observaciones, 1000, 'INVALID_OBSERVACIONES'),
    clientOperationId: normalizeClientOperationId(body.clientOperationId),
  };
}

export function validateEstadoLoteBody(body) {
  rejectUnknownKeys(body, new Set(['estado']));
  if (!['EN_FABRICACION', 'EN_STOCK', 'CERRADO'].includes(body.estado)) {
    throw badRequest('INVALID_ESTADO', 'Estado de lote inválido.');
  }
  return { estado: body.estado };
}

export function validateAsignarBody(body) {
  rejectUnknownKeys(body, new Set(['organizacionId', 'cantidad', 'codigos', 'referencia', 'clientOperationId']));
  if (typeof body.organizacionId !== 'string' || !UUID_PATTERN.test(body.organizacionId)) {
    throw badRequest('INVALID_ORGANIZACION', 'Organización inválida.');
  }
  if (body.cantidad !== undefined && body.codigos !== undefined) {
    throw badRequest('INVALID_SELECCION', 'Indica cantidad o códigos, no ambos.');
  }
  let codigos;
  if (body.codigos !== undefined) {
    if (!Array.isArray(body.codigos) || body.codigos.length < 1 || body.codigos.length > MAX_LOTE) {
      throw badRequest('INVALID_CODIGOS', `Envía entre 1 y ${MAX_LOTE} códigos.`);
    }
    codigos = body.codigos.map((raw) => normalizeCodigoVisible(raw));
    if (codigos.some((codigo) => !codigo)) throw badRequest('INVALID_CODIGOS', 'Hay códigos inválidos.');
    if (new Set(codigos).size !== codigos.length) throw badRequest('INVALID_CODIGOS', 'Hay códigos repetidos.');
  }
  return {
    organizacionId: body.organizacionId.toLowerCase(),
    cantidad: body.cantidad === undefined ? undefined : positiveInt(body.cantidad, { min: 1, max: MAX_LOTE, code: 'INVALID_CANTIDAD' }),
    codigos,
    referencia: optionalText(body.referencia, 200, 'INVALID_REFERENCIA'),
    clientOperationId: normalizeClientOperationId(body.clientOperationId),
  };
}

export function validateBajaAdminBody(body) {
  rejectUnknownKeys(body, new Set(['motivo']));
  return { motivo: requiredMotivo(body.motivo) };
}

export function validateReemplazarBody(body) {
  rejectUnknownKeys(body, new Set(['codigoNuevo', 'motivo']));
  return { codigoNuevo: requireCodigoVisible(body.codigoNuevo, 'INVALID_CODIGO_NUEVO'), motivo: requiredMotivo(body.motivo) };
}

export function validateListLotesQuery(query) {
  return parseListParams(query, new Set(['limit', 'offset']));
}

export function validateBuscarChapetasQuery(query) {
  const { limit, offset } = parseListParams(query, new Set(['codigo', 'loteId', 'estado', 'organizacionId', 'limit', 'offset']));
  const filtros = { limit, offset };
  if (query.codigo !== undefined) filtros.codigo = requireCodigoVisible(query.codigo);
  if (query.loteId !== undefined) {
    if (!isValidPositiveId(query.loteId)) throw badRequest('INVALID_QUERY', 'loteId inválido.');
    filtros.loteId = query.loteId;
  }
  if (query.estado !== undefined) {
    if (!ESTADOS_CHAPETA.includes(query.estado)) throw badRequest('INVALID_QUERY', 'estado inválido.');
    filtros.estado = query.estado;
  }
  if (query.organizacionId !== undefined) {
    if (typeof query.organizacionId !== 'string' || !UUID_PATTERN.test(query.organizacionId)) {
      throw badRequest('INVALID_QUERY', 'organizacionId inválido.');
    }
    filtros.organizacionId = query.organizacionId.toLowerCase();
  }
  return filtros;
}

// ---------------------------------------------------------------------
// Organización
// ---------------------------------------------------------------------

export function validateListChapetasQuery(query) {
  const { limit, offset } = parseListParams(query, new Set(['estado', 'limit', 'offset']));
  if (query.estado !== undefined && !ESTADOS_CHAPETA_ORGANIZACION.includes(query.estado)) {
    throw badRequest('INVALID_QUERY', 'estado inválido.');
  }
  return { estado: query.estado, limit, offset };
}

export function validateAsociarBody(body) {
  rejectUnknownKeys(body, new Set(['codigoVisible']));
  return { codigoVisible: requireCodigoVisible(body.codigoVisible) };
}

export function validateBajaOrganizacionBody(body) {
  rejectUnknownKeys(body, new Set(['causa', 'motivo']));
  if (!['REVOCADO', 'DANADO'].includes(body.causa)) throw badRequest('INVALID_CAUSA', 'Indica si la chapeta se perdió/revoca o está dañada.');
  return { causa: body.causa, motivo: requiredMotivo(body.motivo) };
}
