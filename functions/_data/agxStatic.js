// LOTE-004B (hallazgo residual del LOTE-004, ADR-014 §7 Barrera 4/§21):
// estos endpoints servían datos de fixtures con
// `Access-Control-Allow-Origin: '*'` incondicional -- cualquier origen
// podía leer la respuesta desde JavaScript. Ahora reutilizan la misma
// política CORS pura de shared/security/corsPolicy.js que ya protege el
// backend Express y el relay real de CatastroX -- una única fuente de
// verdad, sin una segunda política independiente.
import {
  DEFAULT_CORS_HEADERS,
  DEFAULT_CORS_METHODS,
  buildCorsPolicy,
  evaluateCorsRequest,
  resolveAllowedOriginsForEnvironment,
} from '../../shared/security/corsPolicy.js';

const ALLOWED_STATIC_ENVIRONMENTS = Object.freeze(['development', 'test', 'demo', 'staging', 'production']);

function isNonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function parseCommaSeparatedList(rawValue) {
  if (!isNonEmpty(rawValue)) return [];
  return rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Evalúa la solicitud contra la política CORS del ambiente resuelto desde
 * `env.APP_ENV` (el mismo mecanismo que server/index.js y el relay de
 * CatastroX). APP_ENV ausente/inválida o una `CORS_ALLOWED_ORIGINS` mal
 * configurada -- incluyendo cualquier intento de ampliarla en demo, que no
 * admite ningún origen explícito -- se tratan como error de configuración
 * (falla-rápido, 503), nunca como un permiso implícito.
 *
 * Excepción deliberada: si la solicitud no trae cabecera `Origin`
 * (same-origin, *health check*, cliente server-to-server), nunca se
 * bloquea por esto -- ni siquiera un `APP_ENV` mal configurado debe romper
 * esta ruta, porque CORS es irrelevante sin una reclamación cross-origin
 * real. Por eso esta comprobación ocurre ANTES de resolver la política.
 *
 * @param {{request?: Request, env?: Record<string, string>}} context
 */
export function evaluateStaticCors({ request, env } = {}) {
  const origin = request?.headers?.get ? request.headers.get('Origin') : undefined;

  if (origin === undefined || origin === null || origin === '') {
    return { action: 'continue' };
  }

  const appEnv = String(env?.APP_ENV || '').trim();

  if (!ALLOWED_STATIC_ENVIRONMENTS.includes(appEnv)) {
    return { action: 'reject', status: 503 };
  }

  let policy;
  try {
    const allowedOrigins = resolveAllowedOriginsForEnvironment(
      appEnv,
      parseCommaSeparatedList(env?.CORS_ALLOWED_ORIGINS),
    );
    policy = buildCorsPolicy({
      appEnv,
      allowedOrigins,
      allowedMethods: DEFAULT_CORS_METHODS,
      allowedHeaders: DEFAULT_CORS_HEADERS,
      allowCredentials: false,
    });
  } catch {
    return { action: 'reject', status: 503 };
  }

  return evaluateCorsRequest(policy, {
    method: request?.method || 'GET',
    origin,
    requestedMethod: request?.headers?.get ? request.headers.get('Access-Control-Request-Method') : undefined,
    requestedHeaders: request?.headers?.get ? request.headers.get('Access-Control-Request-Headers') : undefined,
  });
}

/** Respuesta para una decisión CORS `reject` -- nunca ejecuta la lógica del endpoint. */
export function corsRejectedResponse(decision) {
  return new Response(null, { status: decision.status || 403 });
}

/**
 * Handler de preflight reutilizable -- cada endpoint lo exporta como
 * `onRequestOptions`. Se resuelve enteramente aquí, sin tocar
 * `findAnimal`/`findQr`/etc.
 */
export function corsPreflightResponse({ request, env } = {}) {
  const decision = evaluateStaticCors({ request, env });
  if (decision.action === 'preflight-ok') {
    return new Response(null, { status: decision.status, headers: decision.headers });
  }
  return new Response(null, { status: decision.status || 403 });
}

const animalRadamantis = {
  animal_id: '4',
  qr_id: '4',
  predio_id: '2',
  codigo_interno: '00003',
  nombre: 'RADAMANTIS',
  sexo: 'Macho',
  raza_principal: 'Angus',
  raza_secundaria: null,
  raza_terciaria: null,
  porcentaje_raza_1: '100.00',
  porcentaje_raza_2: null,
  porcentaje_raza_3: null,
  es_puro: true,
  fecha_nacimiento: '2025-03-12T05:00:00.000Z',
  peso_nacimiento: '50.00',
  color: 'Negro',
  numero_arete: '00003',
  padre_codigo: null,
  madre_codigo: null,
  estado: 'activo',
  observaciones: null,
  fecha_creacion: '2026-05-30T01:42:48.433Z',
};

const qrAgx000003 = {
  qr_id: '4',
  codigo_qr: 'AGX-000003',
  url_qr: null,
  estado: 'asignado',
  fecha_creacion: '2026-05-30T01:40:32.132Z',
};

const radamantisRazas = [
  {
    animal_raza_id: '5',
    animal_id: '4',
    raza_id: '6',
    porcentaje: '100.00',
    fecha_creacion: '2026-05-30T01:42:48.433Z',
    nombre_raza: 'Angus',
    aptitud: 'Carne',
    origen: 'Taurina',
  },
];

/**
 * `decision` es el resultado de `evaluateStaticCors()` para esta misma
 * solicitud -- solo `allow`/`preflight-ok` añaden cabeceras CORS; `continue`
 * (sin Origin) y `reject` nunca las añaden. Sin `decision` (compatibilidad
 * de firma), no se añade ninguna cabecera CORS -- nunca `*` implícito.
 */
export function json(data, init = {}, decision = { action: 'continue' }) {
  const corsHeaders = decision.action === 'allow' || decision.action === 'preflight-ok' ? decision.headers : {};
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders,
      ...(init.headers || {}),
    },
  });
}

export function findQr(codigo) {
  return String(codigo || '').toUpperCase() === 'AGX-000003'
    ? { exists: true, assigned: true, qr: qrAgx000003, animal: animalRadamantis }
    : null;
}

export function findAnimal(id) {
  return String(id || '') === '4' ? animalRadamantis : null;
}

export function findAnimalRazas(id) {
  return String(id || '') === '4' ? radamantisRazas : null;
}
