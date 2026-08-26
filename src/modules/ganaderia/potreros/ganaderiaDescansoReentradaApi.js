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

// body: { fechaInicioPastoreo } -- ÚNICO input del cliente (§11/§12 del
// sprint), formato YYYY-MM-DD. Calcula pero NO persiste.
export function previewDescansoReentrada(predioId, potreroId, body) {
  return postJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}/descanso-reentrada/preview`, body);
}

// Mismo body que preview -- persiste una recomendación de descanso NUEVA
// (append, nunca sobrescribe una anterior).
export function createDescansoReentrada(predioId, potreroId, body) {
  return postJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}/descanso-reentrada`, body);
}
