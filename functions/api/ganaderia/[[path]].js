// BFF-001 (ADR-009 §8, gate ya superado -- CLOUDFLARE RUNTIME COOKIE
// RELAY GATE: PASS): relay same-origin DEDICADO a Ganadería, aislado por
// completo de functions/api/catastrox/[[path]].js y de su gemela de
// pagos -- no comparte código con ellos, no se toca ninguno de los dos.
// Reutiliza únicamente el mismo validador neutral de URL
// (shared/security/corsPolicy.js) que ya usan todos los relays de este
// repo.
//
// Generaliza EXACTAMENTE lo demostrado por el cookie-probe (funciones/
// api/cookie-probe/[[path]].js) contra el runtime real de Cloudflare
// Pages, nada más:
//   1) Cookie entrante preservada (copia de headers, sin filtrar Cookie).
//   2) redirect:'manual' -- el fetch saliente nunca sigue un 30x por su
//      cuenta.
//   3) Múltiples Set-Cookie: NO se asume que `Headers.getSetCookie()`
//      existe (el gate real demostró que este runtime de Cloudflare Pages
//      Functions no lo expone) -- se hace feature-detection y, si no está
//      disponible, se confía en `new Headers(response.headers)`, que el
//      gate real demostró que SÍ preserva cada Set-Cookie como línea
//      separada en este runtime.
//   4) Cero cabeceras CORS -- flujo same-origin puro, igual que el probe.
import { resolvePublicOriginForEnvironment } from '../../../shared/security/corsPolicy.js';

const ALLOWED_RELAY_ENVIRONMENTS = Object.freeze(['development', 'test', 'staging', 'production']);

function isNonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function configErrorResponse() {
  return new Response(JSON.stringify({ error: 'Relay de Ganadería no disponible.' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const appEnv = String(env.APP_ENV || '').trim();

  // demo (ADR-014 §7 Barrera 2): sin relay funcional en absoluto -- demo
  // no tiene backend real ni sesión que resolver.
  if (appEnv === 'demo') {
    return new Response(null, { status: 404 });
  }

  if (!ALLOWED_RELAY_ENVIRONMENTS.includes(appEnv)) {
    return configErrorResponse();
  }

  const backendBaseUrl = isNonEmpty(env.API_BACKEND_URL)
    ? resolvePublicOriginForEnvironment(env.API_BACKEND_URL, appEnv)
    : null;
  if (!backendBaseUrl) {
    return configErrorResponse();
  }

  const incomingUrl = new URL(request.url);
  const targetUrl = `${backendBaseUrl}${incomingUrl.pathname}${incomingUrl.search}`;

  const headers = new Headers(request.headers);
  headers.delete('host');

  const init = {
    method: request.method,
    headers,
    // Crítico (probe, TEST 4): sin esto, un 30x del backend (p. ej. un
    // futuro callback OAuth) podría seguirse automáticamente en el borde
    // y el navegador nunca vería el redirect real.
    redirect: 'manual',
  };
  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = request.body;
  }

  const backendResponse = await fetch(targetUrl, init);

  const hasGetSetCookie = typeof backendResponse.headers.getSetCookie === 'function';
  const responseHeaders = new Headers(backendResponse.headers);

  if (hasGetSetCookie) {
    // Solo se reconstruye cuando el runtime realmente expone la fuente de
    // verdad -- nunca se borra Set-Cookie a ciegas si no está disponible
    // (ese fue exactamente el bug que el gate real detectó y que este
    // relay evita desde el diseño).
    const groundTruthSetCookies = backendResponse.headers.getSetCookie();
    responseHeaders.delete('Set-Cookie');
    for (const cookie of groundTruthSetCookies) {
      responseHeaders.append('Set-Cookie', cookie);
    }
  }

  // Same-origin por diseño -- cero cabeceras CORS aquí.

  return new Response(backendResponse.body, {
    status: backendResponse.status,
    statusText: backendResponse.statusText,
    headers: responseHeaders,
  });
}
