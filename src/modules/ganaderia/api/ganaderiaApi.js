const CONFIGURED_API_BASE = import.meta.env.VITE_AGX_API_URL || 'http://127.0.0.1:3001/api';

function normalizeApiBase(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function runtimeApiBase() {
  if (typeof window === 'undefined') return '';

  const params = new URLSearchParams(window.location.search);
  const urlParam = params.get('agx_api_url') || params.get('apiUrl');

  if (urlParam) {
    const normalized = normalizeApiBase(urlParam);
    window.localStorage?.setItem('agx_api_url', normalized);
    return normalized;
  }

  return normalizeApiBase(window.localStorage?.getItem('agx_api_url'));
}

function apiBaseCandidates() {
  const candidates = [runtimeApiBase(), '/api'];

  if (typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    candidates.push('http://127.0.0.1:3001/api');
  }

  candidates.push(normalizeApiBase(CONFIGURED_API_BASE));

  return [...new Set(candidates.filter(Boolean))];
}

async function request(path, options = {}) {
  for (const apiBase of apiBaseCandidates()) {
    let response;

    try {
      response = await fetch(`${apiBase}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
    } catch {
      continue;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      continue;
    }

    const payload = await response.json();

    if ([502, 503, 504].includes(response.status)) {
      continue;
    }

    if (!response.ok) {
      throw new Error(payload?.error || `Error ${response.status}`);
    }

    return payload;
  }

  throw new Error('No se pudo conectar con la API de AgroGenomaX. Verifica que el backend o túnel esté disponible.');
}

export function isCloudflareWithoutLocalApi() {
  if (typeof window === 'undefined') return false;
  const isCloudflareHost = window.location.hostname.endsWith('.pages.dev');
  const apiBase = normalizeApiBase(CONFIGURED_API_BASE);
  const apiIsLocal = apiBase.includes('127.0.0.1') || apiBase.includes('localhost');
  return isCloudflareHost && apiIsLocal;
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
