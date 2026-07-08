const STORAGE_KEY = 'agx_ganaderia_demo_v1';

function generateId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function generateQrCodigo() {
  return `AGX-DEMO-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function seedDemoData() {
  const predioId = generateId('predio');
  const potreroId = generateId('potrero');
  const animalId1 = generateId('animal');
  const animalId2 = generateId('animal');

  return {
    predios: [{ id: predioId, nombre: 'Predio El Roble (demo)', ubicacion: 'Caquetá, Colombia' }],
    potreros: [{ id: potreroId, predioId, nombre: 'Potrero 1 (demo)', capacidad: 25 }],
    animales: [
      {
        id: animalId1,
        nombre: 'Lucero',
        especie: 'Bovino',
        sexo: 'Hembra',
        predioId,
        potreroId,
        marcaHierro: 'ER',
        numeroHierro: '014',
        qrCodigo: generateQrCodigo(),
        fechaRegistro: new Date().toISOString(),
      },
      {
        id: animalId2,
        nombre: 'Trueno',
        especie: 'Bovino',
        sexo: 'Macho',
        predioId,
        potreroId,
        marcaHierro: 'ER',
        numeroHierro: '015',
        qrCodigo: generateQrCodigo(),
        fechaRegistro: new Date().toISOString(),
      },
    ],
    pesajes: [{ id: generateId('pesaje'), animalId: animalId1, peso: 312, fecha: new Date().toISOString() }],
    vacunas: [{ id: generateId('vacuna'), animalId: animalId1, nombre: 'Aftosa (demo)', fecha: new Date().toISOString() }],
    tratamientos: [],
    reproduccion: [],
  };
}

export function loadDemoData() {
  if (typeof window === 'undefined') return seedDemoData();

  try {
    window.localStorage?.removeItem(STORAGE_KEY);
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const seeded = seedDemoData();
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
      return seeded;
    }
    return JSON.parse(raw);
  } catch {
    return seedDemoData();
  }
}

export function saveDemoData(data) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Almacenamiento no disponible: la demo continúa solo en memoria de la sesión.
  }
}

export function resetDemoData() {
  const seeded = seedDemoData();
  saveDemoData(seeded);
  return seeded;
}

export { generateId, generateQrCodigo };
