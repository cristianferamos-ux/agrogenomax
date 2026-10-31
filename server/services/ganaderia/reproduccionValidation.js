// FASE 4A -- validación de eventos reproductivos (agx.reproduccion_eventos,
// 0026). Sin I/O. organizacionId NUNCA se acepta del cliente
// (FORBIDDEN_FIELDS); el tenant sale de la sesión. Catálogos = CHECK de 0026.
//
// Un único POST tipado por tipoEvento: cada tipo admite EXACTAMENTE sus
// campos (un campo de otro tipo -> FORBIDDEN_FIELDS), así un endpoint
// genérico mantiene validación estricta. Los límites que dependen del animal
// (sexo, nacimiento, toro, historial) se validan en el repositorio con el
// animal bloqueado.
import { normalizeClientOperationId, normalizeFecha, normalizeId, normalizeSingleLineText } from './animalValidation.js';

export const MAX_OBSERVACIONES_REPRODUCCION = 500;
export const MAX_MOTIVO_ANULACION = 500;

export const TIPOS_EVENTO_REPRODUCTIVO = Object.freeze([
  'CELO_OBSERVADO',
  'SERVICIO_MONTA',
  'INSEMINACION_ARTIFICIAL',
  'IATF',
  'TRANSFERENCIA_EMBRION',
  'DIAGNOSTICO_PRENEZ',
  'ABORTO',
  'PARTO',
]);

export const INTENSIDADES_CELO = Object.freeze(['BAJA', 'MEDIA', 'ALTA']);
export const METODOS_DETECCION_CELO = Object.freeze(['VISUAL', 'PARCHE_DETECTOR', 'PODOMETRO', 'TORO_CELADOR', 'OTRO']);
export const TIPOS_SERVICIO_MONTA = Object.freeze(['CONTROLADA', 'LIBRE']);
export const CONSERVACIONES_EMBRION = Object.freeze(['FRESCO', 'CONGELADO']);
export const RESULTADOS_DIAGNOSTICO = Object.freeze(['PRENADA', 'VACIA', 'DUDOSA']);
export const METODOS_DIAGNOSTICO = Object.freeze(['PALPACION', 'ECOGRAFIA', 'OTRO']);
export const TIPOS_PARTO = Object.freeze(['NORMAL', 'ASISTIDO', 'CESAREA', 'OTRO']);
export const MAX_DIAS_GESTACION = 300;
export const MAX_NUMERO_CRIAS = 4;

// Campos del evento normalizado (orden fijo: lo usa el hash de intención v1).
export const CAMPOS_EVENTO = Object.freeze([
  'tipoEvento', 'fechaEvento', 'horaEvento',
  'intensidadCelo', 'metodoDeteccion',
  'tipoServicio', 'toroAnimalId', 'toroExterno',
  'semenCodigo', 'protocoloIatf', 'tecnico',
  'embrionCodigo', 'embrionRaza', 'embrionDonadora', 'embrionEstadio', 'embrionCalidad', 'embrionConservacion',
  'diagnosticoResultado', 'diagnosticoMetodo', 'diasGestacion',
  'abortoCausa',
  'partoTipo', 'numeroCrias',
  'observaciones',
]);

const TEXTOS = Object.freeze({
  toroExterno: { max: 120, code: 'INVALID_TORO' },
  semenCodigo: { max: 80, code: 'INVALID_SEMEN' },
  protocoloIatf: { max: 120, code: 'INVALID_PROTOCOLO_IATF' },
  tecnico: { max: 120, code: 'INVALID_TECNICO' },
  embrionCodigo: { max: 80, code: 'INVALID_EMBRION' },
  embrionRaza: { max: 120, code: 'INVALID_EMBRION' },
  embrionDonadora: { max: 120, code: 'INVALID_EMBRION' },
  embrionEstadio: { max: 40, code: 'INVALID_EMBRION' },
  embrionCalidad: { max: 40, code: 'INVALID_EMBRION' },
  abortoCausa: { max: 200, code: 'INVALID_ABORTO_CAUSA' },
});

// Campos propios por tipo (además de los comunes). Debe coincidir con los
// CHECK por grupo de 0026.
const CAMPOS_POR_TIPO = Object.freeze({
  CELO_OBSERVADO: ['intensidadCelo', 'metodoDeteccion'],
  SERVICIO_MONTA: ['tipoServicio', 'toroAnimalId', 'toroExterno'],
  INSEMINACION_ARTIFICIAL: ['toroAnimalId', 'toroExterno', 'semenCodigo', 'tecnico'],
  IATF: ['toroAnimalId', 'toroExterno', 'semenCodigo', 'protocoloIatf', 'tecnico'],
  TRANSFERENCIA_EMBRION: [
    'embrionCodigo', 'embrionRaza', 'embrionDonadora', 'toroExterno',
    'embrionEstadio', 'embrionCalidad', 'embrionConservacion', 'tecnico',
  ],
  DIAGNOSTICO_PRENEZ: ['diagnosticoResultado', 'diagnosticoMetodo', 'diasGestacion', 'tecnico'],
  ABORTO: ['diasGestacion', 'abortoCausa'],
  PARTO: ['partoTipo', 'numeroCrias'],
});

const CAMPOS_COMUNES = Object.freeze(['tipoEvento', 'fechaEvento', 'horaEvento', 'observaciones']);
const HORA_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function badRequest(code, message) {
  return Object.assign(new Error(message), { status: 400, code });
}

function assertObject(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('INVALID_BODY', 'El cuerpo de la solicitud debe ser un objeto JSON.');
  }
}

function rejectUnknownKeys(body, allowed) {
  const unknownKeys = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) throw badRequest('FORBIDDEN_FIELDS', `Campos no permitidos: ${unknownKeys.join(', ')}`);
}

function isAbsent(value) {
  return value === undefined || value === null || value === '';
}

function enumOpcional(raw, allowed, code, field) {
  if (isAbsent(raw)) return null;
  if (typeof raw !== 'string' || !allowed.includes(raw)) {
    throw badRequest(code, `${field} debe ser uno de: ${allowed.join(', ')}.`);
  }
  return raw;
}

function enumObligatorio(raw, allowed, code, field) {
  const value = enumOpcional(raw, allowed, code, field);
  if (value === null) throw badRequest(code, `${field} es obligatorio (${allowed.join(', ')}).`);
  return value;
}

function enteroOpcional(raw, { min, max, code, field }) {
  if (isAbsent(raw)) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    throw badRequest(code, `${field} debe ser un entero entre ${min} y ${max}.`);
  }
  return raw;
}

function textoMultilinea(raw, { max, code, field }) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw badRequest(code, `${field} debe ser texto.`);
  const normalized = raw.replace(/\r\n?/g, '\n').trim();
  if (normalized === '') return null;
  if (normalized.length > max) throw badRequest(code, `${field} admite máximo ${max} caracteres.`);
  return normalized;
}

function normalizeHora(raw, { fecha, hoy, horaAhora }) {
  if (isAbsent(raw)) return null;
  if (typeof raw !== 'string' || !HORA_PATTERN.test(raw)) {
    throw badRequest('INVALID_HORA', 'horaEvento debe tener formato HH:MM (24 h).');
  }
  if (fecha === hoy && horaAhora && raw > horaAhora) {
    throw badRequest('INVALID_HORA', 'horaEvento no puede ser futura.');
  }
  return raw;
}

/**
 * Evento reproductivo normalizado (sin clientOperationId). `hoy` / `horaAhora`
 * = fecha y hora de NEGOCIO (America/Bogota): fecha y hora no futuras.
 */
export function validateEventoReproductivo(body, { hoy, horaAhora } = {}) {
  assertObject(body);
  const tipoEvento = body.tipoEvento;
  if (typeof tipoEvento !== 'string' || !TIPOS_EVENTO_REPRODUCTIVO.includes(tipoEvento)) {
    throw badRequest('INVALID_TIPO_EVENTO', `tipoEvento debe ser uno de: ${TIPOS_EVENTO_REPRODUCTIVO.join(', ')}.`);
  }
  const propios = CAMPOS_POR_TIPO[tipoEvento];
  rejectUnknownKeys(body, new Set([...CAMPOS_COMUNES, ...propios]));

  const fechaEvento = normalizeFecha(body.fechaEvento, { code: 'INVALID_FECHA', field: 'fechaEvento', hoy });
  if (!fechaEvento) throw badRequest('INVALID_FECHA', 'fechaEvento es obligatoria.');

  const value = Object.fromEntries(CAMPOS_EVENTO.map((campo) => [campo, null]));
  value.tipoEvento = tipoEvento;
  value.fechaEvento = fechaEvento;
  value.horaEvento = normalizeHora(body.horaEvento, { fecha: fechaEvento, hoy, horaAhora });
  value.observaciones = textoMultilinea(body.observaciones, {
    max: MAX_OBSERVACIONES_REPRODUCCION, code: 'INVALID_OBSERVACIONES', field: 'observaciones',
  });

  for (const campo of propios) {
    if (TEXTOS[campo]) {
      value[campo] = normalizeSingleLineText(body[campo], { maxLength: TEXTOS[campo].max, code: TEXTOS[campo].code, field: campo });
    }
  }
  if (propios.includes('toroAnimalId')) {
    value.toroAnimalId = normalizeId(body.toroAnimalId, { code: 'INVALID_TORO', field: 'toroAnimalId' });
  }

  switch (tipoEvento) {
    case 'CELO_OBSERVADO':
      value.intensidadCelo = enumOpcional(body.intensidadCelo, INTENSIDADES_CELO, 'INVALID_INTENSIDAD_CELO', 'intensidadCelo');
      value.metodoDeteccion = enumOpcional(body.metodoDeteccion, METODOS_DETECCION_CELO, 'INVALID_METODO_DETECCION', 'metodoDeteccion');
      break;
    case 'SERVICIO_MONTA':
      value.tipoServicio = enumObligatorio(body.tipoServicio, TIPOS_SERVICIO_MONTA, 'INVALID_TIPO_SERVICIO', 'tipoServicio');
      break;
    case 'TRANSFERENCIA_EMBRION':
      value.embrionConservacion = enumObligatorio(
        body.embrionConservacion, CONSERVACIONES_EMBRION, 'INVALID_EMBRION', 'embrionConservacion',
      );
      break;
    case 'DIAGNOSTICO_PRENEZ':
      value.diagnosticoResultado = enumObligatorio(
        body.diagnosticoResultado, RESULTADOS_DIAGNOSTICO, 'INVALID_DIAGNOSTICO', 'diagnosticoResultado',
      );
      value.diagnosticoMetodo = enumObligatorio(body.diagnosticoMetodo, METODOS_DIAGNOSTICO, 'INVALID_DIAGNOSTICO', 'diagnosticoMetodo');
      value.diasGestacion = enteroOpcional(body.diasGestacion, {
        min: 1, max: MAX_DIAS_GESTACION, code: 'INVALID_DIAS_GESTACION', field: 'diasGestacion',
      });
      if (value.diasGestacion !== null && value.diagnosticoResultado !== 'PRENADA') {
        throw badRequest('INVALID_DIAS_GESTACION', 'diasGestacion solo aplica a un diagnóstico PRENADA.');
      }
      break;
    case 'ABORTO':
      value.diasGestacion = enteroOpcional(body.diasGestacion, {
        min: 1, max: MAX_DIAS_GESTACION, code: 'INVALID_DIAS_GESTACION', field: 'diasGestacion',
      });
      break;
    case 'PARTO':
      value.partoTipo = enumObligatorio(body.partoTipo, TIPOS_PARTO, 'INVALID_PARTO', 'partoTipo');
      value.numeroCrias = enteroOpcional(body.numeroCrias, { min: 1, max: MAX_NUMERO_CRIAS, code: 'INVALID_PARTO', field: 'numeroCrias' });
      if (value.numeroCrias === null) throw badRequest('INVALID_PARTO', 'numeroCrias es obligatorio.');
      break;
    default:
      break;
  }
  return value;
}

/** POST .../reproduccion/eventos */
export function validateCrearEventoReproductivoBody(body, opts) {
  assertObject(body);
  const { clientOperationId, ...evento } = body;
  return {
    clientOperationId: normalizeClientOperationId(clientOperationId),
    ...validateEventoReproductivo(evento, opts),
  };
}

function normalizeMotivo(raw) {
  const motivo = textoMultilinea(raw, { max: MAX_MOTIVO_ANULACION, code: 'INVALID_MOTIVO', field: 'motivo' });
  if (!motivo) throw badRequest('INVALID_MOTIVO', 'motivo es obligatorio.');
  return motivo;
}

/** POST .../reproduccion/eventos/:eventoId/anular */
export function validateAnularEventoReproductivoBody(body) {
  assertObject(body);
  rejectUnknownKeys(body, new Set(['motivo', 'clientOperationId']));
  return { clientOperationId: normalizeClientOperationId(body.clientOperationId), motivo: normalizeMotivo(body.motivo) };
}

/**
 * POST .../reproduccion/eventos/:eventoId/corregir -- anula el evento y crea
 * el corregido (puede cambiar de tipo) en la misma transacción.
 */
export function validateCorregirEventoReproductivoBody(body, opts) {
  assertObject(body);
  rejectUnknownKeys(body, new Set(['motivo', 'clientOperationId', 'evento']));
  return {
    clientOperationId: normalizeClientOperationId(body.clientOperationId),
    motivo: normalizeMotivo(body.motivo),
    evento: validateEventoReproductivo(body.evento, opts),
  };
}
