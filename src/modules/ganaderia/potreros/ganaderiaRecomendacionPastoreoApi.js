// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO: cliente API tenant-safe para
// el motor automático de recomendación de pastoreo + catálogo de
// categorías productivas. Mismo patrón que ganaderiaCapacidadPastoreoApi.js
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

// Catálogo de categorías -- transversal a la organización, NO subordinado
// a predio/potrero.
export function getCategoriasProductivas() {
  return getJson('/api/ganaderia/categorias-productivas');
}

// predioId/potreroId siempre vienen fijos desde la ficha productiva que
// monta el panel -- nunca un selector global.

export function getRecomendacionPastoreo(predioId, potreroId) {
  return getJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}/recomendacion-pastoreo`);
}

// body: { categoriaCodigo, numeroAnimales, pesoPromedioKg, produccionLecheLDia?, terneroAlPie? }
// -- NUNCA biomasaFrescaKg/materiaSecaPct/utilizacionPct/consumoPctPesoVivo/
// resultados/fichaId/contextoId (siempre derivados server-side, §7/§17 del
// sprint). Calcula pero NO persiste.
export function previewRecomendacionPastoreo(predioId, potreroId, body) {
  return postJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}/recomendacion-pastoreo/preview`, body);
}

// Mismo body que preview -- persiste una recomendación NUEVA (append,
// nunca sobrescribe una anterior).
export function createRecomendacionPastoreo(predioId, potreroId, body) {
  return postJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}/recomendacion-pastoreo`, body);
}
