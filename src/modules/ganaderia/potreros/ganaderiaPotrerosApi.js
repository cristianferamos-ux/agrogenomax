// SPRINT-3D4 — REGISTRAR POTRERO (UI): cliente API tenant-safe para
// Potreros. Mismo patrón que PrediosPage.jsx (fetchCsrfToken +
// credentials:'include' + X-CSRF-Token en mutaciones, GET sin CSRF ya
// que createRequireGanaderiaCsrf deja pasar GET/HEAD/OPTIONS) -- habla
// EXCLUSIVAMENTE con /api/ganaderia/predios/:predioId/potreros/*
// (server/routes/ganaderiaPotreros.js, Postgres-AGX-Business,
// org-scoped, subordinado a predioId). Nunca con el router legacy
// /api/potreros ni con ganaderiaApi.js (listPotreros/createPotrero
// legacy, sin aislamiento por organización ni CSRF).
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

// predioId siempre viene del contexto ya fijado por la tarjeta del predio
// (nunca de un selector global) -- ver PotreroRegistrationPanel.jsx /
// PotrerosByPredioPanel.jsx.

// SPRINT-3D9.2: incluirArchivados=true es el único opt-in explícito para
// ver potreros ARCHIVADO -- por defecto (sin el parámetro) el backend ya
// filtra a estado=ACTIVO (potrerosRepository.js).
export function listPotrerosByPredio(predioId, { incluirArchivados = false } = {}) {
  const query = incluirArchivados ? '?incluirArchivados=true' : '';
  return getJson(`/api/ganaderia/predios/${predioId}/potreros${query}`);
}

export function archivarPotrero(predioId, potreroId, motivo) {
  return postJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}/archivar`, { motivo });
}

export function restaurarPotrero(predioId, potreroId) {
  return postJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}/restaurar`, {});
}

export function getPotreroByPredio(predioId, potreroId) {
  return getJson(`/api/ganaderia/predios/${predioId}/potreros/${potreroId}`);
}

export function previewPotreroCoordinates(predioId, puntos) {
  return postJson(`/api/ganaderia/predios/${predioId}/potreros/preview-coordinates`, { puntos });
}

export function previewPotreroGps(predioId, puntos) {
  return postJson(`/api/ganaderia/predios/${predioId}/potreros/preview-gps`, { puntos });
}

// SPRINT-3D5: el archivo (File/Blob del <input type="file">) viaja crudo en
// el body -- NUNCA se lee con FileReader ni se convierte a geometry en el
// cliente, eso es exclusivamente responsabilidad del backend
// (potreroKmlImport.js). El nombre del archivo va codificado en un header
// (los headers HTTP no aceptan con seguridad acentos/espacios sin escapar)
// -- el backend solo usa la extensión final (.kml/.kmz), que
// encodeURIComponent nunca altera.
export async function previewPotreroFile(predioId, file) {
  const csrfToken = await fetchCsrfToken();
  const response = await fetch(`/api/ganaderia/predios/${predioId}/potreros/preview-file`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-CSRF-Token': csrfToken,
      'X-Potrero-File-Name': encodeURIComponent(file.name || ''),
    },
    body: file,
  });
  const data = await parseJson(response);
  return { ok: response.ok, status: response.status, data };
}

// body: { candidateId, nombre, capacidadAnimales?, observaciones? } --
// NUNCA geometry/areaHa/metodoDelimitacion/organizacionId/predioId (esos
// tres primeros vienen exclusivamente del candidate ya validado
// server-side; organizacionId de la sesión; predioId va en el path).
export function createPotrero(predioId, payload) {
  return postJson(`/api/ganaderia/predios/${predioId}/potreros`, payload);
}
