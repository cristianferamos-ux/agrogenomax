// SPRINT-3D7-CAPACIDAD-PASTOREO: cliente API tenant-safe para el cálculo
// de capacidad de pastoreo del potrero. Mismo patrón que
// ganaderiaFichaProductivaApi.js -- fetchCsrfToken + credentials:'include'
// + X-CSRF-Token en mutaciones, GET sin CSRF.
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
