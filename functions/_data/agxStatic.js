const animalRadamantis = {
  animal_id: '4',
  qr_id: '4',
  predio_id: '2',
  codigo_interno: '00003',
  nombre: 'RADAMANTIS',
  sexo: 'Macho',
  raza_principal: 'Angus',
  raza_secundaria: null,
  raza_terciaria: null,
  porcentaje_raza_1: '100.00',
  porcentaje_raza_2: null,
  porcentaje_raza_3: null,
  es_puro: true,
  fecha_nacimiento: '2025-03-12T05:00:00.000Z',
  peso_nacimiento: '50.00',
  color: 'Negro',
  numero_arete: '00003',
  padre_codigo: null,
  madre_codigo: null,
  estado: 'activo',
  observaciones: null,
  fecha_creacion: '2026-05-30T01:42:48.433Z',
};

const qrAgx000003 = {
  qr_id: '4',
  codigo_qr: 'AGX-000003',
  url_qr: null,
  estado: 'asignado',
  fecha_creacion: '2026-05-30T01:40:32.132Z',
};

const radamantisRazas = [
  {
    animal_raza_id: '5',
    animal_id: '4',
    raza_id: '6',
    porcentaje: '100.00',
    fecha_creacion: '2026-05-30T01:42:48.433Z',
    nombre_raza: 'Angus',
    aptitud: 'Carne',
    origen: 'Taurina',
  },
];

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      ...(init.headers || {}),
    },
  });
}

export function findQr(codigo) {
  return String(codigo || '').toUpperCase() === 'AGX-000003'
    ? { exists: true, assigned: true, qr: qrAgx000003, animal: animalRadamantis }
    : null;
}

export function findAnimal(id) {
  return String(id || '') === '4' ? animalRadamantis : null;
}

export function findAnimalRazas(id) {
  return String(id || '') === '4' ? radamantisRazas : null;
}
