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

export const LEGACY_QR_HOST = 'agrogenomax.pages.dev';
export const CANONICAL_ORIGIN = 'https://agrogenomax.com';

export function onRequest({ request, params, next }) {
  if (request.method !== 'GET' || new URL(request.url).hostname !== LEGACY_QR_HOST) {
    return next();
  }
  const codigo = typeof params?.codigo === 'string' ? params.codigo : '';
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${CANONICAL_ORIGIN}/qr/${encodeURIComponent(codigo)}`,
      'Cache-Control': 'no-store',
    },
  });
}
