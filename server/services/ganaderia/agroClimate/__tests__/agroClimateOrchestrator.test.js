// SPRINT-3D7.1-AGROCLIMA: pruebas del orquestador (hardening
// source-integrity) -- failure isolation, COMPLETE/PARTIAL/UNAVAILABLE,
// política de fusión, provenance honesta provider vs dataset en
// fuentes_json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshAgroClimateContext } from '../agroClimateOrchestrator.js';

const OPEN_METEO_HOST = 'archive-api.open-meteo.com';
const IDEAM_HOST = 'www.datos.gov.co';

function buildCoreHourly() {
  const time = [];
  const temperature_2m = [];
  const dew_point_2m = [];
  const soil_moisture_0_to_7cm = [];
  const soil_moisture_7_to_28cm = [];
  for (let i = 0; i < 24; i += 1) {
    time.push(`2026-08-24T${String(i).padStart(2, '0')}:00`);
    temperature_2m.push(22);
    dew_point_2m.push(16);
    soil_moisture_0_to_7cm.push(0.25);
    soil_moisture_7_to_28cm.push(0.22);
  }
  return { time, temperature_2m, dew_point_2m, soil_moisture_0_to_7cm, soil_moisture_7_to_28cm };
}

function buildSecondaryHourly() {
  const time = [];
  const precipitation = [];
  const shortwave_radiation = [];
  const wind_speed_10m = [];
  for (let i = 0; i < 24; i += 1) {
    time.push(`2026-08-24T${String(i).padStart(2, '0')}:00`);
    precipitation.push(0.5);
    shortwave_radiation.push(180);
    wind_speed_10m.push(2);
  }
  return { time, precipitation, shortwave_radiation, wind_speed_10m };
}

function buildIdeamCatalog() {
  return [{ codigo: 'S1', nombre: 'Estación 1', estado: 'Activa', categoria: 'Climatológica', tecnologia: 'Automática', latitud: '4.61', longitud: '-74.11' }];
}

function buildIdeamReadings(now) {
  const rows = [];
  for (let h = 0; h < 24; h += 1) {
    const ts = new Date(now.getTime() - h * 3600 * 1000 - 5 * 3600 * 1000).toISOString().slice(0, 19);
    rows.push({ codigosensor: '0240', fechaobservacion: ts, valorobservado: '1' });
    rows.push({ codigosensor: '0068', fechaobservacion: ts, valorobservado: '19' });
  }
  return rows;
}

function routingFetch({ coreOk = true, secondaryOk = true, ideamCatalogOk = true, ideamReadingsOk = true, now }) {
  return async (url) => {
    const u = String(url);
    if (u.includes(OPEN_METEO_HOST)) {
      const isCore = u.includes('models=era5_land');
      if (isCore) {
        if (!coreOk) return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ latitude: 4.6, longitude: -74.1, hourly: buildCoreHourly() }) };
      }
      if (!secondaryOk) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ latitude: 4.6, longitude: -74.1, hourly: buildSecondaryHourly() }) };
    }
    if (u.includes(IDEAM_HOST)) {
      const isCatalog = u.includes('hp9r-jxuu');
      if (isCatalog) {
        if (!ideamCatalogOk) return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => buildIdeamCatalog() };
      }
      if (!ideamReadingsOk) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => buildIdeamReadings(now) };
    }
    throw new Error(`URL inesperada en test: ${u}`);
  };
}

test('COMPLETE: ERA5-Land (núcleo+secundario) disponible -- fuentes_json distingue provider de dataset', async () => {
  const now = new Date('2026-08-25T12:00:00Z');
  const result = await refreshAgroClimateContext({ lat: 4.6, lng: -74.1, now, fetchImpl: routingFetch({ now }) });

  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.snapshot.fuentePrincipal, 'ERA5_LAND');
  assert.equal(result.snapshot.humedadSueloSuperficial, 0.25);
  assert.ok(Math.abs(result.snapshot.precipitacion24hMm - 12) < 0.01);

  const era5Entry = result.fuentesJson.find((f) => f.dataset === 'ERA5_LAND');
  assert.equal(era5Entry.status, 'OK');
  assert.equal(era5Entry.provider, 'OPEN_METEO');
  assert.equal(era5Entry.model, 'era5_land');
  assert.equal(era5Entry.secondaryDataset, 'ERA5');
  assert.equal(era5Entry.variableProvenance.precipitation, 'ERA5');

  const ideamEntry = result.fuentesJson.find((f) => f.dataset === 'IDEAM');
  assert.equal(ideamEntry.status, 'OK');
  assert.equal(ideamEntry.provider, 'IDEAM_DATOS_ABIERTOS');
  assert.equal(ideamEntry.catalogDataset, 'hp9r-jxuu');
  assert.equal(ideamEntry.observationDataset, '57sv-p2fu');
});

test('PARTIAL: ERA5-Land (núcleo) falla, IDEAM cubre precipitación/temperatura -- aislamiento de fallos', async () => {
  const now = new Date('2026-08-25T12:00:00Z');
  const result = await refreshAgroClimateContext({
    lat: 4.6, lng: -74.1, now, fetchImpl: routingFetch({ coreOk: false, now }),
  });

  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.snapshot.fuentePrincipal, 'IDEAM');
  assert.equal(result.snapshot.temperaturaMediaC, 19);
  assert.equal(result.snapshot.humedadSueloSuperficial, null);
  assert.equal(result.snapshot.radiacionSolar, null);
  const era5Entry = result.fuentesJson.find((f) => f.dataset === 'ERA5_LAND');
  assert.equal(era5Entry.status, 'FAILED');
});

test('COMPLETE con secundario parcial: núcleo ERA5-Land ok pero era5 (precip/radiación/viento) falla -- precipitación/viento caen a IDEAM (unidad compatible), radiación queda null (sin equivalente IDEAM), sigue COMPLETE', async () => {
  const now = new Date('2026-08-25T12:00:00Z');
  const result = await refreshAgroClimateContext({
    lat: 4.6, lng: -74.1, now, fetchImpl: routingFetch({ secondaryOk: false, now }),
  });

  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.snapshot.temperaturaMediaC, 22);
  // Precipitación cae a IDEAM (fixture: 1mm/hora * 24h) -- unidad
  // compatible, política de fusión explícita (ver cabecera del
  // orquestador). Radiación NO tiene equivalente IDEAM -- queda null.
  assert.ok(Math.abs(result.snapshot.precipitacion24hMm - 24) < 0.01);
  assert.equal(result.snapshot.radiacionSolar, null);
  const era5Entry = result.fuentesJson.find((f) => f.dataset === 'ERA5_LAND');
  assert.equal(era5Entry.secondaryModel, null);
  assert.equal(era5Entry.secondaryError.code, 'ERA5_LAND_HTTP_ERROR');
});

test('UNAVAILABLE: ambos proveedores fallan -- nunca datos inventados', async () => {
  const now = new Date('2026-08-25T12:00:00Z');
  const result = await refreshAgroClimateContext({
    lat: 4.6, lng: -74.1, now, fetchImpl: routingFetch({ coreOk: false, ideamCatalogOk: false, now }),
  });

  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.snapshot.fuentePrincipal, null);
  for (const field of ['precipitacion24hMm', 'temperaturaMediaC', 'humedadRelativaMediaPct', 'vientoMedioMs']) {
    assert.equal(result.snapshot[field], null, `${field} debía quedar null`);
  }
});

test('IDEAM sin candidatas en el catálogo -> fuentes_json.status = NO_STATION_NEARBY (semántica explícita)', async () => {
  const now = new Date('2026-08-25T12:00:00Z');
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes(OPEN_METEO_HOST)) {
      const isCore = u.includes('models=era5_land');
      return { ok: true, status: 200, json: async () => ({ latitude: 4.6, longitude: -74.1, hourly: isCore ? buildCoreHourly() : buildSecondaryHourly() }) };
    }
    if (u.includes('hp9r-jxuu')) return { ok: true, status: 200, json: async () => [] };
    throw new Error(`inesperado: ${u}`);
  };
  const result = await refreshAgroClimateContext({ lat: 4.6, lng: -74.1, now, fetchImpl });
  assert.equal(result.status, 'COMPLETE');
  const ideamEntry = result.fuentesJson.find((f) => f.dataset === 'IDEAM');
  assert.equal(ideamEntry.status, 'NO_STATION_NEARBY');
});

test('IDEAM con candidatas pero sin observaciones recientes -> STATION_FOUND_NO_RECENT_OBSERVATIONS', async () => {
  const now = new Date('2026-08-25T12:00:00Z');
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes(OPEN_METEO_HOST)) {
      const isCore = u.includes('models=era5_land');
      return { ok: true, status: 200, json: async () => ({ latitude: 4.6, longitude: -74.1, hourly: isCore ? buildCoreHourly() : buildSecondaryHourly() }) };
    }
    if (u.includes('hp9r-jxuu')) return { ok: true, status: 200, json: async () => buildIdeamCatalog() };
    if (u.includes('57sv-p2fu')) return { ok: true, status: 200, json: async () => [] };
    throw new Error(`inesperado: ${u}`);
  };
  const result = await refreshAgroClimateContext({ lat: 4.6, lng: -74.1, now, fetchImpl });
  const ideamEntry = result.fuentesJson.find((f) => f.dataset === 'IDEAM');
  assert.equal(ideamEntry.status, 'STATION_FOUND_NO_RECENT_OBSERVATIONS');
  assert.equal(ideamEntry.candidatesFound, 1);
});

test('ERA5-Land nunca se sobrescribe con IDEAM cuando ambos tienen el campo', async () => {
  const now = new Date('2026-08-25T12:00:00Z');
  const result = await refreshAgroClimateContext({ lat: 4.6, lng: -74.1, now, fetchImpl: routingFetch({ now }) });
  // ERA5 fixture: temp media 22°C; IDEAM fixture: 19°C -- debe ganar ERA5.
  assert.equal(result.snapshot.temperaturaMediaC, 22);
});
