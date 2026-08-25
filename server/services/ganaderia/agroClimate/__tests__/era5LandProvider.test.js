// SPRINT-3D7.1-AGROCLIMA: pruebas del proveedor ERA5-Land (hardening
// source-integrity) con fixtures locales -- fetchImpl inyectado, sin red
// real. Cubre: modelo explícito era5_land/era5 (nunca best_match/default),
// composición núcleo+secundario, provenance por variable, aislamiento de
// fallo del secundario, timeout/retry/HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchEra5LandObservation, Era5LandProviderError } from '../era5LandProvider.js';

function buildCoreHourly({ hours, temp = 20, dew = 15, soil1 = 0.3, soil2 = 0.28 }) {
  const time = [];
  const temperature_2m = [];
  const dew_point_2m = [];
  const soil_moisture_0_to_7cm = [];
  const soil_moisture_7_to_28cm = [];
  const base = Date.UTC(2026, 6, 1, 0, 0, 0);
  for (let i = 0; i < hours; i += 1) {
    time.push(new Date(base + i * 3600 * 1000).toISOString().slice(0, 16));
    temperature_2m.push(temp);
    dew_point_2m.push(dew);
    soil_moisture_0_to_7cm.push(soil1);
    soil_moisture_7_to_28cm.push(soil2);
  }
  return { time, temperature_2m, dew_point_2m, soil_moisture_0_to_7cm, soil_moisture_7_to_28cm };
}

function buildSecondaryHourly({ hours, precip = 0.5, radiation = 200, wind = 3 }) {
  const time = [];
  const precipitation = [];
  const shortwave_radiation = [];
  const wind_speed_10m = [];
  const base = Date.UTC(2026, 6, 1, 0, 0, 0);
  for (let i = 0; i < hours; i += 1) {
    time.push(new Date(base + i * 3600 * 1000).toISOString().slice(0, 16));
    precipitation.push(precip);
    shortwave_radiation.push(radiation);
    wind_speed_10m.push(wind);
  }
  return { time, precipitation, shortwave_radiation, wind_speed_10m };
}

function routingFetch({ coreHourly, secondaryHourly, coreOk = true, secondaryOk = true, coreStatus = 503, secondaryStatus = 503 }) {
  return async (url) => {
    const u = String(url);
    const isCore = u.includes('models=era5_land');
    const isSecondary = u.includes('models=era5') && !isCore;
    if (isCore) {
      if (!coreOk) return { ok: false, status: coreStatus, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ latitude: 1.2000046, longitude: -75.9, hourly: coreHourly }) };
    }
    if (isSecondary) {
      if (!secondaryOk) return { ok: false, status: secondaryStatus, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ latitude: 1.25, longitude: -76, hourly: secondaryHourly }) };
    }
    throw new Error(`URL inesperada en test (sin models=era5_land/era5): ${u}`);
  };
}

test('cada petición fija el modelo EXPLÍCITAMENTE -- nunca best_match/default', async () => {
  const seenUrls = [];
  const fetchImpl = async (url) => {
    seenUrls.push(String(url));
    const isCore = String(url).includes('models=era5_land');
    return {
      ok: true, status: 200,
      json: async () => (isCore
        ? { latitude: 1.2, longitude: -75.9, hourly: buildCoreHourly({ hours: 24 }) }
        : { latitude: 1.25, longitude: -76, hourly: buildSecondaryHourly({ hours: 24 }) }),
    };
  };
  await fetchEra5LandObservation({ lat: 1.25, lng: -75.88, fetchImpl });
  assert.equal(seenUrls.length, 2);
  assert.ok(seenUrls.some((u) => u.includes('models=era5_land')));
  assert.ok(seenUrls.some((u) => /models=era5(?!_)/.test(u)));
  for (const u of seenUrls) assert.doesNotMatch(u, /models=best_match/);
});

test('composición núcleo(era5_land)+secundario(era5): variableProvenance distingue cada variable', async () => {
  const fetchImpl = routingFetch({
    coreHourly: buildCoreHourly({ hours: 24 }),
    secondaryHourly: buildSecondaryHourly({ hours: 24, precip: 1 }),
  });
  const observation = await fetchEra5LandObservation({ lat: 1.25, lng: -75.88, fetchImpl });

  assert.equal(observation.metadata.provider, 'OPEN_METEO');
  assert.equal(observation.metadata.dataset, 'ERA5_LAND');
  assert.equal(observation.metadata.model, 'era5_land');
  assert.equal(observation.metadata.secondaryModel, 'era5');
  assert.equal(observation.metadata.secondaryDataset, 'ERA5');
  assert.equal(observation.metadata.variableProvenance.temperature_2m, 'ERA5_LAND');
  assert.equal(observation.metadata.variableProvenance.precipitation, 'ERA5');
  assert.equal(observation.metadata.variableProvenance.wind_speed_10m, 'ERA5');
  assert.ok(Math.abs(observation.precipitacion24hMm - 24) < 0.001);
  assert.ok(Math.abs(observation.temperaturaMediaC - 20) < 0.001);
  // Grid del núcleo (0.1°) distinto del grid del secundario (0.25°) --
  // confirma que son dos peticiones/datasets realmente distintos.
  assert.equal(observation.metadata.coreResolutionDeg, 0.1);
  assert.equal(observation.metadata.secondaryResolutionDeg, 0.25);
  assert.notEqual(observation.metadata.coreGridLat, observation.metadata.secondaryGridLat);
});

test('fallo del secundario (era5) NO invalida el núcleo -- precipitación/radiación/viento quedan null, temperatura sigue disponible', async () => {
  const fetchImpl = routingFetch({
    coreHourly: buildCoreHourly({ hours: 24 }),
    secondaryHourly: null,
    secondaryOk: false,
    secondaryStatus: 503,
  });
  const observation = await fetchEra5LandObservation({ lat: 1.25, lng: -75.88, fetchImpl, retries: 0 });

  assert.equal(observation.temperaturaMediaC, 20);
  assert.equal(observation.precipitacion24hMm, null);
  assert.equal(observation.radiacionSolar, null);
  assert.equal(observation.vientoMedioMs, null);
  assert.equal(observation.metadata.secondaryModel, null);
  assert.equal(observation.metadata.secondaryError.code, 'ERA5_LAND_HTTP_ERROR');
  assert.equal(observation.metadata.variableProvenance.precipitation, null);
});

test('fallo del núcleo (era5_land) SÍ invalida toda la observación', async () => {
  const fetchImpl = routingFetch({ coreHourly: null, coreOk: false, coreStatus: 503, secondaryHourly: buildSecondaryHourly({ hours: 24 }) });
  await assert.rejects(
    () => fetchEra5LandObservation({ lat: 1.25, lng: -75.88, fetchImpl, retries: 0 }),
    (error) => error instanceof Era5LandProviderError && error.code === 'ERA5_LAND_HTTP_ERROR',
  );
});

test('rezago: observedUntil del núcleo es el último timestamp con dato real, no "ahora"', async () => {
  const coreHourly = buildCoreHourly({ hours: 24 * 10 });
  for (let i = coreHourly.temperature_2m.length - 120; i < coreHourly.temperature_2m.length; i += 1) {
    coreHourly.temperature_2m[i] = null;
  }
  const fetchImpl = routingFetch({ coreHourly, secondaryHourly: buildSecondaryHourly({ hours: 24 * 10 }) });
  const observation = await fetchEra5LandObservation({ lat: 1.25, lng: -75.88, fetchImpl });
  const expectedLastIndex = coreHourly.temperature_2m.length - 121;
  assert.equal(observation.observedUntil, coreHourly.time[expectedLastIndex]);
  assert.equal(observation.metadata.coreObservedUntil, coreHourly.time[expectedLastIndex]);
});

test('timeout del núcleo dispara Era5LandProviderError', async () => {
  const slowFetch = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  await assert.rejects(
    () => fetchEra5LandObservation({ lat: 1.25, lng: -75.88, fetchImpl: slowFetch, timeoutMs: 10, retries: 0 }),
    (error) => error instanceof Era5LandProviderError,
  );
});

test('respuesta malformada del núcleo (sin hourly): error no transitorio', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('models=era5_land')) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ hourly: buildSecondaryHourly({ hours: 24 }) }) };
  };
  await assert.rejects(
    () => fetchEra5LandObservation({ lat: 1, lng: 2, fetchImpl }),
    (error) => error instanceof Era5LandProviderError && error.code === 'ERA5_LAND_MALFORMED_RESPONSE' && error.transient === false,
  );
});

test('HTTP 5xx del núcleo es transitorio, HTTP 4xx no lo es', async () => {
  const fetch500 = routingFetch({ coreHourly: null, coreOk: false, coreStatus: 503, secondaryHourly: buildSecondaryHourly({ hours: 24 }) });
  const fetch400 = routingFetch({ coreHourly: null, coreOk: false, coreStatus: 400, secondaryHourly: buildSecondaryHourly({ hours: 24 }) });

  await assert.rejects(
    () => fetchEra5LandObservation({ lat: 1, lng: 2, fetchImpl: fetch500, retries: 0 }),
    (error) => error.transient === true,
  );
  await assert.rejects(
    () => fetchEra5LandObservation({ lat: 1, lng: 2, fetchImpl: fetch400, retries: 2 }),
    (error) => error.transient === false,
  );
});

test('reintento: un primer fallo transitorio del núcleo se recupera en el segundo intento', async () => {
  let coreCalls = 0;
  const coreHourly = buildCoreHourly({ hours: 24 });
  const secondaryHourly = buildSecondaryHourly({ hours: 24 });
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('models=era5_land')) {
      coreCalls += 1;
      if (coreCalls === 1) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ hourly: coreHourly }) };
    }
    return { ok: true, status: 200, json: async () => ({ hourly: secondaryHourly }) };
  };
  const observation = await fetchEra5LandObservation({ lat: 1, lng: 2, fetchImpl, retries: 1, retryDelayMs: 1 });
  assert.equal(coreCalls, 2);
  assert.equal(observation.source, 'ERA5_LAND');
});

test('lat/lng inválidos rechazados antes de llamar a fetch', async () => {
  let called = false;
  await assert.rejects(
    () => fetchEra5LandObservation({ lat: NaN, lng: -74, fetchImpl: async () => { called = true; } }),
    (error) => error.code === 'ERA5_LAND_INVALID_POINT',
  );
  assert.equal(called, false);
});
