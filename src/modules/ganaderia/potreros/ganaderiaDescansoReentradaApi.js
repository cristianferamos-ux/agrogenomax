// SPRINT-3D8-DESCANSO-REENTRADA: cliente API tenant-safe para el motor de
// descanso y reentrada. Mismo patrón que ganaderiaRecomendacionPastoreoApi.js
// -- fetchCsrfToken + credentials:'include' + X-CSRF-Token en mutaciones,
// GET sin CSRF.
import { getJsonWithSession, postJsonWithCsrf } from '../auth/ganaderiaAuthedRequest.js';

// SPRINT-3D10.5: wrappers locales delegan en el cliente autenticado
// compartido -- GET conserva su contrato exacto (red sigue lanzando);
// POST nunca lanza y nunca se envía si /csrf falla.
function getJson(path) {
  return getJsonWithSession(path);
}

function postJson(path, body) {
  return postJsonWithCsrf(path, body);
}

export function getDescansoReentrada(predioId, potreroId) {
  return getJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}/descanso-reentrada`);
}

// HOTFIX 3D8.1 (AUTOMATIC GRAZING START): fechaInicioPastoreo YA NO es un
// input del cliente -- "Calcular descanso" es UN CLIC, sin body.
// `anclarAFechaExistente` (opcional, "Actualizar estimación", §15):
// pide al servidor usar la fecha de la recomendación de descanso YA
// GUARDADA en vez de hoy -- nunca fija una fecha, solo selecciona el modo.
export function previewDescansoReentrada(predioId, potreroId, { anclarAFechaExistente } = {}) {
  return postJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}/descanso-reentrada/preview`, { anclarAFechaExistente });
}

// `confirmedFechaInicioPastoreo` (opcional, §14): eco de la fecha que el
// cliente vio en su último preview -- NUNCA fija el cálculo, solo permite
// al servidor detectar que el día cambió entre el preview y el guardado
// y pedir un nuevo cálculo en vez de guardar silenciosamente bajo otra
// fecha.
export function createDescansoReentrada(predioId, potreroId, { anclarAFechaExistente, confirmedFechaInicioPastoreo } = {}) {
  return postJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}/descanso-reentrada`, { anclarAFechaExistente, confirmedFechaInicioPastoreo });
}
