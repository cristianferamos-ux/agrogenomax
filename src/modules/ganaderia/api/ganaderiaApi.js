const API_BASE = import.meta.env.VITE_AGX_API_URL || 'http://127.0.0.1:3001/api';

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    throw new Error(payload?.error || `Error ${response.status}`);
  }

  return payload;
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
  createAnimal: (payload) => request('/animales', { method: 'POST', body: JSON.stringify(payload) }),
  updateAnimal: (id, payload) => request(`/animales/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  listRazas: () => request('/razas'),
};

export function getRowId(row) {
  return row?.id ?? row?.predio_id ?? row?.potrero_id ?? row?.animal_id ?? row?.qr_id ?? row?.raza_id ?? row?.codigo;
}

export function getRowLabel(row, fallback = 'Sin nombre') {
  return row?.nombre_predio ?? row?.nombre_raza ?? row?.nombre ?? row?.name ?? row?.codigo_qr ?? row?.codigo ?? row?.codigo_interno ?? row?.internal_code ?? fallback;
}
