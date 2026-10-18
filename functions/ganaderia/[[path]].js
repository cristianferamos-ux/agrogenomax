// HOTFIX-CANONICAL-GANADERIA-ORIGIN: en https://agrogenomax.pages.dev el
// backend de producción rechaza todo POST de Ganadería (CORS: allowlist
// cerrada a agrogenomax.com), así que login, escrituras y sincronización
// fallan. Solo ese host exacto se redirige (302, mientras se valida) al
// origen canónico conservando ruta y query; el hash nunca llega al
// servidor y el navegador lo reaplica tras la redirección.
//
// Mismo criterio que functions/qr/[codigo].js: agrogenomax.com, www, los
// previews <rama>.agrogenomax.pages.dev y cualquier otro host o método
// siguen con next() -- el SPA estático, sin cambios. /api/ganaderia/* es
// otra Function (functions/api/ganaderia/[[path]].js) y no pasa por aquí.
// El destino es fijo: nunca se toma de query, cabeceras ni Host.

export const LEGACY_GANADERIA_HOST = 'agrogenomax.pages.dev';
export const CANONICAL_ORIGIN = 'https://agrogenomax.com';

export function onRequest({ request, next }) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.hostname !== LEGACY_GANADERIA_HOST) {
    return next();
  }
  const destino = new URL(`${url.pathname}${url.search}`, CANONICAL_ORIGIN);
  if (destino.origin !== CANONICAL_ORIGIN || !/^\/ganaderia(\/|$)/.test(destino.pathname)) {
    return next();
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: destino.href,
      'Cache-Control': 'no-store',
    },
  });
}
