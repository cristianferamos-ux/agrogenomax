import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCleanLookupTerritoryFields,
  buildCleanLookupTerritoryProjection,
  findMunicipioByDaneCode,
  resolveCleanPredioTerritory,
} from '../catastrox.js';

// Los tests B/B2 (fallback de cobertura fuera de heuristicBounds) viven en
// server/data/__tests__/catastroxCoberturaMunicipal.test.js: ese modulo no
// depende de express/pg y puede ejecutarse de forma autocontenida en
// cualquier entorno, a diferencia de este archivo.

// Regresion para el defecto territorial de POST /lookup: un predio clean
// identificado cerca de un limite municipal podia mostrar el municipio de
// una capa administrativa independiente (gis.municipios_colombia por
// punto) en vez del territorio real del predio catastral encontrado.
// Todos los codigos, coordenadas y nombres usados aqui son sinteticos
// salvo el caso E, que reproduce el caso real reportado (coordenadas y
// codigo_predial ya conocidos como problematicos, sin datos adicionales
// del predio).

const SAN_VICENTE_DANE = '18753';
const LA_MACARENA_DANE = '50350';
const CODIGO_PREDIAL_CANONICO = '187530001000000680024000000000'; // 30 digitos, prefijo 18753
const LAT_CASO_REAL = 2.274664;
const LNG_CASO_REAL = -74.699359;

function sanVicenteRow() {
  return { mpcodigo: SAN_VICENTE_DANE, mpnombre: 'San Vicente del Caguán', depto: 'Caquetá', gestor: 'IGAC' };
}
function laMacarenaRow() {
  return { mpcodigo: LA_MACARENA_DANE, mpnombre: 'La Macarena', depto: 'Meta', gestor: 'IGAC' };
}

// Mock de queryImpl: distingue la consulta por codigo DANE exacto
// (findMunicipioByDaneCode, "where mpcodigo = $1") de las dos consultas
// por punto que usa findMunicipioByPoint ("ST_Covers"/"order by ... <->").
function createMockQuery({ byDaneCode = () => ({ rows: [] }), byPointDirect = () => ({ rows: [] }), byPointNearest = () => ({ rows: [] }) } = {}) {
  return async (sql, params) => {
    if (sql.includes('where mpcodigo = $1')) return byDaneCode(params);
    if (sql.includes('ST_Covers(gis.municipios_colombia.geom')) return byPointDirect(params);
    if (sql.includes('order by gis.municipios_colombia.geom <->')) return byPointNearest(params);
    throw new Error(`Query no reconocida por el mock: ${sql.slice(0, 60)}...`);
  };
}

test('A. predio cerca de un limite: el codigo DANE del codigo_predial prevalece sobre el municipio por punto', async () => {
  const cleanPredio = { codigo_predial: CODIGO_PREDIAL_CANONICO, zona: 'rural', fid: 'FID-SINTETICO-A' };

  // El mock de punto (ST_Covers) simula exactamente el caso reportado:
  // devuelve La Macarena/Meta, un municipio distinto al del predio.
  const queryImpl = createMockQuery({
    byDaneCode: (params) => (params[0] === SAN_VICENTE_DANE ? { rows: [sanVicenteRow()] } : { rows: [] }),
    byPointDirect: () => ({ rows: [laMacarenaRow()] }),
  });

  const territorio = await resolveCleanPredioTerritory(cleanPredio, LNG_CASO_REAL, LAT_CASO_REAL, queryImpl);

  assert.equal(territorio.municipio, 'San Vicente del Caguán');
  assert.equal(territorio.departamento, 'Caquetá');
  assert.notEqual(territorio.municipio, 'La Macarena');
  assert.notEqual(territorio.departamento, 'Meta');

  const campos = buildCleanLookupTerritoryFields(territorio);
  assert.equal(campos.municipio, 'San Vicente del Caguán');
  assert.equal(campos.departamento, 'Caquetá');
});

test('C1. codigo_predial no canonico: findMunicipioByDaneCode no consulta nada y devuelve null', async () => {
  let queryCalled = false;
  const queryImpl = async () => {
    queryCalled = true;
    return { rows: [] };
  };

  const resultado = await findMunicipioByDaneCode('12345', queryImpl);
  assert.equal(resultado, null);
  assert.equal(queryCalled, false, 'un codigo no canonico no debe generar ninguna consulta SQL');
});

test('C2. codigo_predial no canonico: resolveCleanPredioTerritory conserva el fallback existente por punto', async () => {
  const cleanPredio = { codigo_predial: '12345', zona: 'urbano', fid: 'FID-SINTETICO-C' };
  const queryImpl = createMockQuery({
    byPointDirect: () => ({ rows: [laMacarenaRow()] }),
  });

  const territorio = await resolveCleanPredioTerritory(cleanPredio, LNG_CASO_REAL, LAT_CASO_REAL, queryImpl);
  assert.equal(territorio.municipio, 'La Macarena');
  assert.equal(territorio.departamento, 'Meta');
});

test('C3. codigo DANE canonico pero sin fila en gis.municipios_colombia: cae al fallback por punto', async () => {
  const cleanPredio = { codigo_predial: CODIGO_PREDIAL_CANONICO, zona: 'rural', fid: 'FID-SINTETICO-C3' };
  const queryImpl = createMockQuery({
    byDaneCode: () => ({ rows: [] }), // el codigo DANE no resuelve ninguna fila
    byPointDirect: () => ({ rows: [laMacarenaRow()] }),
  });

  const territorio = await resolveCleanPredioTerritory(cleanPredio, LNG_CASO_REAL, LAT_CASO_REAL, queryImpl);
  assert.equal(territorio.municipio, 'La Macarena', 'sin fila DANE, debe usar el resultado del fallback por punto');
});

test('C4. codigo_predial con espacios exteriores se normaliza antes de validar (sin aceptar separadores internos)', async () => {
  const queryImpl = createMockQuery({
    byDaneCode: (params) => (params[0] === SAN_VICENTE_DANE ? { rows: [sanVicenteRow()] } : { rows: [] }),
  });

  // Espacios EXTERIORES: debe recortarse y tratarse como canonico.
  const conEspaciosExteriores = await findMunicipioByDaneCode(`  ${CODIGO_PREDIAL_CANONICO}  `, queryImpl);
  assert.ok(conEspaciosExteriores, 'un codigo con espacios solo exteriores debe resolver como canonico');
  assert.equal(conEspaciosExteriores.municipio, 'San Vicente del Caguán');

  // Separadores INTERNOS (espacio o guion) siguen siendo invalidos.
  const conEspacioInterno = await findMunicipioByDaneCode('18753 0001000000680024000000000', queryImpl);
  assert.equal(conEspacioInterno, null, 'un separador interno no debe normalizarse a canonico');

  const conGuionInterno = await findMunicipioByDaneCode('18753-0001000000680024000000000', queryImpl);
  assert.equal(conGuionInterno, null, 'un guion interno no debe normalizarse a canonico');

  // Letras y longitud distinta de 30 digitos siguen siendo invalidas.
  const conLetras = await findMunicipioByDaneCode('18753A001000000680024000000000', queryImpl);
  assert.equal(conLetras, null);

  const longitudDistinta = await findMunicipioByDaneCode('1875300010000006800240000000001', queryImpl); // 31 digitos
  assert.equal(longitudDistinta, null);
});

test('D. buildCleanLookupTerritoryProjection (funcion productiva real) produce top-level, predio y coverage consistentes', async () => {
  const cleanPredio = { codigo_predial: CODIGO_PREDIAL_CANONICO, zona: 'rural', fid: 'FID-SINTETICO-D' };
  const queryImpl = createMockQuery({
    byDaneCode: (params) => (params[0] === SAN_VICENTE_DANE ? { rows: [sanVicenteRow()] } : { rows: [] }),
    byPointDirect: () => ({ rows: [laMacarenaRow()] }),
  });

  const territorio = await resolveCleanPredioTerritory(cleanPredio, LNG_CASO_REAL, LAT_CASO_REAL, queryImpl);

  // Se invoca la MISMA funcion que router.post('/lookup') usa para llenar
  // los 9 campos territoriales de la respuesta (catastrox.js, rama
  // cleanPredio) -- no se reconstruye nada manualmente aqui.
  const projection = buildCleanLookupTerritoryProjection(territorio);

  assert.equal(projection.municipio, 'San Vicente del Caguán');
  assert.equal(projection.departamento, 'Caquetá');
  assert.equal(projection.gestor, 'IGAC');

  assert.deepEqual(projection.predio, {
    municipio: 'San Vicente del Caguán',
    departamento: 'Caquetá',
    gestor: 'IGAC',
  });
  assert.deepEqual(projection.coverage, {
    municipio: 'San Vicente del Caguán',
    departamento: 'Caquetá',
    gestorCatastral: 'IGAC',
  });

  // Ningun destino debe apartarse del top-level (mismas claves, valores
  // equivalentes salvo el nombre gestor/gestorCatastral que usa cada rama
  // de la respuesta real).
  assert.equal(projection.predio.municipio, projection.municipio);
  assert.equal(projection.predio.departamento, projection.departamento);
  assert.equal(projection.coverage.municipio, projection.municipio);
  assert.equal(projection.coverage.departamento, projection.departamento);
  assert.equal(projection.coverage.gestorCatastral, projection.gestor);
});

test('E. caso exacto reportado: lat=2.274664, lng=-74.699359, codigo_predial 187530001000000680024000000000 -> San Vicente del Caguán / Caquetá', async () => {
  const cleanPredio = { codigo_predial: CODIGO_PREDIAL_CANONICO, zona: 'rural', fid: 'FID-CASO-REAL' };
  const queryImpl = createMockQuery({
    byDaneCode: (params) => (params[0] === '18753' ? { rows: [sanVicenteRow()] } : { rows: [] }),
    byPointDirect: () => ({ rows: [laMacarenaRow()] }), // el sintoma observado en produccion
  });

  const territorio = await resolveCleanPredioTerritory(cleanPredio, LNG_CASO_REAL, LAT_CASO_REAL, queryImpl);
  assert.equal(territorio.municipio, 'San Vicente del Caguán');
  assert.equal(territorio.departamento, 'Caquetá');
});

test('F. la resolucion territorial nunca modifica fid, codigo_predial ni zona del predio', async () => {
  const cleanPredio = { codigo_predial: CODIGO_PREDIAL_CANONICO, zona: 'rural', fid: 'FID-INTACTO' };
  const snapshot = JSON.stringify(cleanPredio);

  const queryImpl = createMockQuery({
    byDaneCode: () => ({ rows: [sanVicenteRow()] }),
    byPointDirect: () => ({ rows: [laMacarenaRow()] }),
  });

  await resolveCleanPredioTerritory(cleanPredio, LNG_CASO_REAL, LAT_CASO_REAL, queryImpl);

  assert.equal(JSON.stringify(cleanPredio), snapshot, 'cleanPredio (fid, codigo_predial, zona) no debe mutarse');
});
