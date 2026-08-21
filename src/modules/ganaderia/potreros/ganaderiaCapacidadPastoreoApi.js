// SPRINT-3D7-CAPACIDAD-PASTOREO: cliente API tenant-safe para el cálculo
// de capacidad de pastoreo del potrero. Mismo patrón que
// ganaderiaFichaProductivaApi.js -- fetchCsrfToken + credentials:'include'
// + X-CSRF-Token en mutaciones, GET sin CSRF.
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

// predioId/potreroId siempre vienen fijos desde la ficha productiva que
// monta el panel (ver PotreroFichaProductivaPanel.jsx) -- nunca un
// selector global.

export function getCapacidadPastoreo(predioId, potreroId) {
  return getJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}/capacidad-pastoreo`);
}

// body: { modo, pesoVivoPromedioKg, porcentajeMateriaSeca, porcentajeUtilizacion,
// consumoPctPesoVivo, numeroAnimales | periodoObjetivoDias } -- NUNCA
// biomasaFrescaKg/materiaSecaTotalKg/materiaSecaUtilizableKg/
// demandaDiariaLoteKgMs/diasOcupacionEstimados/capacidadAnimalesPeriodo/
// areaHa/fichaId (siempre derivados server-side, §22 del sprint). Calcula
// pero NO persiste.
export function previewCapacidadPastoreo(predioId, potreroId, body) {
  return postJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}/capacidad-pastoreo/preview`, body);
}

// Mismo body que preview + observaciones opcionales -- persiste un
// cálculo NUEVO (append, nunca sobrescribe uno anterior).
export function createCapacidadPastoreo(predioId, potreroId, body) {
  return postJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}/capacidad-pastoreo`, body);
}
