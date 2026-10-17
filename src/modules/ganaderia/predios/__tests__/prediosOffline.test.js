// SPRINT-3D11.3 (R1) -- "Mis predios" offline: abrir, listar y consultar
// predios (y sus potreros) sin red usando la copia IndexedDB (adaptador en
// memoria con el mismo contrato), más invariantes de la página.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cargarPrediosLocalFirst } from '../prediosLocalFirst.js';
import { createMemoryStorage } from '../../offline/storage.js';
import { ORG_STORES } from '../../offline/offlineSchema.js';
import { createLocalRepo } from '../../offline/localRepo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE = fs.readFileSync(path.resolve(__dirname, '..', 'PrediosPage.jsx'), 'utf8').replace(/\r\n/g, '\n');
const ORG = '55555555-5555-4555-8555-555555555555';

// Formato EXACTO de GET /api/ganaderia/predios (serializePredioListItem),
// que es también el que entrega el PULL de sincronización.
const PREDIO_ACTIVO = {
  predioId: '7', nombrePredio: 'La Esperanza', departamento: 'Caquetá', municipio: 'Florencia', vereda: 'El Caraño',
  areaDeclaradaHa: 120.5, observaciones: null, codigoPredial: '180010001000000010001000000000', latitud: 1.6, longitud: -75.6,
  tieneGeometria: true, fechaCreacion: '2026-09-01T10:00:00.000Z', estado: 'ACTIVO',
};
const PREDIO_ARCHIVADO = { ...PREDIO_ACTIVO, predioId: '8', nombrePredio: 'Lote viejo', estado: 'ARCHIVADO', fechaCreacion: '2026-08-01T10:00:00.000Z' };

async function repoPreparado() {
  const repo = createLocalRepo(createMemoryStorage(ORG_STORES), { organizacionId: ORG, deviceId: 'd' });
  await repo.aplicarPull({
    organizacionId: ORG, cursor: 'c', completo: true, animales: [], chapetas: [], razas: [], categorias: [],
    predios: [PREDIO_ACTIVO, PREDIO_ARCHIVADO],
    potreros: [
      { potreroId: '70', predioId: '7', nombre: 'Potrero Norte', estado: 'ACTIVO', areaHa: 12 },
      { potreroId: '71', predioId: '7', nombre: 'Potrero viejo', estado: 'ARCHIVADO', areaHa: 3 },
      { potreroId: '80', predioId: '8', nombre: 'Otro', estado: 'ACTIVO', areaHa: 1 },
    ],
  });
  await repo.putMeta({ preparadoAt: new Date().toISOString() });
  return repo;
}

const sinRed = () => {
  throw new Error('no debe consultar la red');
};

test('sin red: Mis predios lista desde IndexedDB sin llamar al servidor (activos por defecto)', async () => {
  const repo = await repoPreparado();
  const pintados = [];
  const { predios, origen } = await cargarPrediosLocalFirst({
    local: repo, online: false, incluirArchivados: false, fetchRemote: sinRed, onLocal: (lista) => pintados.push(lista),
  });
  assert.equal(origen, 'local');
  assert.deepEqual(predios.map((p) => p.predioId), ['7']);
  assert.equal(pintados.length, 1, 'pinta la copia local de inmediato');
});

test('sin red: "Ver archivados" funciona con la copia local (mismo opt-in que el servidor)', async () => {
  const repo = await repoPreparado();
  const { predios } = await cargarPrediosLocalFirst({ local: repo, online: false, incluirArchivados: true, fetchRemote: sinRed });
  assert.deepEqual(predios.map((p) => p.predioId).sort(), ['7', '8']);
});

test('consulta sin red: la tarjeta tiene todos los campos que pinta (mismo formato que la API)', async () => {
  const repo = await repoPreparado();
  const [predio] = await repo.listPredios();
  for (const campo of ['nombrePredio', 'departamento', 'municipio', 'vereda', 'areaDeclaradaHa', 'codigoPredial', 'tieneGeometria', 'estado']) {
    assert.deepEqual(predio[campo], PREDIO_ACTIVO[campo], campo);
  }
});

test('consulta sin red: potreros del predio desde la copia local, solo de ese predio', async () => {
  const repo = await repoPreparado();
  const potreros = await repo.listPotreros('7');
  assert.deepEqual(potreros.map((p) => p.potreroId).sort(), ['70', '71']);
  assert.ok(PAGE.includes("setPotreros(lista.filter((p) => p.estado !== 'ARCHIVADO'))"), 'la vista oculta potreros archivados');
});

test('con red: refresca desde el servidor; si el servidor falla, se queda con la copia local (sin error)', async () => {
  const repo = await repoPreparado();
  const remoto = [{ ...PREDIO_ACTIVO, nombrePredio: 'La Esperanza (servidor)' }];
  const ok = await cargarPrediosLocalFirst({ local: repo, online: true, incluirArchivados: false, fetchRemote: async () => remoto });
  assert.equal(ok.origen, 'servidor');
  assert.equal(ok.predios[0].nombrePredio, 'La Esperanza (servidor)');
  const caido = await cargarPrediosLocalFirst({ local: repo, online: true, incluirArchivados: false, fetchRemote: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(caido.origen, 'local');
  assert.equal(caido.predios.length, 1);
});

test('dispositivo NO preparado: comportamiento en línea de siempre (sin copia local el error se muestra)', async () => {
  await assert.rejects(cargarPrediosLocalFirst({ local: null, online: false, incluirArchivados: false, fetchRemote: async () => { throw new TypeError('x'); } }));
  const { origen } = await cargarPrediosLocalFirst({ local: null, online: true, incluirArchivados: false, fetchRemote: async () => [PREDIO_ACTIVO] });
  assert.equal(origen, 'servidor');
});

test('página: sin red no ofrece escrituras ni mapa satelital; usa la copia local para listar y para potreros', () => {
  assert.match(PAGE, /const localRepo = offline\.preparado && offline\.repo \? offline\.repo : null;/);
  assert.match(PAGE, /const sinConexion = !offline\.online;/);
  assert.match(PAGE, /local: localRepo,\s*online: !sinConexion,/);
  assert.match(PAGE, /\{predio\.tieneGeometria && sinConexion \? \(\s*<div className="gan-predio-map-empty">Mapa disponible con conexión\.<\/div>/);
  assert.match(PAGE, /\{!sinConexion \? \(\s*<button type="button" className="gan-secondary-button" onClick=\{toggleRegistrar\}/);
  assert.match(PAGE, /\{sinConexion \? null : !archivado \? \(/);
  assert.match(PAGE, /\{activePanel === 'ver' && sinConexion \? <PotrerosLocales localRepo=\{localRepo\} predioId=\{predio\.predioId\} \/> : null\}/);
  assert.match(PAGE, /\{activePanel === 'registrar' && !sinConexion \? \(/);
  assert.match(PAGE, /La búsqueda en CatastroX y el registro de predios necesitan Internet\./);
});
