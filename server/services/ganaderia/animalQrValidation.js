// SPRINT-3D11.3 (R1) -- validación de los cuerpos de /qr. Ningún cuerpo
// acepta organizacionId, animalId, token ni valor: el tenant sale de la
// sesión, el animal de la URL y el token lo genera el servidor.
import { normalizeClientOperationId } from './animalValidation.js';

const MAX_MOTIVO = 500;

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

function normalizeMotivo(rawValue) {
  const motivo = typeof rawValue === 'string' ? rawValue.replace(/\s+/g, ' ').trim() : '';
  if (motivo === '' || motivo.length > MAX_MOTIVO) {
    throw badRequest('INVALID_MOTIVO', `El motivo es obligatorio (máximo ${MAX_MOTIVO} caracteres).`);
  }
  return motivo;
}

export function validateAsignarQrBody(body) {
  rejectUnknownKeys(body ?? {}, new Set());
  return {};
}

export function validateRevocarQrBody(body) {
  rejectUnknownKeys(body, new Set(['motivo']));
  return { motivo: normalizeMotivo(body.motivo) };
}

export function validateReemplazarQrBody(body) {
  rejectUnknownKeys(body, new Set(['motivo', 'clientOperationId']));
  return {
    motivo: normalizeMotivo(body.motivo),
    clientOperationId: normalizeClientOperationId(body.clientOperationId),
  };
}
