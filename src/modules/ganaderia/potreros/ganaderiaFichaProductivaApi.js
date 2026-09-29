// SPRINT-3D6-FICHA-PRODUCTIVA: cliente API tenant-safe para la ficha
// productiva del potrero y el catálogo de pasturas. Mismo patrón que
// ganaderiaPotrerosApi.js -- fetchCsrfToken + credentials:'include' +
// X-CSRF-Token en mutaciones, GET sin CSRF.
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
