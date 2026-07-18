// LOTE-003 (ADR-014 §13/§21): la resolución de URL de API y la detección
// de ambiente/hostname local ya no se implementan aquí -- viven en la
// fuente central única src/config/runtimeConfig.js, que además restringe
// el override de agx_api_url/apiUrl a development local (nunca demo,
// staging, producción u otro hostname desplegado) y elimina cualquier
// fallback hacia una URL configurada en build (p. ej. Railway) fuera de
// ese contexto.
import { normalizeApiBase, resolveApiBaseCandidates } from '../../../config/runtimeConfig.js';

const CONFIGURED_API_BASE = import.meta.env.VITE_API_URL || import.meta.env.VITE_AGX_API_URL || '';

function isLocalApiBase(value) {
  const apiBase = normalizeApiBase(value);
  return apiBase.includes('127.0.0.1') || apiBase.includes('localhost');
}

function apiBaseCandidates() {
  return resolveApiBaseCandidates();
}

function logApiAttempt(url) {
  if (typeof console !== 'undefined') {
    console.info(`[AgroGenomaX API] Consultando: ${url}`);
  }
}

function logApiFallback(url, reason) {
  if (typeof console !== 'undefined') {
    console.warn(`[AgroGenomaX API] Falló ${url}: ${reason}`);
  }
}

async function request(path, options = {}) {
  for (const apiBase of apiBaseCandidates()) {
    const url = `${apiBase}${path}`;
    let response;

    try {
      logApiAttempt(url);
      response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
    } catch (error) {
      logApiFallback(url, error.message || 'sin respuesta de red');
      continue;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      logApiFallback(url, `respuesta no JSON (${contentType || 'sin Content-Type'})`);
      continue;
    }

    const payload = await response.json();

    if ([502, 503, 504].includes(response.status)) {
      logApiFallback(url, `HTTP ${response.status}`);
      continue;
    }

    if (!response.ok) {
      const error = new Error(payload?.error || `Error ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  throw new Error('No se pudo conectar con la API de AgroGenomaX. Verifica que el backend o túnel esté disponible.');
}

export function isCloudflareWithoutLocalApi() {
  if (typeof window === 'undefined') return false;
  const isCloudflareHost = window.location.hostname.endsWith('.pages.dev');
  const apiBase = normalizeApiBase(CONFIGURED_API_BASE);
  return isCloudflareHost && isLocalApiBase(apiBase);
}

export const ganaderiaApi = {
  health: () => request('/health'),
  listPredios: () => request('/predios'),
  createPredio: (payload) => request('/predios', { method: 'POST', body: JSON.stringify(payload) }),
  listPotreros: (predioId) => request(predioId ? `/potreros?predio_id=${predioId}` : '/potreros'),
  createPotrero: (payload) => request('/potreros', { method: 'POST', body: JSON.stringify(payload) }),
  lookupQr: (codigo) => request(`/qr/${encodeURIComponent(codigo)}`),
  listAnimales: () => request('/animales'),
  getAnimal: (id) => request(`/animales/${id}`),
  getAnimalRazas: (id) => request(`/animales/${id}/razas`),
  listAnimalPesajes: (id) => request(`/animales/${id}/pesajes`),
  listAnimalPesajesEvolucion: (id) => request(`/animales/${id}/pesajes/evolucion`),
  listAnimalVacunaciones: (id) => request(`/animales/${id}/vacunaciones`),
  listAnimalTratamientos: (id) => request(`/animales/${id}/tratamientos`),
  listAnimalReproduccion: (id) => request(`/animales/${id}/reproduccion`),
  createTratamiento: (payload) => request('/tratamientos', { method: 'POST', body: JSON.stringify(payload) }),
  createReproduccion: (payload) => request('/reproduccion', { method: 'POST', body: JSON.stringify(payload) }),
  createVacunacion: (payload) => request('/vacunaciones', { method: 'POST', body: JSON.stringify(payload) }),
  listCatalogoVacunas: () => request('/catalogo-vacunas'),
  createCatalogoVacuna: (payload) => request('/catalogo-vacunas', { method: 'POST', body: JSON.stringify(payload) }),
  createAnimal: (payload) => request('/animales', { method: 'POST', body: JSON.stringify(payload) }),
  updateAnimal: (id, payload) => request(`/animales/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  createPesaje: (payload) => request('/pesajes', { method: 'POST', body: JSON.stringify(payload) }),
  listRazas: () => request('/razas'),
};

export function getRowId(row) {
  return row?.id ?? row?.predio_id ?? row?.potrero_id ?? row?.animal_id ?? row?.qr_id ?? row?.raza_id ?? row?.codigo;
}

export function getRowLabel(row, fallback = 'Sin nombre') {
  return row?.nombre_predio ?? row?.nombre_raza ?? row?.nombre ?? row?.name ?? row?.codigo_qr ?? row?.codigo ?? row?.codigo_interno ?? row?.internal_code ?? fallback;
}
