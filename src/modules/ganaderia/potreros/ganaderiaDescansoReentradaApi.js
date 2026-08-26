// SPRINT-3D8-DESCANSO-REENTRADA: cliente API tenant-safe para el motor de
// descanso y reentrada. Mismo patrón que ganaderiaRecomendacionPastoreoApi.js
// -- fetchCsrfToken + credentials:'include' + X-CSRF-Token en mutaciones,
// GET sin CSRF.
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

async function postJson(path, body) {
  const csrfToken = await fetchCsrfToken();
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(body),
  });
  const data = await parseJson(response);
  return { ok: response.ok, status: response.status, data };
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
