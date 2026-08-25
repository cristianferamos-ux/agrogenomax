// SPRINT-3D7.1-AGROCLIMA: cliente API tenant-safe para el contexto
// agroclimático del potrero. Mismo patrón que ganaderiaCapacidadPastoreoApi.js
// -- fetchCsrfToken + credentials:'include' + X-CSRF-Token en mutaciones,
// GET sin CSRF. refresh() nunca envía body -- lat/lng se resuelven
// server-side desde la geometry del potrero (§12 del sprint).
import { fetchCsrfToken } from '../auth/GanaderiaAuthContext.jsx';

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function getJson(path) {
  const response = await fetch(path, { credentials: 'include' });
  const data = await parseJson(response);
  return { ok: response.ok, status: response.status, data };
}

async function postJson(path) {
  const csrfToken = await fetchCsrfToken();
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'X-CSRF-Token': csrfToken },
  });
  const data = await parseJson(response);
  return { ok: response.ok, status: response.status, data };
}

// predioId/potreroId siempre vienen fijos desde la tarjeta del potrero que
// monta este panel -- nunca un selector global.

export function getContextoAgroclimatico(predioId, potreroId) {
  return getJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}/contexto-agroclimatico`);
}

export function refreshContextoAgroclimatico(predioId, potreroId) {
  return postJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}/contexto-agroclimatico/refresh`);
}
