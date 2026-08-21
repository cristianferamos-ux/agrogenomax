// SPRINT-3D6-FICHA-PRODUCTIVA: cliente API tenant-safe para la ficha
// productiva del potrero y el catálogo de pasturas. Mismo patrón que
// ganaderiaPotrerosApi.js -- fetchCsrfToken + credentials:'include' +
// X-CSRF-Token en mutaciones, GET sin CSRF.
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

// predioId/potreroId siempre vienen fijos desde la card que monta el
// panel (ver PotrerosByPredioPanel.jsx) -- nunca un selector global.

export function getFichaProductiva(predioId, potreroId) {
  return getJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}/ficha-productiva`);
}

// body: { especies: [{ pasturaId, porcentajeEstimado? }], aforoPromedioGM2,
// numeroMuestras?, fechaAforo?, observaciones?, nombrePersonalizado? } --
// NUNCA areaHa/biomasaTotalKg/tipoCobertura/nombrePrincipal/organizacionId/
// predioId/potreroId (siempre derivados server-side, §15 del sprint).
export function createFichaProductiva(predioId, potreroId, body) {
  return postJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}/ficha-productiva`, body);
}

export function listCatalogoPasturas(search = '') {
  const query = search.trim() ? `?q=${encodeURIComponent(search.trim())}` : '';
  return getJson(`/api/ganaderia/catalogo-pasturas${query}`);
}

// body: { nombreComun, nombreCientifico?, genero?, especie?, cultivar?, tipo }
export function createPasturaPersonalizada(body) {
  return postJson('/api/ganaderia/catalogo-pasturas/personalizadas', body);
}
