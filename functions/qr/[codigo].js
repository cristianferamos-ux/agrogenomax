// HOTFIX-LEGACY-QR-CANONICAL-ORIGIN: las chapetas legacy impresas apuntan a
// https://agrogenomax.pages.dev/qr/<codigo>. En ese origen el backend de
// producción rechaza todo POST (CORS: allowlist cerrada a agrogenomax.com),
// así que no se puede iniciar sesión. Solo ese host exacto se redirige
// (302, mientras se valida producción) al origen canónico, conservando el
// código; la entrada pública /qr/:codigo del SPA hace el resto.
//
// Fuera de alcance a propósito: agrogenomax.com, www, los previews
// <rama>.agrogenomax.pages.dev (staging) y cualquier otro host o método
// siguen con next() -- el SPA estático, sin cambios. El destino es fijo:
// nunca se toma de query, cabeceras ni Host.
//
// FASE 3B.2: en cualquier otro host, un GET cuyo valor tiene forma de token
// QR AGX (32 base64url) NO llega al SPA: 303 a la URL limpia /ganaderia/qr
// y el token queda solo en una cookie efímera HttpOnly, acotada a la ruta
// del resolver (mismo nombre y atributos que
// server/security/qrPendienteCookie.js, FASE 3B.1, que la consume en
// POST /api/ganaderia/qr/resolver y la borra).
// Alcance real: las chapetas ya impresas codifican <origen>/qr/<token>, así
// que ESE primer GET legacy sí contiene el token y llega al edge. Después
// de este redirect el token deja de propagarse por la URL visible, el SPA,
// el historial interno de la app, el Referer y la URL de la API.
// Los códigos visibles (AGX-XXXX-XXXX-C, AGX-000001) no son secretos:
// siguen igual (next() al SPA).

export const LEGACY_QR_HOST = 'agrogenomax.pages.dev';
export const CANONICAL_ORIGIN = 'https://agrogenomax.com';
export const QR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
export const CLEAN_RESOLVER_PATH = '/ganaderia/qr';
export const QR_PENDIENTE_COOKIE_PATH = '/api/ganaderia/qr';
export const QR_PENDIENTE_MAX_AGE_SECONDS = 600;

// Nombre por esquema (no por Host ni cabeceras): https -> __Secure-.
export function qrPendienteCookieName(isHttps) {
  return isHttps ? '__Secure-agx_qr_pendiente' : 'agx_qr_pendiente';
}

const SENSITIVE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, no-cache',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

function tokenRedirect(token, isHttps) {
  const attrs = [
    `${qrPendienteCookieName(isHttps)}=${token}`,
    `Max-Age=${QR_PENDIENTE_MAX_AGE_SECONDS}`,
    `Path=${QR_PENDIENTE_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isHttps) attrs.push('Secure');
  return new Response(null, {
    status: 303,
    headers: {
      ...SENSITIVE_HEADERS,
      // Relativa: mismo origen que la chapeta abrió, nunca de la petición.
      Location: CLEAN_RESOLVER_PATH,
      'Set-Cookie': attrs.join('; '),
    },
  });
}

export function onRequest({ request, params, next }) {
  if (request.method !== 'GET') return next();
  const url = new URL(request.url);
  const codigo = typeof params?.codigo === 'string' ? params.codigo : '';

  if (url.hostname === LEGACY_QR_HOST) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${CANONICAL_ORIGIN}/qr/${encodeURIComponent(codigo)}`,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
  }

  if (QR_TOKEN_PATTERN.test(codigo)) return tokenRedirect(codigo, url.protocol === 'https:');
  return next();
}
