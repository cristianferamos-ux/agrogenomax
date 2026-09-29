// SPRINT-3D7.1-AGROCLIMA: cliente API tenant-safe para el contexto
// agroclimático del potrero. Mismo patrón que ganaderiaCapacidadPastoreoApi.js
// -- fetchCsrfToken + credentials:'include' + X-CSRF-Token en mutaciones,
// GET sin CSRF. refresh() nunca envía body -- lat/lng se resuelven
// server-side desde la geometry del potrero (§12 del sprint).
import { getJsonWithSession, postWithCsrf } from '../auth/ganaderiaAuthedRequest.js';

// SPRINT-3D10.5: wrappers locales delegan en el cliente autenticado
// compartido -- GET conserva su contrato exacto (red sigue lanzando);
// POST nunca lanza y nunca se envía si /csrf falla.
function getJson(path) {
  return getJsonWithSession(path);
}

function postJson(path) {
  // Sin body ni Content-Type -- idéntico al postJson previo.
  return postWithCsrf(path);
}

// predioId/potreroId siempre vienen fijos desde la tarjeta del potrero que
// monta este panel -- nunca un selector global.

export function getContextoAgroclimatico(predioId, potreroId) {
  return getJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}/contexto-agroclimatico`);
}

export function refreshContextoAgroclimatico(predioId, potreroId) {
  return postJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}/contexto-agroclimatico/refresh`);
}
