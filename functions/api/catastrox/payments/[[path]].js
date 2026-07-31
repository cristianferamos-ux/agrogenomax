// LOTE-004 (ADR-014 §7 Barrera 4/§21, ADR-013 §21): relay same-origin de
// pagos de CatastroX -- gemela de functions/api/catastrox/[[path]].js,
// misma corrección: reflejaba `Origin` sin validar, con fallback `*`,
// reflejaba `Access-Control-Request-Headers` sin filtrar, y caía a una URL
// de Railway hardcodeada si `API_BACKEND_URL` no estaba configurada. Ahora
// usa la misma política CORS pura que el backend Express
// (shared/security/corsPolicy.js) y nunca elige un upstream sugerido por
// el cliente.
import {
  DEFAULT_CORS_HEADERS,
  DEFAULT_CORS_METHODS,
  buildCorsPolicy,
  evaluateCorsRequest,
  resolveAllowedOriginsForEnvironment,
  resolvePublicOriginForEnvironment,
} from '../../../../shared/security/corsPolicy.js';

const ALLOWED_RELAY_ENVIRONMENTS = Object.freeze(['development', 'test', 'staging', 'production']);

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

function configErrorResponse() {
  // Mensaje genérico y estable -- nunca revela APP_ENV, API_BACKEND_URL ni
  // ningún otro valor de configuración.
  return new Response(JSON.stringify({ error: 'Configuración del relay no disponible.' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const appEnv = String(env.APP_ENV || '').trim();

  // Demo (ADR-014 §7 Barrera 2): sin relay funcional en absoluto, para
  // cualquier método -- ni preflight, ni upstream, ni cabeceras CORS.
  if (appEnv === 'demo') {
    return new Response(null, { status: 404 });
  }

  if (!ALLOWED_RELAY_ENVIRONMENTS.includes(appEnv)) {
    console.warn(`[AgroGenomaX relay pagos] APP_ENV ausente o inválida -- relay bloqueado.`);
    return configErrorResponse();
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
    console.warn(`[AgroGenomaX relay pagos] Allowlist de CORS inválida para ambiente="${appEnv}" -- relay bloqueado.`);
    return configErrorResponse();
  }

  const origin = request.headers.get('Origin');
  const decision = evaluateCorsRequest(policy, {
    method: request.method,
    origin,
    requestedMethod: request.headers.get('Access-Control-Request-Method'),
    requestedHeaders: request.headers.get('Access-Control-Request-Headers'),
  });

  if (decision.action === 'preflight-ok') {
    // OPTIONS se resuelve enteramente en Cloudflare -- nunca se reenvía al
    // upstream, nunca ejecuta lógica de negocio, nunca crea sesiones.
    return new Response(null, { status: decision.status, headers: decision.headers });
  }

  if (decision.action === 'reject') {
    console.warn(
      `[AgroGenomaX relay pagos] Origen rechazado (ambiente="${appEnv}", motivo="${decision.reason}", metodo="${request.method}").`,
    );
    return new Response(null, { status: decision.status || 403 });
  }

  // decision.action es 'continue' (sin Origin -- same-origin/server-to-server)
  // o 'allow' (origen permitido): en ambos casos se puede contactar al
  // upstream, pero solo después de validar API_BACKEND_URL a continuación.
  // STAGING_READINESS_001 (Bloque 4): en staging/production, API_BACKEND_URL
  // debe ser https y nunca apuntar a localhost/127.0.0.1 -- ver
  // resolvePublicOriginForEnvironment() en shared/security/corsPolicy.js.
  const backendBaseUrl = isNonEmpty(env.API_BACKEND_URL)
    ? resolvePublicOriginForEnvironment(env.API_BACKEND_URL, appEnv)
    : null;
  if (!backendBaseUrl) {
    console.warn(`[AgroGenomaX relay pagos] API_BACKEND_URL ausente o inválida para ambiente="${appEnv}".`);
    return configErrorResponse();
  }

  const incomingUrl = new URL(request.url);
  const targetUrl = `${backendBaseUrl}${incomingUrl.pathname}${incomingUrl.search}`;

  const headers = new Headers(request.headers);
  headers.delete('host');

  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
  };

  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = request.body;
  }

  const backendResponse = await fetch(targetUrl, init);
  const responseHeaders = new Headers(backendResponse.headers);

  if (decision.action === 'allow') {
    for (const [key, value] of Object.entries(decision.headers)) {
      responseHeaders.set(key, value);
    }
  }

  return new Response(backendResponse.body, {
    status: backendResponse.status,
    statusText: backendResponse.statusText,
    headers: responseHeaders,
  });
}
