// SPRINT-3D11.2: validación y normalización PURA (sin DB) del dominio
// Animal. La usan server/routes/ganaderiaAnimales.js (cuerpos HTTP) y
// animalesRepository.js (consistencia del estado fusionado al corregir).
// Las reglas de consistencia replican los CHECK de 0022 para responder
// 400 claros antes de llegar a la base -- los CHECK siguen siendo la
// garantía final.
//
// Normalización canónica (también la entrada del hash de intención):
// textos -> trim + espacios internos colapsados ('' -> null); observaciones
// -> trim + saltos de línea normalizados; ids -> string decimal; edad ->
// entero; peso -> number con máximo 1 decimal. organizacionId NUNCA se
// acepta del cliente (FORBIDDEN_FIELDS).

export const SEXOS = Object.freeze(['MACHO', 'HEMBRA']);
export const NACIMIENTO_TIPOS = Object.freeze(['EXACTA', 'APROXIMADA', 'DESCONOCIDA']);
export const RAZA_TIPOS = Object.freeze(['PURA', 'CRUCE', 'DESCONOCIDA']);
export const ORIGEN_TIPOS = Object.freeze(['NACIDO_EN_PREDIO', 'COMPRADO', 'RECIBIDO', 'OTRO']);
export const PESO_METODOS = Object.freeze(['BASCULA', 'ESTIMADO']);
export const ESTADO_FILTROS = Object.freeze(['ACTIVO', 'ANULADO', 'TODOS']);

export const MAX_NUMERO_VISUAL = 40;
export const MAX_NOMBRE = 120;
export const MAX_RAZA_OTRO_NOMBRE = 120;
export const MAX_CRUCE_DESCRIPCION = 200;
export const MAX_PROCEDENCIA = 200;
export const MAX_OBSERVACIONES = 2000;
export const MAX_MOTIVO = 500;
export const MAX_EDAD_MESES = 300;
export const MAX_PESO_KG = 2000;
export const FECHA_MINIMA = '1990-01-01';
export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;
export const LIST_MAX_OFFSET = 100000;
export const MAX_QUERY_LENGTH = 40;

const CLIENT_OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
// bigint positivo sin riesgo de overflow (máx. 18 dígitos).
const POSITIVE_ID_PATTERN = /^[1-9]\d{0,17}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Timestamp ISO-8601 UTC tal como lo serializa la API (microsegundos opcionales).
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

function badRequest(code, message) {
  return Object.assign(new Error(message), { status: 400, code });
}

function isAbsent(value) {
  return value === undefined || value === null;
}

export function normalizeSingleLineText(rawValue, { maxLength, code, field }) {
  if (isAbsent(rawValue)) return null;
  if (typeof rawValue !== 'string') throw badRequest(code, `${field} debe ser texto.`);
  const normalized = rawValue.replace(/\s+/g, ' ').trim();
  if (normalized === '') return null;
  if (normalized.length > maxLength) throw badRequest(code, `${field} admite máximo ${maxLength} caracteres.`);
  return normalized;
}

export function normalizeObservaciones(rawValue) {
  if (isAbsent(rawValue)) return null;
  if (typeof rawValue !== 'string') throw badRequest('INVALID_OBSERVACIONES', 'observaciones debe ser texto.');
  const normalized = rawValue.replace(/\r\n?/g, '\n').trim();
  if (normalized === '') return null;
  if (normalized.length > MAX_OBSERVACIONES) {
    throw badRequest('INVALID_OBSERVACIONES', `observaciones admite máximo ${MAX_OBSERVACIONES} caracteres.`);
  }
  return normalized;
}

export function normalizeId(rawValue, { code, field, required = false }) {
  if (isAbsent(rawValue) || rawValue === '') {
    if (required) throw badRequest(code, `${field} es obligatorio.`);
    return null;
  }
  const asString = typeof rawValue === 'number' && Number.isSafeInteger(rawValue) ? String(rawValue) : rawValue;
  if (typeof asString !== 'string' || !POSITIVE_ID_PATTERN.test(asString)) {
    throw badRequest(code, `${field} inválido.`);
  }
  return asString;
}

export function isValidPositiveId(rawValue) {
  return typeof rawValue === 'string' && POSITIVE_ID_PATTERN.test(rawValue);
}

function normalizeEnum(rawValue, allowed, { code, field, required = false }) {
  if (isAbsent(rawValue) || rawValue === '') {
    if (required) throw badRequest(code, `${field} es obligatorio.`);
    return null;
  }
  if (typeof rawValue !== 'string' || !allowed.includes(rawValue)) {
    throw badRequest(code, `${field} inválido.`);
  }
  return rawValue;
}

function isRealCalendarDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Fechas declaradas por el productor: calendario real, >= 1990-01-01 y
// <= hoy de NEGOCIO (America/Bogota). La cota superior vive aquí y no en un
// CHECK con CURRENT_DATE (no inmutable y dependiente del TimeZone de sesión).
export function normalizeFecha(rawValue, { code, field, hoy }) {
  if (isAbsent(rawValue) || rawValue === '') return null;
  if (typeof rawValue !== 'string' || !isRealCalendarDate(rawValue)) {
    throw badRequest(code, `${field} debe ser una fecha válida (AAAA-MM-DD).`);
  }
  if (rawValue < FECHA_MINIMA) throw badRequest(code, `${field} no puede ser anterior a ${FECHA_MINIMA}.`);
  if (hoy && rawValue > hoy) throw badRequest(code, `${field} no puede ser una fecha futura.`);
  return rawValue;
}

function normalizeEdadMeses(rawValue) {
  if (isAbsent(rawValue) || rawValue === '') return null;
  if (typeof rawValue !== 'number' || !Number.isInteger(rawValue) || rawValue < 0 || rawValue > MAX_EDAD_MESES) {
    throw badRequest('INVALID_NACIMIENTO', `edadAproximadaMeses debe ser un entero entre 0 y ${MAX_EDAD_MESES}.`);
  }
  return rawValue;
}

function normalizePeso(rawValue) {
  if (isAbsent(rawValue) || rawValue === '') return null;
  if (typeof rawValue !== 'number' || !Number.isFinite(rawValue) || rawValue <= 0 || rawValue > MAX_PESO_KG) {
    throw badRequest('INVALID_PESO', `pesoInicialKg debe ser un número mayor que 0 y hasta ${MAX_PESO_KG}.`);
  }
  if (Math.round(rawValue * 10) / 10 !== rawValue) {
    throw badRequest('INVALID_PESO', 'pesoInicialKg admite como máximo un decimal.');
  }
  return rawValue;
}

export function normalizeClientOperationId(rawValue) {
  if (typeof rawValue !== 'string' || !CLIENT_OPERATION_ID_PATTERN.test(rawValue) || rawValue.toLowerCase() === NIL_UUID) {
    throw badRequest('INVALID_CLIENT_OPERATION_ID', 'clientOperationId inválido.');
  }
  return rawValue.toLowerCase();
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

// ---------------------------------------------------------------------
// Grupos de campos (normalización individual)
// ---------------------------------------------------------------------

function normalizeIdentidad(body) {
  return {
    numeroVisual: normalizeSingleLineText(body.numeroVisual, {
      maxLength: MAX_NUMERO_VISUAL, code: 'INVALID_NUMERO_VISUAL', field: 'numeroVisual',
    }),
    nombre: normalizeSingleLineText(body.nombre, { maxLength: MAX_NOMBRE, code: 'INVALID_NOMBRE', field: 'nombre' }),
  };
}

function normalizeNacimiento(body, hoy) {
  return {
    nacimientoTipo: normalizeEnum(body.nacimientoTipo, NACIMIENTO_TIPOS, {
      code: 'INVALID_NACIMIENTO', field: 'nacimientoTipo', required: true,
    }),
    fechaNacimiento: normalizeFecha(body.fechaNacimiento, { code: 'INVALID_NACIMIENTO', field: 'fechaNacimiento', hoy }),
    edadAproximadaMeses: normalizeEdadMeses(body.edadAproximadaMeses),
  };
}

function normalizeRaza(body) {
  return {
    razaTipo: normalizeEnum(body.razaTipo, RAZA_TIPOS, { code: 'INVALID_RAZA', field: 'razaTipo', required: true }),
    razaPrincipalId: normalizeId(body.razaPrincipalId, { code: 'INVALID_RAZA', field: 'razaPrincipalId' }),
    razaOtroNombre: normalizeSingleLineText(body.razaOtroNombre, {
      maxLength: MAX_RAZA_OTRO_NOMBRE, code: 'INVALID_RAZA', field: 'razaOtroNombre',
    }),
    cruceDescripcion: normalizeSingleLineText(body.cruceDescripcion, {
      maxLength: MAX_CRUCE_DESCRIPCION, code: 'INVALID_RAZA', field: 'cruceDescripcion',
    }),
  };
}

function normalizeOrigen(body, hoy) {
  return {
    origenTipo: normalizeEnum(body.origenTipo, ORIGEN_TIPOS, { code: 'INVALID_ORIGEN', field: 'origenTipo' }),
    procedencia: normalizeSingleLineText(body.procedencia, {
      maxLength: MAX_PROCEDENCIA, code: 'INVALID_ORIGEN', field: 'procedencia',
    }),
    fechaIngreso: normalizeFecha(body.fechaIngreso, { code: 'INVALID_ORIGEN', field: 'fechaIngreso', hoy }),
  };
}

// ---------------------------------------------------------------------
// Consistencia (mismas reglas que los CHECK de 0022)
// ---------------------------------------------------------------------

export function validateAnimalConsistency(value) {
  if (value.numeroVisual === null && value.nombre === null) {
    throw badRequest('IDENTIDAD_REQUERIDA', 'Ingresa al menos el número de chapeta o el nombre del animal.');
  }

  if (!SEXOS.includes(value.sexo)) throw badRequest('INVALID_SEXO', 'sexo debe ser MACHO o HEMBRA.');

  const { nacimientoTipo, fechaNacimiento, edadAproximadaMeses } = value;
  const nacimientoOk =
    (nacimientoTipo === 'EXACTA' && fechaNacimiento !== null && edadAproximadaMeses === null)
    || (nacimientoTipo === 'APROXIMADA' && fechaNacimiento === null && edadAproximadaMeses !== null)
    || (nacimientoTipo === 'DESCONOCIDA' && fechaNacimiento === null && edadAproximadaMeses === null);
  if (!nacimientoOk) {
    throw badRequest(
      'INVALID_NACIMIENTO',
      'EXACTA exige solo fechaNacimiento; APROXIMADA exige solo edadAproximadaMeses; DESCONOCIDA no admite ninguno.',
    );
  }

  const { razaTipo, razaPrincipalId, razaOtroNombre, cruceDescripcion } = value;
  const razaOk =
    (razaTipo === 'PURA' && (razaPrincipalId === null) !== (razaOtroNombre === null) && cruceDescripcion === null)
    || (razaTipo === 'CRUCE' && razaOtroNombre === null && (razaPrincipalId !== null || cruceDescripcion !== null))
    || (razaTipo === 'DESCONOCIDA' && razaPrincipalId === null && razaOtroNombre === null && cruceDescripcion === null);
  if (!razaOk) {
    throw badRequest(
      'INVALID_RAZA',
      'PURA exige una raza del catálogo o el nombre de otra raza (no ambos); CRUCE exige raza predominante o descripción; DESCONOCIDA no admite datos de raza.',
    );
  }

  const { origenTipo, procedencia, fechaIngreso } = value;
  if (origenTipo === 'NACIDO_EN_PREDIO' && (procedencia !== null || fechaIngreso !== null)) {
    throw badRequest('INVALID_ORIGEN', 'Un animal nacido en el predio no tiene procedencia ni fecha de ingreso.');
  }
  if (procedencia !== null && origenTipo === null) {
    throw badRequest('INVALID_ORIGEN', 'La procedencia exige indicar el origen.');
  }
  if (fechaIngreso !== null && fechaNacimiento !== null && fechaIngreso < fechaNacimiento) {
    throw badRequest('INVALID_ORIGEN', 'La fecha de ingreso no puede ser anterior a la fecha de nacimiento.');
  }
}

// ---------------------------------------------------------------------
// POST /api/ganaderia/animales
// ---------------------------------------------------------------------

const CREATE_ALLOWED_KEYS = new Set([
  'clientOperationId',
  'predioId',
  'numeroVisual',
  'nombre',
  'sexo',
  'nacimientoTipo',
  'fechaNacimiento',
  'edadAproximadaMeses',
  'razaTipo',
  'razaPrincipalId',
  'razaOtroNombre',
  'cruceDescripcion',
  'categoriaProductivaId',
  'pesoInicialKg',
  'pesoInicialMetodo',
  'origenTipo',
  'procedencia',
  'fechaIngreso',
  'observaciones',
]);

export function validateCreateAnimalBody(body, { hoy }) {
  rejectUnknownKeys(body, CREATE_ALLOWED_KEYS);

  const value = {
    clientOperationId: normalizeClientOperationId(body.clientOperationId),
    predioId: normalizeId(body.predioId, { code: 'INVALID_PREDIO_ID', field: 'predioId', required: true }),
    ...normalizeIdentidad(body),
    sexo: normalizeEnum(body.sexo, SEXOS, { code: 'INVALID_SEXO', field: 'sexo', required: true }),
    ...normalizeNacimiento(body, hoy),
    ...normalizeRaza(body),
    categoriaProductivaId: normalizeId(body.categoriaProductivaId, {
      code: 'INVALID_CATEGORIA', field: 'categoriaProductivaId',
    }),
    ...normalizeOrigen(body, hoy),
    observaciones: normalizeObservaciones(body.observaciones),
    pesoInicialKg: normalizePeso(body.pesoInicialKg),
    pesoInicialMetodo: normalizeEnum(body.pesoInicialMetodo, PESO_METODOS, {
      code: 'INVALID_PESO', field: 'pesoInicialMetodo',
    }),
  };

  if ((value.pesoInicialKg === null) !== (value.pesoInicialMetodo === null)) {
    throw badRequest('INVALID_PESO', 'El peso inicial exige indicar si fue pesado en báscula o estimado (y viceversa).');
  }

  validateAnimalConsistency(value);
  return value;
}

// ---------------------------------------------------------------------
// POST /api/ganaderia/animales/:animalId/corregir
// ---------------------------------------------------------------------

// Cada grupo se corrige completo: si llega una clave del grupo, deben
// llegar todas (evita estados mezclados como PURA + cruce antiguo).
export const CORRECTION_GROUPS = Object.freeze({
  identidad: Object.freeze(['numeroVisual', 'nombre']),
  sexo: Object.freeze(['sexo']),
  nacimiento: Object.freeze(['nacimientoTipo', 'fechaNacimiento', 'edadAproximadaMeses']),
  raza: Object.freeze(['razaTipo', 'razaPrincipalId', 'razaOtroNombre', 'cruceDescripcion']),
  categoria: Object.freeze(['categoriaProductivaId']),
  origen: Object.freeze(['origenTipo', 'procedencia', 'fechaIngreso']),
  observaciones: Object.freeze(['observaciones']),
});

const CORRECTION_ALLOWED_KEYS = new Set([
  'fechaActualizacionEsperada',
  ...Object.values(CORRECTION_GROUPS).flat(),
]);

export function validateCorregirAnimalBody(body, { hoy }) {
  rejectUnknownKeys(body, CORRECTION_ALLOWED_KEYS);

  if (typeof body.fechaActualizacionEsperada !== 'string' || !ISO_TIMESTAMP_PATTERN.test(body.fechaActualizacionEsperada)) {
    throw badRequest('INVALID_FECHA_ACTUALIZACION', 'fechaActualizacionEsperada es obligatoria (ISO-8601 UTC).');
  }

  const presentGroups = Object.entries(CORRECTION_GROUPS)
    .filter(([, keys]) => keys.some((key) => Object.hasOwn(body, key)));
  if (presentGroups.length === 0) {
    throw badRequest('EMPTY_CORRECTION', 'No se indicó ningún dato para corregir.');
  }
  for (const [group, keys] of presentGroups) {
    const missing = keys.filter((key) => !Object.hasOwn(body, key));
    if (missing.length > 0) {
      throw badRequest('INCOMPLETE_CORRECTION_GROUP', `El grupo ${group} debe enviarse completo (faltan: ${missing.join(', ')}).`);
    }
  }

  const groupNames = new Set(presentGroups.map(([group]) => group));
  const cambios = {};
  if (groupNames.has('identidad')) Object.assign(cambios, normalizeIdentidad(body));
  if (groupNames.has('sexo')) {
    cambios.sexo = normalizeEnum(body.sexo, SEXOS, { code: 'INVALID_SEXO', field: 'sexo', required: true });
  }
  if (groupNames.has('nacimiento')) Object.assign(cambios, normalizeNacimiento(body, hoy));
  if (groupNames.has('raza')) Object.assign(cambios, normalizeRaza(body));
  if (groupNames.has('categoria')) {
    cambios.categoriaProductivaId = normalizeId(body.categoriaProductivaId, {
      code: 'INVALID_CATEGORIA', field: 'categoriaProductivaId',
    });
  }
  if (groupNames.has('origen')) Object.assign(cambios, normalizeOrigen(body, hoy));
  if (groupNames.has('observaciones')) cambios.observaciones = normalizeObservaciones(body.observaciones);

  return { fechaActualizacionEsperada: body.fechaActualizacionEsperada, cambios };
}

// ---------------------------------------------------------------------
// POST /api/ganaderia/animales/:animalId/anular
// ---------------------------------------------------------------------

export function validateAnularAnimalBody(body) {
  rejectUnknownKeys(body, new Set(['motivo']));
  const motivo = typeof body.motivo === 'string' ? body.motivo.replace(/\s+/g, ' ').trim() : '';
  if (motivo === '' || motivo.length > MAX_MOTIVO) {
    throw badRequest('INVALID_MOTIVO', `El motivo es obligatorio (máximo ${MAX_MOTIVO} caracteres).`);
  }
  return { motivo };
}

// ---------------------------------------------------------------------
// GET /api/ganaderia/animales
// ---------------------------------------------------------------------

const LIST_ALLOWED_KEYS = new Set(['predioId', 'estado', 'sexo', 'q', 'limit', 'offset']);

function parseNonNegativeIntParam(rawValue, { min, max, fallback }) {
  if (rawValue === undefined) return fallback;
  if (typeof rawValue !== 'string' || !/^\d{1,6}$/.test(rawValue)) throw badRequest('INVALID_QUERY', 'Parámetro de paginación inválido.');
  const parsed = Number(rawValue);
  if (parsed < min || parsed > max) throw badRequest('INVALID_QUERY', 'Parámetro de paginación fuera de rango.');
  return parsed;
}

export function validateListAnimalesQuery(query) {
  const unknownKeys = Object.keys(query || {}).filter((key) => !LIST_ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) throw badRequest('INVALID_QUERY', `Parámetros no permitidos: ${unknownKeys.join(', ')}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (typeof value !== 'string') throw badRequest('INVALID_QUERY', `Parámetro ${key} inválido.`);
  }

  const predioId = query.predioId === undefined || query.predioId === ''
    ? null
    : normalizeId(query.predioId, { code: 'INVALID_QUERY', field: 'predioId' });
  const estado = query.estado === undefined || query.estado === '' ? 'ACTIVO' : query.estado;
  if (!ESTADO_FILTROS.includes(estado)) throw badRequest('INVALID_QUERY', 'estado debe ser ACTIVO, ANULADO o TODOS.');
  const sexo = query.sexo === undefined || query.sexo === '' ? null : query.sexo;
  if (sexo !== null && !SEXOS.includes(sexo)) throw badRequest('INVALID_QUERY', 'sexo debe ser MACHO o HEMBRA.');
  const q = query.q === undefined ? null : query.q.replace(/\s+/g, ' ').trim() || null;
  if (q !== null && q.length > MAX_QUERY_LENGTH) throw badRequest('INVALID_QUERY', `q admite máximo ${MAX_QUERY_LENGTH} caracteres.`);

  return {
    predioId,
    estado,
    sexo,
    q,
    limit: parseNonNegativeIntParam(query.limit, { min: 1, max: LIST_MAX_LIMIT, fallback: LIST_DEFAULT_LIMIT }),
    offset: parseNonNegativeIntParam(query.offset, { min: 0, max: LIST_MAX_OFFSET, fallback: 0 }),
  };
}
