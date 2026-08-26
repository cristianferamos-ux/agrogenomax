// SPRINT-3D8-DESCANSO-REENTRADA (hardening territorial): pruebas del
// proveedor de climatología histórica con fixtures locales -- fetchImpl
// inyectado, SIN red real (mismo patrón que era5LandProvider.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchHistoricalDailySeries,
  fetchPotreroLocalClimatologySource,
  Era5HistoricalClimatologyError,
} from '../era5HistoricalClimatologyProvider.js';

function buildHourlyYear(year, variable, valuePerHour) {
  const time = [];
  const values = [];
  const start = Date.UTC(year, 0, 1, 0, 0, 0);
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const hoursInYear = (isLeap ? 366 : 365) * 24;
  for (let i = 0; i < hoursInYear; i += 1) {
    time.push(new Date(start + i * 3600 * 1000).toISOString().slice(0, 16));
    values.push(typeof valuePerHour === 'function' ? valuePerHour(i) : valuePerHour);
  }
  return { hourly: { time, [variable]: values } };
}

test('particiona por año calendario -- cada año es una petición independiente', async () => {
  const urlsVistas = [];
  const fetchImpl = async (url) => {
    urlsVistas.push(String(url));
    const year = Number(String(url).match(/start_date=(\d{4})/)[1]);
    return { ok: true, status: 200, json: async () => buildHourlyYear(year, 'temperature_2m', 20) };
  };

  const result = await fetchHistoricalDailySeries({
    lat: 1.2, lng: -75.9, startYear: 2020, endYear: 2022, model: 'era5_land', variable: 'temperature_2m', method: 'mean', fetchImpl,
  });

  assert.equal(urlsVistas.length, 3);
  assert.deepEqual(result.yearsRequested, [2020, 2021, 2022]);
  assert.deepEqual(result.yearsFailed, []);
  // 2020 es bisiesto (366 días) + 2021 (365) + 2022 (365).
  assert.equal(result.dates.length, 366 + 365 + 365);
  assert.ok(result.dailyValues.every((v) => v === 20));
});

test('un año que falla se documenta en yearsFailed -- NUNCA invalida los años que sí respondieron', async () => {
  const fetchImpl = async (url) => {
    const year = Number(String(url).match(/start_date=(\d{4})/)[1]);
    if (year === 2021) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => buildHourlyYear(year, 'precipitation', 5) };
  };

  const result = await fetchHistoricalDailySeries({
    lat: 1.2, lng: -75.9, startYear: 2020, endYear: 2022, model: 'era5', variable: 'precipitation', method: 'sum', fetchImpl,
  });

  assert.equal(result.yearsFailed.length, 1);
  assert.equal(result.yearsFailed[0].year, 2021);
  assert.equal(result.dates.length, 366 + 365); // 2020 + 2022, sin 2021.
});

test('si TODOS los años fallan, lanza Era5HistoricalClimatologyError (nunca una climatología vacía silenciosa)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });

  await assert.rejects(
    () => fetchHistoricalDailySeries({
      lat: 1.2, lng: -75.9, startYear: 2020, endYear: 2021, model: 'era5', variable: 'precipitation', method: 'sum', fetchImpl,
    }),
    (error) => error instanceof Era5HistoricalClimatologyError && error.code === 'ERA5_HISTORICAL_NO_DATA',
  );
});

test('un día con menos de 24 horas reportadas se descarta -- nunca agrega un día parcial como completo', async () => {
  const time = ['2020-01-01T00:00', '2020-01-01T01:00', '2020-01-02T00:00'];
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ hourly: { time, temperature_2m: [10, 10, 20] } }),
  });

  const result = await fetchHistoricalDailySeries({
    lat: 1.2, lng: -75.9, startYear: 2020, endYear: 2020, model: 'era5_land', variable: 'temperature_2m', method: 'mean', fetchImpl,
  });

  const indiceDia1 = result.dates.indexOf('2020-01-01');
  assert.equal(result.dailyValues[indiceDia1], null, 'día 1 tiene solo 2 horas -- descartado');
});

test('fetchPotreroLocalClimatologySource: aísla el fallo de una variable, no invalida las demás', async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('soil_moisture_0_to_7cm')) return { ok: false, status: 503, json: async () => ({}) };
    const year = Number(u.match(/start_date=(\d{4})/)[1]);
    if (u.includes('precipitation')) return { ok: true, status: 200, json: async () => buildHourlyYear(year, 'precipitation', 2) };
    if (u.includes('temperature_2m') && u.includes('soil_moisture_7_to_28cm')) {
      // No debería ocurrir -- cada variable pide explícitamente la suya.
      throw new Error('unexpected combined request');
    }
    if (u.includes('temperature_2m')) return { ok: true, status: 200, json: async () => buildHourlyYear(year, 'temperature_2m', 25) };
    if (u.includes('soil_moisture_7_to_28cm')) return { ok: true, status: 200, json: async () => buildHourlyYear(year, 'soil_moisture_7_to_28cm', 0.3) };
    throw new Error(`URL inesperada: ${u}`);
  };

  const result = await fetchPotreroLocalClimatologySource({
    lat: 1.2, lng: -75.9,
    climatologyPeriod: { startYear: 2020, endYear: 2021 },
    now: new Date('2026-06-01T00:00:00Z'),
    fetchImpl,
  });

  assert.ok(result.precipitacionDiariaMm);
  assert.ok(result.temperaturaMediaDiariaC);
  assert.equal(result.humedadSueloSuperficialDiaria, null, 'variable fallida queda null, nunca lanza para las demás');
  assert.ok(result.humedadSueloSubsuperficialDiaria);
  assert.ok(result.metadata.fuentes.some((f) => f.variable === 'humedadSueloSuperficialDiaria' && f.disponible === false));
});

test('HARDENING OPERACIONAL §1: humedad de suelo usa el MISMO periodo climatológico que precipitación/temperatura -- nunca una ventana más corta sin evidencia', async () => {
  const anosSolicitadosPorVariable = { precipitation: new Set(), temperature_2m: new Set(), soil_moisture_0_to_7cm: new Set(), soil_moisture_7_to_28cm: new Set() };
  const fetchImpl = async (url) => {
    const u = String(url);
    const year = Number(u.match(/start_date=(\d{4})/)[1]);
    for (const variable of Object.keys(anosSolicitadosPorVariable)) {
      if (u.includes(variable)) anosSolicitadosPorVariable[variable].add(year);
    }
    return { ok: true, status: 200, json: async () => buildHourlyYear(year, u.includes('precipitation') ? 'precipitation' : (u.includes('temperature_2m') ? 'temperature_2m' : (u.includes('soil_moisture_0_to_7cm') ? 'soil_moisture_0_to_7cm' : 'soil_moisture_7_to_28cm')), 1) };
  };

  await fetchPotreroLocalClimatologySource({
    lat: 1.2, lng: -75.9,
    climatologyPeriod: { startYear: 1991, endYear: 1994 },
    now: new Date('2026-06-01T00:00:00Z'),
    fetchImpl,
  });

  const aniosEsperados = [1991, 1992, 1993, 1994];
  for (const variable of Object.keys(anosSolicitadosPorVariable)) {
    assert.deepEqual([...anosSolicitadosPorVariable[variable]].sort(), aniosEsperados, `${variable} debe pedir el mismo rango de años que las demás variables`);
  }
});

test('lat/lng inválidos rechazan de inmediato, sin llamar a fetchImpl', async () => {
  let llamado = false;
  const fetchImpl = async () => { llamado = true; return { ok: true, status: 200, json: async () => ({}) }; };

  await assert.rejects(
    () => fetchHistoricalDailySeries({
      lat: NaN, lng: -75.9, startYear: 2020, endYear: 2020, model: 'era5', variable: 'precipitation', method: 'sum', fetchImpl,
    }),
    (error) => error.code === 'ERA5_HISTORICAL_INVALID_POINT',
  );
  assert.equal(llamado, false);
});

// -----------------------------------------------------------------------
// HARDENING OPERACIONAL §5/§6/§11: lotes concurrentes + presupuesto de
// tiempo -- una petición real de 30 años NUNCA queda colgada
// indefinidamente (medido en vivo, ver cabecera del archivo).
// -----------------------------------------------------------------------

test('procesa los años en LOTES concurrentes (nunca más de `batchConcurrency` peticiones en vuelo a la vez)', async () => {
  let enVuelo = 0;
  let maxEnVuelo = 0;
  const fetchImpl = async (url) => {
    enVuelo += 1;
    maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
    const year = Number(String(url).match(/start_date=(\d{4})/)[1]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    enVuelo -= 1;
    return { ok: true, status: 200, json: async () => buildHourlyYear(year, 'temperature_2m', 20) };
  };

  const result = await fetchHistoricalDailySeries({
    lat: 1.2, lng: -75.9, startYear: 1991, endYear: 2010, model: 'era5_land', variable: 'temperature_2m', method: 'mean',
    fetchImpl, batchConcurrency: 4,
  });

  assert.equal(result.yearsRequested.length, 20);
  assert.equal(result.yearsFailed.length, 0);
  assert.ok(maxEnVuelo <= 4, `nunca más de 4 peticiones simultáneas, se observaron ${maxEnVuelo}`);
  assert.ok(maxEnVuelo > 1, 'debe paralelizar dentro de un lote, no una a la vez');
});

test('presupuesto de tiempo agotado: deja de iniciar lotes nuevos, documenta los años restantes como fallidos, NUNCA queda colgado indefinidamente', async () => {
  const fetchImpl = async (url) => {
    const year = Number(String(url).match(/start_date=(\d{4})/)[1]);
    await new Promise((resolve) => setTimeout(resolve, 30)); // cada petición "tarda" 30ms
    return { ok: true, status: 200, json: async () => buildHourlyYear(year, 'temperature_2m', 20) };
  };

  const inicio = Date.now();
  const result = await fetchHistoricalDailySeries({
    lat: 1.2, lng: -75.9, startYear: 1991, endYear: 2020, model: 'era5_land', variable: 'temperature_2m', method: 'mean',
    fetchImpl, batchConcurrency: 2, deadlineMs: 50, // 30 años, lotes de 2 -> el presupuesto se agota tras 1-2 lotes.
  });
  const duracionMs = Date.now() - inicio;

  assert.equal(result.yearsRequested.length, 30, 'yearsRequested SIEMPRE es el conjunto completo, incluso lo descartado por presupuesto');
  assert.ok(result.yearsFailed.length > 0, 'los años no alcanzados por el presupuesto quedan documentados como fallidos');
  assert.ok(result.yearsFailed.some((y) => y.code === 'ERA5_HISTORICAL_TIMEOUT_BUDGET_EXCEEDED'));
  // Nunca colgado indefinidamente -- el tiempo total es del orden del
  // presupuesto + un lote en vuelo, NUNCA 30 años x 30ms secuenciales (900ms).
  assert.ok(duracionMs < 500, `duración real ${duracionMs}ms debía quedar acotada por el presupuesto, nunca escalar con los 30 años`);
});
