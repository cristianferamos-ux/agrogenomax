// LOTE-006 (ADR-012 §5.1/§17/§33, ADR-014 §7): relay real de health de
// plataforma. Ya no fabrica `{ ok: true, database: 'pages-static-fallback' }`
// como si fuera salud del backend real (functions/_data/agxStatic.js sigue
// vigente para animales/qr, pero este endpoint ya no depende de ella).
// Consulta la única fuente de verdad de liveness del backend:
// `GET <API_BACKEND_URL>/api/health/live` (server/health/liveness.js,
// commit ddca06c) -- nunca fabrica, nunca cachea, nunca consulta base de
// datos, nunca implementa readiness. Reutiliza exclusivamente la política
// CORS compartida de shared/security/corsPolicy.js (misma fuente de
// verdad que el backend Express y el relay de CatastroX), sin crear una
// allowlist paralela.
//
// Corrección LOTE-006 (BLOQUEADO -> este ajuste): validar `API_BACKEND_URL`
// únicamente contra una lista negativa permitía cualquier dominio externo
// que no coincidiera con los patrones ya conocidos -- no es control
// suficiente. El mecanismo POSITIVO y definitivo es ahora
// `API_BACKEND_ALLOWED_ORIGIN` (segunda variable server-side, exclusiva
// de `context.env`, obligatoria en staging/production): tras normalizar
// ambas, `API_BACKEND_URL` debe ser EXACTAMENTE igual a
// `API_BACKEND_ALLOWED_ORIGIN`, o el relay responde 503 sin llamar
// `fetch` y sin revelar ninguno de los dos valores. La lista negativa por
// ambiente se conserva únicamente como defensa adicional, nunca como
// control principal, y se evalúa después de confirmar la igualdad
// positiva. No se hardcodea ningún dominio final de ALB: ambas variables
// se configuran explícitamente server-side; la identidad definitiva del
// backend de cada ambiente se documentará en la matriz completa del
// LOTE-015.
import {
  DEFAULT_CORS_HEADERS,
  DEFAULT_CORS_METHODS,
  buildCorsPolicy,
  evaluateCorsRequest,
  resolveAllowedOriginsForEnvironment,
  resolvePublicOriginForEnvironment,
} from '../../shared/security/corsPolicy.js';

const ALLOWED_RELAY_ENVIRONMENTS = Object.freeze(['development', 'test', 'staging', 'production']);
const UPSTREAM_TIMEOUT_MS = 3000;

// Dominios/orígenes conocidos de OTROS ambientes -- lista negativa exacta
// (nunca por substring) usada únicamente porque todavía no existe un
// dominio final de ALB/backend definido para staging/production (ADR-011:
// sin Dockerfile/Terraform en el repo). No se inventa un dominio positivo;
// se bloquean únicamente los patrones inequívocamente incompatibles ya
// conocidos en el repo. La identidad definitiva del backend de cada
// ambiente quedará cerrada al desplegar AWS staging/production.
const KNOWN_PRODUCTION_APEX_ORIGINS = Object.freeze([
  'https://agrogenomax.com',
  'https://agrogenomax.co',
  'https://www.agrogenomax.com',
  'https://www.agrogenomax.co',
]);
const KNOWN_STAGING_ORIGIN = 'https://staging.agrogenomax.com';
const KNOWN_DEMO_ORIGIN = 'https://demo.agrogenomax.com';
// Único host de Railway conocido en el repo -- era el fallback hardcodeado
// e inseguro eliminado en LOTE-004 de los relays de CatastroX.
const KNOWN_PRODUCTION_RAILWAY_ORIGIN = 'https://agrogenomax-production.up.railway.app';

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

function isLocalBackendOrigin(origin) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/**
 * Defensa ADICIONAL por ambiente -- NUNCA el control principal (ese es
 * `API_BACKEND_ALLOWED_ORIGIN`, verificado por igualdad exacta antes de
 * llegar aquí). development/test aceptan cualquier origen válido
 * explícito (desarrollo local / inyección de pruebas). staging/production
 * rechazan además los patrones ya conocidos de OTRO ambiente -- nunca
 * aceptan localhost, nunca aceptan el dominio de otro ambiente conocido.
 */
function isBackendOriginAllowedForEnv(appEnv, normalizedOrigin) {
  if (appEnv === 'development' || appEnv === 'test') return true;

  if (appEnv === 'staging') {
    if (isLocalBackendOrigin(normalizedOrigin)) return false;
    if (KNOWN_PRODUCTION_APEX_ORIGINS.includes(normalizedOrigin)) return false;
    if (normalizedOrigin === KNOWN_DEMO_ORIGIN) return false;
    if (normalizedOrigin === KNOWN_PRODUCTION_RAILWAY_ORIGIN) return false;
    return true;
  }

  if (appEnv === 'production') {
    if (isLocalBackendOrigin(normalizedOrigin)) return false;
    if (normalizedOrigin === KNOWN_STAGING_ORIGIN) return false;
    if (normalizedOrigin === KNOWN_DEMO_ORIGIN) return false;
    return true;
  }

  return false;
}

/**
 * Telemetría segura. Nunca incluye `API_BACKEND_URL` completa,
 * `Authorization`, cookies, el payload upstream completo, tokens, query
 * string ni stack traces. `context.reporter` es el punto de inyección
 * para pruebas -- en producción no existe, y se usa `console.warn` como
 * *fallback* (observabilidad completa diferida a un lote posterior).
 */
function reportHealthRelayEvent(event, context) {
  if (typeof context?.reporter === 'function') {
    context.reporter(event);
    return;
  }
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(`[AgroGenomaX relay-health] ${event.type}`, {
      appEnv: event.appEnv,
      reason: event.reason,
      upstreamStatus: event.upstreamStatus,
      durationMs: event.durationMs,
      method: event.method,
      path: event.path,
    });
  }
}

function buildResponseHeaders(decision) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (decision?.action === 'allow' && decision.headers) {
    Object.assign(headers, decision.headers);
  }
  return headers;
}

function jsonRelayResponse(status, payload, decision, includeBody) {
  return new Response(includeBody ? JSON.stringify(payload) : null, {
    status,
    headers: { ...buildResponseHeaders(decision), 'Content-Type': 'application/json' },
  });
}

function errorResponse(status, reason, decision, includeBody) {
  return jsonRelayResponse(status, { status: 'error', check: 'liveness', reason }, decision, includeBody);
}

async function fetchUpstreamLiveness(backendOrigin) {
  const targetUrl = new URL('/api/health/live', backendOrigin).toString();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    });
    return { ok: true, response };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: 'network_error' };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method;
  const appEnv = String(env?.APP_ENV || '').trim();
  const includeBody = method !== 'HEAD';

  // Demo (ADR-014 §7): sin backend ni relay funcional, para cualquier
  // método -- ni preflight, ni upstream, ni cabeceras CORS.
  if (appEnv === 'demo') {
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  if (!ALLOWED_RELAY_ENVIRONMENTS.includes(appEnv)) {
    reportHealthRelayEvent(
      { type: 'relay_health_configuration_error', appEnv, reason: 'app_env_invalid', method, path: '/api/health' },
      context,
    );
    return errorResponse(503, 'configuration_error', undefined, includeBody);
  }

  let policy;
  try {
    const allowedOrigins = resolveAllowedOriginsForEnvironment(
      appEnv,
      parseCommaSeparatedList(env.CORS_ALLOWED_ORIGINS),
    );
    policy = buildCorsPolicy({
      appEnv,
      allowedOrigins,
      allowedMethods: DEFAULT_CORS_METHODS,
      allowedHeaders: DEFAULT_CORS_HEADERS,
      allowCredentials: false,
    });
  } catch {
    reportHealthRelayEvent(
      { type: 'relay_health_configuration_error', appEnv, reason: 'cors_configuration_invalid', method, path: '/api/health' },
      context,
    );
    return errorResponse(503, 'configuration_error', undefined, includeBody);
  }

  const origin = request.headers.get('Origin');
  const decision = evaluateCorsRequest(policy, {
    method,
    origin,
    requestedMethod: request.headers.get('Access-Control-Request-Method'),
    requestedHeaders: request.headers.get('Access-Control-Request-Headers'),
  });

  if (decision.action === 'preflight-ok') {
    // OPTIONS se resuelve enteramente aquí -- nunca llama upstream.
    return new Response(null, { status: decision.status, headers: { ...decision.headers, 'Cache-Control': 'no-store' } });
  }

  if (decision.action === 'reject') {
    reportHealthRelayEvent(
      { type: 'relay_health_origin_rejected', appEnv, reason: decision.reason, method, path: '/api/health' },
      context,
    );
    return new Response(null, { status: decision.status || 403, headers: { 'Cache-Control': 'no-store' } });
  }

  // decision.action es 'continue' (sin Origin) o 'allow' (origen
  // permitido): en ambos casos se puede consultar el upstream, solo
  // después de validar API_BACKEND_URL y, a continuación,
  // API_BACKEND_ALLOWED_ORIGIN (mecanismo positivo definitivo).
  // STAGING_READINESS_001 (cierre final, Opción A): antes se validaba con
  // `normalizeOrigin()` puro -- no exigía https ni rechazaba localhost/
  // 127.0.0.1/loopback IPv6/0.0.0.0/wildcard en staging/production, a
  // diferencia de los dos relays de CatastroX. El pinning positivo de más
  // abajo (API_BACKEND_ALLOWED_ORIGIN) mitigaba el riesgo en la práctica,
  // pero no lo eliminaba: nada impedía configurar AMBAS variables con el
  // mismo valor inseguro (p. ej. http://, o localhost) y que el relay lo
  // aceptara igual. `resolvePublicOriginForEnvironment()` cierra ese hueco
  // aquí también, sin tocar el mecanismo de pinning ni el filtro adicional
  // `isBackendOriginAllowedForEnv()` (ambos se conservan, capas de defensa
  // adicionales, nunca el control principal).
  const backendOrigin = isNonEmpty(env.API_BACKEND_URL)
    ? resolvePublicOriginForEnvironment(env.API_BACKEND_URL, appEnv)
    : null;
  if (!backendOrigin) {
    reportHealthRelayEvent(
      { type: 'relay_health_configuration_error', appEnv, reason: 'api_backend_url_missing_or_invalid', method, path: '/api/health' },
      context,
    );
    return errorResponse(503, 'configuration_error', decision, includeBody);
  }

  // Mecanismo POSITIVO: API_BACKEND_ALLOWED_ORIGIN es obligatoria en
  // staging/production; opcional en development/test (si está presente,
  // igual debe coincidir exactamente). Nunca se revela ninguno de los
  // dos valores ante un desacuerdo.
  const backendAllowedOriginRequired = appEnv === 'staging' || appEnv === 'production';
  const rawBackendAllowedOrigin = env.API_BACKEND_ALLOWED_ORIGIN;

  if (backendAllowedOriginRequired && !isNonEmpty(rawBackendAllowedOrigin)) {
    reportHealthRelayEvent(
      { type: 'relay_health_configuration_error', appEnv, reason: 'api_backend_allowed_origin_missing', method, path: '/api/health' },
      context,
    );
    return errorResponse(503, 'configuration_error', decision, includeBody);
  }

  if (isNonEmpty(rawBackendAllowedOrigin)) {
    // Misma regla que API_BACKEND_URL arriba -- API_BACKEND_ALLOWED_ORIGIN
    // es el valor contra el que se hace pinning positivo, así que debe
    // cumplir exactamente los mismos requisitos (https, sin local/loopback/
    // wildcard en staging/production) o la comparación de igualdad de más
    // abajo carecería de sentido.
    const backendAllowedOrigin = resolvePublicOriginForEnvironment(rawBackendAllowedOrigin, appEnv);
    if (!backendAllowedOrigin) {
      reportHealthRelayEvent(
        { type: 'relay_health_configuration_error', appEnv, reason: 'api_backend_allowed_origin_invalid', method, path: '/api/health' },
        context,
      );
      return errorResponse(503, 'configuration_error', decision, includeBody);
    }

    if (backendAllowedOrigin !== backendOrigin) {
      reportHealthRelayEvent(
        { type: 'relay_health_configuration_error', appEnv, reason: 'api_backend_url_mismatch', method, path: '/api/health' },
        context,
      );
      return errorResponse(503, 'configuration_error', decision, includeBody);
    }
  }

  // Defensa adicional (nunca el control principal): patrones ya
  // conocidos de otro ambiente, evaluados solo después de la igualdad
  // positiva anterior.
  if (!isBackendOriginAllowedForEnv(appEnv, backendOrigin)) {
    reportHealthRelayEvent(
      { type: 'relay_health_configuration_error', appEnv, reason: 'api_backend_url_forbidden_for_env', method, path: '/api/health' },
      context,
    );
    return errorResponse(503, 'configuration_error', decision, includeBody);
  }

  const startedAt = Date.now();
  const upstreamResult = await fetchUpstreamLiveness(backendOrigin);
  const durationMs = Date.now() - startedAt;

  if (!upstreamResult.ok) {
    if (upstreamResult.reason === 'timeout') {
      reportHealthRelayEvent(
        { type: 'relay_health_timeout', appEnv, durationMs, method, path: '/api/health' },
        context,
      );
      return errorResponse(504, 'upstream_timeout', decision, includeBody);
    }
    reportHealthRelayEvent(
      { type: 'relay_health_network_error', appEnv, durationMs, method, path: '/api/health' },
      context,
    );
    return errorResponse(502, 'upstream_unreachable', decision, includeBody);
  }

  const { response: upstreamResponse } = upstreamResult;

  if (!upstreamResponse.ok) {
    reportHealthRelayEvent(
      {
        type: 'relay_health_upstream_unhealthy',
        appEnv,
        upstreamStatus: upstreamResponse.status,
        durationMs,
        method,
        path: '/api/health',
      },
      context,
    );
    // 503: el backend indicó explícitamente no-disponibilidad. Cualquier
    // otro no-2xx: respuesta upstream inválida/no saludable de forma
    // genérica.
    return errorResponse(upstreamResponse.status === 503 ? 503 : 502, 'upstream_unhealthy', decision, includeBody);
  }

  const contentType = upstreamResponse.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    reportHealthRelayEvent(
      { type: 'relay_health_invalid_payload', appEnv, reason: 'non_json_content_type', durationMs, method, path: '/api/health' },
      context,
    );
    return errorResponse(502, 'invalid_upstream_payload', decision, includeBody);
  }

  let upstreamPayload;
  try {
    upstreamPayload = await upstreamResponse.json();
  } catch {
    reportHealthRelayEvent(
      { type: 'relay_health_invalid_payload', appEnv, reason: 'malformed_json', durationMs, method, path: '/api/health' },
      context,
    );
    return errorResponse(502, 'invalid_upstream_payload', decision, includeBody);
  }

  if (typeof upstreamPayload?.status !== 'string' || typeof upstreamPayload?.check !== 'string') {
    reportHealthRelayEvent(
      { type: 'relay_health_invalid_payload', appEnv, reason: 'missing_expected_fields', durationMs, method, path: '/api/health' },
      context,
    );
    return errorResponse(502, 'invalid_upstream_payload', decision, includeBody);
  }

  if (upstreamPayload.check !== 'liveness') {
    reportHealthRelayEvent(
      { type: 'relay_health_invalid_payload', appEnv, reason: 'unexpected_check', durationMs, method, path: '/api/health' },
      context,
    );
    return errorResponse(502, 'invalid_upstream_payload', decision, includeBody);
  }

  if (upstreamPayload.status !== 'ok') {
    reportHealthRelayEvent(
      { type: 'relay_health_upstream_unhealthy', appEnv, reason: 'status_not_ok', durationMs, method, path: '/api/health' },
      context,
    );
    return errorResponse(502, 'upstream_unhealthy', decision, includeBody);
  }

  // Únicamente los campos permitidos se propagan -- cualquier campo extra
  // inesperado del upstream se descarta.
  const safePayload = { status: upstreamPayload.status, check: upstreamPayload.check };
  if (typeof upstreamPayload.timestamp === 'string') safePayload.timestamp = upstreamPayload.timestamp;
  if (typeof upstreamPayload.appEnv === 'string') safePayload.appEnv = upstreamPayload.appEnv;

  return jsonRelayResponse(200, safePayload, decision, includeBody);
}
