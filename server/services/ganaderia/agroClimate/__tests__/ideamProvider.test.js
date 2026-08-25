// SPRINT-3D7.1-AGROCLIMA: pruebas del proveedor IDEAM (hardening
// source-integrity: catálogo hp9r-jxuu separado de observaciones
// 57sv-p2fu) con fixtures locales -- fetchImpl inyectado, sin red real.
// Los campos de los fixtures son los campos REALES auditados de ambos
// datasets (ver cabecera de ideamProvider.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverNearbyIdeamStations,
  fetchIdeamObservation,
  selectIdeamStation,
  formatIdeamFloatingTimestamp,
  IdeamProviderError,
} from '../ideamProvider.js';

function fakeFetchJson(payload, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, json: async () => payload });
}

function routingFetch({ catalog, observationsByStation = {} }) {
  return async (url) => {
    const u = String(url);
    if (u.includes('hp9r-jxuu')) {
      return { ok: true, status: 200, json: async () => catalog };
    }
    if (u.includes('57sv-p2fu')) {
      const stationCode = decodeURIComponent(u).match(/codigoestacion='([^']+)'/)?.[1];
      const rows = observationsByStation[stationCode];
      if (rows === undefined) return { ok: true, status: 200, json: async () => [] };
      if (rows === 'ERROR') return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => rows };
    }
    throw new Error(`URL inesperada en test: ${u}`);
  };
}

test('discovery (catálogo hp9r-jxuu): ordena estaciones por distancia real (Haversine)', async () => {
  const catalog = [
    { codigo: 'FAR', nombre: 'Lejana', categoria: 'Pluviométrica', tecnologia: 'Convencional', estado: 'Activa', latitud: '5.0', longitud: '-74.3', departamento: 'X', municipio: 'Y' },
    { codigo: 'NEAR', nombre: 'Cercana', categoria: 'Climatológica Principal', tecnologia: 'Automática', estado: 'Activa', latitud: '4.61', longitud: '-74.11', departamento: 'X', municipio: 'Y' },
  ];
  const result = await discoverNearbyIdeamStations({ lat: 4.6, lng: -74.1, radiusKm: 100, fetchImpl: fakeFetchJson(catalog) });
  assert.equal(result[0].stationCode, 'NEAR');
  assert.ok(result[0].distanceKm < result[1].distanceKm);
  assert.equal(result[0].categoria, 'Climatológica Principal');
  assert.equal(result[0].estado, 'Activa');
});

test('discovery: descarta estaciones fuera del radio explícito', async () => {
  const catalog = [
    { codigo: 'FAR', nombre: 'Muy lejana', latitud: '10', longitud: '-80' },
  ];
  const result = await discoverNearbyIdeamStations({ lat: 4.6, lng: -74.1, radiusKm: 50, fetchImpl: fakeFetchJson(catalog) });
  assert.equal(result.length, 0);
});

test('discovery: lat/lng inválidos en filas del catálogo se descartan sin romper el resto', async () => {
  const catalog = [
    { codigo: 'BAD', nombre: 'Sin coords', latitud: 'nope', longitud: '-74.1' },
    { codigo: 'OK', nombre: 'Con coords', latitud: '4.6', longitud: '-74.1' },
  ];
  const result = await discoverNearbyIdeamStations({ lat: 4.6, lng: -74.1, fetchImpl: fakeFetchJson(catalog) });
  assert.equal(result.length, 1);
  assert.equal(result[0].stationCode, 'OK');
});

function makeReading(sensor, hoursAgo, value, now) {
  const utcInstant = new Date(now.getTime() - hoursAgo * 3600 * 1000);
  const localInstant = new Date(utcInstant.getTime() - 5 * 3600 * 1000);
  return { codigosensor: sensor, fechaobservacion: localInstant.toISOString().slice(0, 19), valorobservado: String(value) };
}

test('fetchIdeamObservation (57sv-p2fu): agrega precipitación (suma) y temp/RH/viento (media) en 24h', async () => {
  const now = new Date('2026-08-25T12:00:00-05:00');
  const rows = [];
  for (let h = 0; h < 24; h += 1) rows.push(makeReading('0240', h, 1, now));
  rows.push(makeReading('0068', 1, 22, now));
  rows.push(makeReading('0027', 1, 80, now));
  rows.push(makeReading('0103', 1, 4, now));

  const observation = await fetchIdeamObservation({ stationCode: 'X', now, fetchImpl: fakeFetchJson(rows) });

  assert.equal(observation.source, 'IDEAM');
  assert.equal(observation.quality, 'raw_observed');
  assert.ok(Math.abs(observation.precipitacion24hMm - 24) < 0.001);
  assert.equal(observation.temperaturaMediaC, 22);
  assert.equal(observation.humedadRelativaMediaPct, 80);
  assert.equal(observation.vientoMedioMs, 4);
  assert.equal(observation.metadata.provider, 'IDEAM_DATOS_ABIERTOS');
  assert.equal(observation.metadata.catalogDataset, 'hp9r-jxuu');
  assert.equal(observation.metadata.observationDataset, '57sv-p2fu');
  assert.ok(observation.metadata.variablesAvailable.includes('PRECIPITACION'));
});

test('estación sin lecturas recientes -> IdeamProviderError IDEAM_NO_DATA, no transitorio', async () => {
  await assert.rejects(
    () => fetchIdeamObservation({ stationCode: 'EMPTY', fetchImpl: fakeFetchJson([]) }),
    (error) => error instanceof IdeamProviderError && error.code === 'IDEAM_NO_DATA' && error.transient === false,
  );
});

test('respuesta no-array (malformada) -> error no transitorio', async () => {
  await assert.rejects(
    () => fetchIdeamObservation({ stationCode: 'X', fetchImpl: fakeFetchJson({ error: 'not an array' }) }),
    (error) => error.code === 'IDEAM_MALFORMED_RESPONSE',
  );
});

// ---------------------------------------------------------------------
// Semántica temporal (§9/§10 del hardening): fechaobservacion es
// calendar_date (Floating Timestamp) en Socrata -- literales de $where
// deben ir en la misma forma floating (sin Z/offset), nunca comparados
// como texto plano contra un ISO con zona.
// ---------------------------------------------------------------------

test('formatIdeamFloatingTimestamp: produce el formato floating_timestamp exacto (YYYY-MM-DDTHH:MM:SS.mmm, sin Z/offset)', () => {
  const formatted = formatIdeamFloatingTimestamp(new Date('2026-08-25T17:00:00.000Z'));
  assert.match(formatted, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/);
  assert.doesNotMatch(formatted, /[zZ]|[+-]\d{2}:\d{2}$/);
  // 17:00 UTC - 5h (asunción de dominio Colombia) = 12:00 local.
  assert.equal(formatted, '2026-08-25T12:00:00.000');
});

test('timestamp nativo: fetchIdeamObservation parsea fechaobservacion en la forma real del dataset (sin Z)', async () => {
  const now = new Date('2026-08-25T12:00:00-05:00');
  const rows = [{ codigosensor: '0068', fechaobservacion: '2026-08-25T11:30:00.000', valorobservado: '23' }];
  const observation = await fetchIdeamObservation({ stationCode: 'X', now, fetchImpl: fakeFetchJson(rows) });
  assert.equal(observation.temperaturaMediaC, 23);
});

test('límite de día (boundary exacto de 24h): una lectura justo en el borde se incluye (>=), consistente con el resto de ventanas', async () => {
  const now = new Date('2026-08-25T12:00:00-05:00');
  // Exactamente 24h atrás -- borde de la ventana.
  const boundaryRow = makeReading('0068', 24, 30, now);
  const observation = await fetchIdeamObservation({ stationCode: 'X', now, fetchImpl: fakeFetchJson([boundaryRow]) });
  assert.equal(observation.temperaturaMediaC, 30);
});

test('malformed date: una fila con fechaobservacion no parseable se ignora sin romper el resto', async () => {
  const now = new Date('2026-08-25T12:00:00-05:00');
  const rows = [
    { codigosensor: '0068', fechaobservacion: 'no-es-una-fecha', valorobservado: '99' },
    { codigosensor: '0068', fechaobservacion: '', valorobservado: '99' },
    makeReading('0068', 1, 20, now),
  ];
  const observation = await fetchIdeamObservation({ stationCode: 'X', now, fetchImpl: fakeFetchJson(rows) });
  assert.equal(observation.temperaturaMediaC, 20);
});

test('respuesta vacía (rows=[]) desde la fuente real de observaciones -> IDEAM_NO_DATA', async () => {
  await assert.rejects(
    () => fetchIdeamObservation({ stationCode: 'X', fetchImpl: fakeFetchJson([]) }),
    (error) => error.code === 'IDEAM_NO_DATA',
  );
});

test('timeout dispara IdeamProviderError', async () => {
  const slowFetch = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  await assert.rejects(
    () => fetchIdeamObservation({ stationCode: 'X', fetchImpl: slowFetch, timeoutMs: 10, retries: 0 }),
    (error) => error instanceof IdeamProviderError,
  );
});

// ---------------------------------------------------------------------
// selectIdeamStation: dos etapas, semántica explícita de outcome.
// ---------------------------------------------------------------------

test('selectIdeamStation: NO_STATION_NEARBY cuando el catálogo no tiene candidatas en el radio', async () => {
  const fetchImpl = routingFetch({ catalog: [] });
  const result = await selectIdeamStation({ lat: 1.25, lng: -75.88, fetchImpl });
  assert.equal(result.outcome, 'NO_STATION_NEARBY');
  assert.equal(result.candidatesFound, 0);
});

test('selectIdeamStation: STATION_FOUND_NO_RECENT_OBSERVATIONS cuando hay candidatas pero ninguna tiene lecturas', async () => {
  const catalog = [
    { codigo: 'A', nombre: 'Estación A', estado: 'Activa', latitud: '1.25', longitud: '-75.88' },
    { codigo: 'B', nombre: 'Estación B', estado: 'Activa', latitud: '1.3', longitud: '-75.9' },
  ];
  const fetchImpl = routingFetch({ catalog, observationsByStation: { A: [], B: [] } });
  const result = await selectIdeamStation({ lat: 1.25, lng: -75.88, fetchImpl });
  assert.equal(result.outcome, 'STATION_FOUND_NO_RECENT_OBSERVATIONS');
  assert.equal(result.candidatesFound, 2);
  assert.equal(result.candidatesProbed.length, 2);
  assert.equal(result.candidatesProbed[0].error.code, 'IDEAM_NO_DATA');
});

test('selectIdeamStation: STATION_FOUND -- primera candidata operativa con datos gana, aunque no sea la más cercana en bruto', async () => {
  const now = new Date('2026-08-25T12:00:00-05:00');
  const catalog = [
    { codigo: 'CLOSESTNODATA', nombre: 'Sin datos', estado: 'Activa', latitud: '1.25', longitud: '-75.88' },
    { codigo: 'FARTHERWITHDATA', nombre: 'Con datos', estado: 'Activa', latitud: '1.3', longitud: '-75.9' },
  ];
  const rows = [makeReading('0068', 1, 21, now)];
  const fetchImpl = routingFetch({ catalog, observationsByStation: { CLOSESTNODATA: [], FARTHERWITHDATA: rows } });
  const result = await selectIdeamStation({ lat: 1.25, lng: -75.88, now, fetchImpl });
  assert.equal(result.outcome, 'STATION_FOUND');
  assert.equal(result.station.stationCode, 'FARTHERWITHDATA');
  assert.equal(result.observation.temperaturaMediaC, 21);
  assert.equal(result.candidatesProbed.length, 1);
  assert.equal(result.candidatesProbed[0].stationCode, 'CLOSESTNODATA');
});

test('selectIdeamStation: candidatas "Suspendida" se prueban DESPUÉS de las operativas, nunca se excluyen de plano', async () => {
  const now = new Date('2026-08-25T12:00:00-05:00');
  const catalog = [
    { codigo: 'SUSPENDEDCLOSEST', nombre: 'Suspendida cercana', estado: 'Suspendida', latitud: '1.25', longitud: '-75.88' },
    { codigo: 'ACTIVEFARTHER', nombre: 'Activa más lejana', estado: 'Activa', latitud: '1.35', longitud: '-75.95' },
  ];
  const rows = [makeReading('0068', 1, 19, now)];
  // Ambas tienen datos -- debe ganar la ACTIVA aunque esté más lejos,
  // porque las operativas se prueban primero.
  const fetchImpl = routingFetch({ catalog, observationsByStation: { SUSPENDEDCLOSEST: rows, ACTIVEFARTHER: rows } });
  const result = await selectIdeamStation({ lat: 1.25, lng: -75.88, now, fetchImpl });
  assert.equal(result.outcome, 'STATION_FOUND');
  assert.equal(result.station.stationCode, 'ACTIVEFARTHER');
});

test('selectIdeamStation: si SOLO existen candidatas suspendidas, igual se prueban (nunca 0 opciones por exclusión ciega)', async () => {
  const now = new Date('2026-08-25T12:00:00-05:00');
  const catalog = [
    { codigo: 'ONLYSUSPENDED', nombre: 'Única, suspendida', estado: 'Suspendida', latitud: '1.25', longitud: '-75.88' },
  ];
  const rows = [makeReading('0068', 1, 19, now)];
  const fetchImpl = routingFetch({ catalog, observationsByStation: { ONLYSUSPENDED: rows } });
  const result = await selectIdeamStation({ lat: 1.25, lng: -75.88, now, fetchImpl });
  assert.equal(result.outcome, 'STATION_FOUND');
  assert.equal(result.station.stationCode, 'ONLYSUSPENDED');
});

test('selectIdeamStation: errores de red en una candidata no bloquean probar la siguiente', async () => {
  const now = new Date('2026-08-25T12:00:00-05:00');
  const catalog = [
    { codigo: 'FAILS', nombre: 'Falla de red', estado: 'Activa', latitud: '1.25', longitud: '-75.88' },
    { codigo: 'WORKS', nombre: 'Funciona', estado: 'Activa', latitud: '1.3', longitud: '-75.9' },
  ];
  const rows = [makeReading('0068', 1, 19, now)];
  const fetchImpl = routingFetch({ catalog, observationsByStation: { FAILS: 'ERROR', WORKS: rows } });
  const result = await selectIdeamStation({ lat: 1.25, lng: -75.88, now, fetchImpl, retries: 0 });
  assert.equal(result.outcome, 'STATION_FOUND');
  assert.equal(result.station.stationCode, 'WORKS');
  assert.equal(result.candidatesProbed[0].error.code, 'IDEAM_HTTP_ERROR');
});
