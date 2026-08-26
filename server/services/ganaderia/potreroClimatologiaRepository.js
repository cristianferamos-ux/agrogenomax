// SPRINT-3D8-DESCANSO-REENTRADA (hardening territorial + operacional)
// §19/§20/§29 (+ hardening operacional final §1-§8): caché de
// climatología LOCAL histórica por potrero
// (agx.potrero_climatologias_agroclimaticas, fundación en
// 0008_potrero_descanso_reentrada.sql).
//
// Cada función existe en DOS variantes -- `*Core` (opera sobre un
// `client` YA ABIERTO, para componerse dentro de la MISMA transacción que
// el motor de descanso) y la pública (abre su propia transacción, para
// uso independiente/futuro, p.ej. un refresh manual expuesto por HTTP):
//   - fetchClimatologiaMasRecienteCore / getPotreroClimatologiaMasReciente:
//     LECTURA pura, nunca dispara una obtención en vivo.
//   - refreshPotreroClimatologiaCore / refreshPotreroClimatologia:
//     ESCRITURA -- obtiene series históricas reales
//     (era5HistoricalClimatologyProvider.js), calcula percentiles
//     mensuales (climatologyStatistics.js) y persiste una fila NUEVA
//     (append-only).
//
// HARDENING OPERACIONAL (cierre del bloqueo funcional, §1-§4): el motor
// de descanso (potreroDescansoRepository.js) ahora SÍ dispara
// `refreshPotreroClimatologiaCore` automáticamente cuando la caché no
// existe o quedó invalidada (`isClimatologyCacheValid`) -- dentro de la
// MISMA transacción de preview/create, reutilizando `client` (nunca abre
// una segunda transacción anidada).
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { fetchPotreroLocalClimatologySource } from './agroClimate/era5HistoricalClimatologyProvider.js';
import { buildMonthlyClimatology, computeTrailingSums } from './motorDescansoAuto/climatologyStatistics.js';

export const CLIMATOLOGY_METHOD_VERSION = 'climatology-v1';
// Debe coincidir con era5HistoricalClimatologyProvider.js
// WMO_CLIMATOLOGY_PERIOD -- duplicado aquí a propósito (sin import
// cruzado innecesario) SOLO para `isClimatologyCacheValid`; la fuente de
// verdad real del periodo sigue siendo el proveedor, que se la pasa a
// `fetchPotreroLocalClimatologySource` con su propio default.
export const CLIMATOLOGY_PERIOD = Object.freeze({ startYear: 1991, endYear: 2020 });

// HARDENING OPERACIONAL §8/§10: completitud MÍNIMA por variable -- una
// serie con demasiados años fallidos no debe convertirse en percentiles
// de baja confianza fabricados en silencio. Por debajo de este umbral, la
// variable se trata como NO DISPONIBLE para climatología (nunca se
// construye una distribución con muestra insuficiente).
export const MIN_COVERAGE_PCT = 0.7;

function computeCompleteness(serieOResultado) {
  if (!serieOResultado) return { expectedYears: 0, availableYears: 0, failedYears: 0, coveragePct: 0 };
  const expectedYears = serieOResultado.yearsRequested.length;
  const failedYears = serieOResultado.yearsFailed.length;
  const availableYears = expectedYears - failedYears;
  return {
    expectedYears,
    availableYears,
    failedYears,
    coveragePct: expectedYears > 0 ? availableYears / expectedYears : 0,
  };
}

function semanticError(code, status, message) {
  return Object.assign(new Error(message || code), { status, code });
}

/**
 * §4 del hardening operacional: validez de una fila de caché -- debe
 * corresponder al method_version y periodo climatológico VIGENTES. Un
 * cambio de metodología/periodo invalida la caché (el motor de descanso
 * genera una fila nueva, append-only -- la anterior queda intacta, nunca
 * se sobrescribe ni se borra).
 */
export function isClimatologyCacheValid(row, { methodVersion = CLIMATOLOGY_METHOD_VERSION, period = CLIMATOLOGY_PERIOD } = {}) {
  if (!row) return false;
  if (row.method_version !== methodVersion) return false;
  if (Number(row.period_start_year) !== period.startYear || Number(row.period_end_year) !== period.endYear) return false;
  return true;
}

/**
 * Última climatología ya calculada y persistida para este potrero (§20 del
 * hardening) -- lectura pura, nunca dispara una obtención en vivo. `null`
 * si el potrero todavía no tiene climatología (§4: `isClimatologyCacheValid`
 * decide si esta fila puede reutilizarse o si hace falta refrescar).
 */
export async function fetchClimatologiaMasRecienteCore(client, potreroId) {
  const result = await client.query(
    `select climatologia_id, period_start_year, period_end_year,
            soil_period_start_year, soil_period_end_year,
            dataset, provider, method_version, monthly_statistics_json, fuentes_json, created_at
       from agx.potrero_climatologias_agroclimaticas
      where potrero_id = $1
      order by created_at desc
      limit 1`,
    [potreroId],
  );
  return result.rows[0] ?? null;
}

export async function getPotreroClimatologiaMasReciente(organizacionId, potreroId) {
  return withOrganizacionTransaction(organizacionId, (client) => fetchClimatologiaMasRecienteCore(client, potreroId));
}

/**
 * Punto de la geometría del potrero, autoritativo server-side (mismo
 * criterio que agroClimateOrchestrator.js/0006 -- NUNCA coordenadas
 * aportadas por el cliente).
 */
async function fetchPotreroPoint(client, potreroId) {
  const result = await client.query(
    `select ST_Y(ST_PointOnSurface(geometry)) as lat, ST_X(ST_PointOnSurface(geometry)) as lng
       from agx.potreros
      where potrero_id = $1`,
    [potreroId],
  );
  if (result.rows.length === 0 || result.rows[0].lat === null) {
    throw semanticError('POTRERO_WITHOUT_GEOMETRY', 404, 'El potrero no tiene geometría registrada.');
  }
  return { lat: Number(result.rows[0].lat), lng: Number(result.rows[0].lng) };
}

/**
 * Refresca la climatología local de un potrero -- obtiene series
 * históricas reales, calcula percentiles mensuales y persiste una fila
 * NUEVA (append-only, nunca sobrescribe la anterior). §5/§6 del hardening
 * operacional: la obtención está acotada por lotes concurrentes +
 * presupuesto de tiempo (ver era5HistoricalClimatologyProvider.js) --
 * nunca queda colgada indefinidamente, aunque la cobertura resultante sea
 * parcial (§8: cobertura insuficiente para una variable -> esa variable
 * queda ausente, nunca un percentil fabricado).
 */
export async function refreshPotreroClimatologiaCore(client, organizacionId, predioId, potreroId, { fetchImpl } = {}) {
  const { lat, lng } = await fetchPotreroPoint(client, potreroId);

  const fuente = await fetchPotreroLocalClimatologySource({ lat, lng, fetchImpl });

  // §8/§10 del hardening operacional: completitud MÍNIMA por variable --
  // nunca se construye una distribución con muestra insuficiente
  // (`< MIN_COVERAGE_PCT` de los años solicitados).
  const completeness = {
    precipitacionDiariaMm: computeCompleteness(fuente.precipitacionDiariaMm),
    temperaturaMediaDiariaC: computeCompleteness(fuente.temperaturaMediaDiariaC),
    humedadSueloSuperficialDiaria: computeCompleteness(fuente.humedadSueloSuperficialDiaria),
    humedadSueloSubsuperficialDiaria: computeCompleteness(fuente.humedadSueloSubsuperficialDiaria),
  };

  function suficiente(nombre) {
    return completeness[nombre].coveragePct >= MIN_COVERAGE_PCT;
  }

  const monthlyStatistics = {};
  if (fuente.precipitacionDiariaMm && suficiente('precipitacionDiariaMm')) {
    const { dates, dailyValues } = fuente.precipitacionDiariaMm;
    monthlyStatistics.precipitacion7dMm = buildMonthlyClimatology(dates, computeTrailingSums(dailyValues, 7));
    monthlyStatistics.precipitacion15dMm = buildMonthlyClimatology(dates, computeTrailingSums(dailyValues, 15));
    monthlyStatistics.precipitacion30dMm = buildMonthlyClimatology(dates, computeTrailingSums(dailyValues, 30));
  }
  if (fuente.temperaturaMediaDiariaC && suficiente('temperaturaMediaDiariaC')) {
    monthlyStatistics.temperaturaMediaC = buildMonthlyClimatology(fuente.temperaturaMediaDiariaC.dates, fuente.temperaturaMediaDiariaC.dailyValues);
  }
  if (fuente.humedadSueloSuperficialDiaria && suficiente('humedadSueloSuperficialDiaria')) {
    monthlyStatistics.humedadSueloSuperficial = buildMonthlyClimatology(fuente.humedadSueloSuperficialDiaria.dates, fuente.humedadSueloSuperficialDiaria.dailyValues);
  }
  if (fuente.humedadSueloSubsuperficialDiaria && suficiente('humedadSueloSubsuperficialDiaria')) {
    monthlyStatistics.humedadSueloSubsuperficial = buildMonthlyClimatology(fuente.humedadSueloSubsuperficialDiaria.dates, fuente.humedadSueloSubsuperficialDiaria.dailyValues);
  }

  // HARDENING OPERACIONAL §5/§11 (test G): si NINGUNA variable alcanzó
  // cobertura suficiente (p.ej. proveedor histórico caído por completo),
  // NUNCA se persiste una fila "climatología" vacía -- eso quedaría
  // cacheada como válida para siempre (isClimatologyCacheValid solo mira
  // method_version/periodo, no si hay datos reales) y el motor de
  // descanso jamás reintentaría. Se lanza en su lugar, degradando
  // honestamente a "sin climatología" (mismo tratamiento que cualquier
  // otro fallo del proveedor en getOrGenerateClimatologia).
  if (Object.keys(monthlyStatistics).length === 0) {
    throw semanticError('INSUFFICIENT_LOCAL_CLIMATOLOGY', 422, 'Cobertura histórica insuficiente para calcular climatología local.');
  }

  const fuentesConCompletitud = fuente.metadata.fuentes.map((f) => ({ ...f, completeness: completeness[f.variable] }));

  const insertResult = await client.query(
    `insert into agx.potrero_climatologias_agroclimaticas
       (organizacion_id, predio_id, potrero_id, period_start_year, period_end_year,
        soil_period_start_year, soil_period_end_year, method_version, monthly_statistics_json, fuentes_json)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning climatologia_id, period_start_year, period_end_year,
               soil_period_start_year, soil_period_end_year,
               dataset, provider, method_version, monthly_statistics_json, fuentes_json, created_at`,
    [
      organizacionId,
      predioId,
      potreroId,
      fuente.metadata.climatologyPeriod.startYear,
      fuente.metadata.climatologyPeriod.endYear,
      // Misma columna que period_start/end_year -- §1 del hardening
      // operacional: humedad de suelo ya NO usa una ventana más corta.
      fuente.metadata.climatologyPeriod.startYear,
      fuente.metadata.climatologyPeriod.endYear,
      CLIMATOLOGY_METHOD_VERSION,
      JSON.stringify(monthlyStatistics),
      JSON.stringify(fuentesConCompletitud),
    ],
  );

  return insertResult.rows[0];
}

export async function refreshPotreroClimatologia(organizacionId, predioId, potreroId, opts = {}) {
  return withOrganizacionTransaction(organizacionId, (client) => refreshPotreroClimatologiaCore(client, organizacionId, predioId, potreroId, opts));
}
