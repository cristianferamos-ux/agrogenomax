import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateMunicipalCoverageByPoint,
  getMunicipalCoverageByCode,
} from '../catastroxCoberturaMunicipal.js';

// Regresion: estimateMunicipalCoverageByPoint hardcodeaba
// departamento: 'Caqueta' como fallback fuera de los heuristicBounds
// conocidos (Albania, Florencia), lo que podia "ganarle" por error al
// territorio real de un predio identificado en otro departamento (ver
// defecto territorial de POST /lookup, coordenadas cerca de San Vicente
// del Caguán / La Macarena). Este archivo no depende de express/pg y
// corre de forma autocontenida.

const LAT_CASO_REAL = 2.274664;
const LNG_CASO_REAL = -74.699359;

test('B. fallback fuera de Albania/Florencia no inventa ningun campo territorial', () => {
  const coverage = estimateMunicipalCoverageByPoint(LAT_CASO_REAL, LNG_CASO_REAL);
  assert.equal(coverage.municipio, null);
  assert.equal(coverage.departamento, null, 'no debe hardcodear "Caqueta" fuera de los limites heuristicos conocidos');
  assert.equal(coverage.codigoMunicipio, null);
  assert.equal(coverage.gestorCatastral, null);
  assert.equal(coverage.estadoCobertura, 'PENDIENTE_VALIDACION');
});

test('B2. un punto dentro de Albania si conserva su cobertura conocida (sin regresion)', () => {
  const coverage = estimateMunicipalCoverageByPoint(1.30, -75.90);
  assert.equal(coverage.municipio, 'Albania');
  assert.equal(coverage.departamento, 'Caqueta');
  assert.equal(coverage.estadoCobertura, 'CUBIERTO_IGAC');
});

test('B3. getMunicipalCoverageByCode con codigos DANE ajenos a la tabla estatica devuelve null, no un valor inventado', () => {
  assert.equal(getMunicipalCoverageByCode('18753'), null); // San Vicente del Caguán
  assert.equal(getMunicipalCoverageByCode('50350'), null); // La Macarena
  assert.equal(getMunicipalCoverageByCode(''), null);
  assert.equal(getMunicipalCoverageByCode(null), null);
});

test('B4. codigos DANE conocidos siguen resolviendo su cobertura real (sin regresion)', () => {
  assert.equal(getMunicipalCoverageByCode('18029').municipio, 'Albania');
  assert.equal(getMunicipalCoverageByCode('18001').municipio, 'Florencia');
});
