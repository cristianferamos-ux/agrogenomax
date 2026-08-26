// SPRINT-3D8-DESCANSO-REENTRADA (hardening dinámico): orquestación del
// motor DINÁMICO de descanso y reentrada (agx.potrero_recomendaciones_descanso,
// fundación en 0008_potrero_descanso_reentrada.sql). Mismo principio de
// separación router/repositorio que potreroRecomendacionPastoreoRepository.js.
//
// §1 del hardening: PASTURE PHYSIOLOGICAL BASELINE + CURRENT/RECENT
// AGROCLIMATE CONDITIONS + GRAZING PRESSURE = DYNAMIC REST WINDOW. Este
// repositorio es el ÚNICO lugar donde esas piezas se ensamblan -- nunca
// devuelve el baseline de pastura tal cual (§2: "la literatura es
// guardrail, no respuesta final").
//
// Regla de fuente autoritativa: potrero, última ficha/recomendación de
// pastoreo guardada, contexto agroclimático más reciente y pastura
// identificada se resuelven SIEMPRE aquí -- el cliente solo aporta
// fechaInicioPastoreo.
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { computeRemnantDerivatives } from './motorPastoreoAuto/recomendacionPastoreoFormulas.js';
import { resolvePasturaDescansoBaseline } from './motorDescansoAuto/pasturaDescansoBaselineEngine.js';
import { assessAgroClimate, AGROCLIMATE_STATUS } from './motorDescansoAuto/agroClimateAssessment.js';
import { assessAgroClimateFreshness, AGROCLIMATE_FRESHNESS } from './motorDescansoAuto/agroClimateFreshness.js';
import { fetchClimatologiaMasRecienteCore, refreshPotreroClimatologiaCore, isClimatologyCacheValid } from './potreroClimatologiaRepository.js';
import {
  computeAjustePresionDias,
  computeRangoDescansoDias,
  computeFechaSalidaEstimada,
  computeFechasReingreso,
  resolveCondicionesReentrada,
  resolveNivelConfianzaDescanso,
} from './motorDescansoAuto/descansoFormulas.js';
import { ESTADO_DESCANSO, WINDOW_CONDITION } from './motorDescansoAuto/estadosDescanso.js';
import { MOTOR_VERSION } from './motorDescansoAuto/motorVersion.js';

const HISTORIAL_LIMIT = 10;
const MS_POR_DIA = 24 * 60 * 60 * 1000;
const FECHA_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function semanticError(code, status, message) {
  return Object.assign(new Error(message || code), { status, code });
}

function assertPredioIdFormat(predioId) {
  if (!/^\d+$/.test(String(predioId))) {
    throw semanticError('INVALID_PREDIO_ID', 400, 'predioId inválido.');
  }
}

function assertPotreroIdFormat(potreroId) {
  if (!/^\d+$/.test(String(potreroId))) {
    throw semanticError('INVALID_POTRERO_ID', 400, 'potreroId inválido.');
  }
}

async function assertPotreroBelongsToPredio(client, predioId, potreroId) {
  const result = await client.query(
    'select potrero_id from agx.potreros where potrero_id = $1 and predio_id = $2',
    [potreroId, predioId],
  );
  if (result.rows.length === 0) {
    throw semanticError('POTRERO_NOT_FOUND', 404, 'El potrero no existe, no pertenece a este predio o no pertenece a tu organización.');
  }
}

/**
 * Última recomendación de pastoreo guardada. Sin ninguna ->
 * NO_GRAZING_RECOMMENDATION, nunca un cálculo de descanso sin ella.
 */
async function fetchRecomendacionPastoreoMasReciente(client, potreroId) {
  const result = await client.query(
    `select recomendacion_id, ficha_id, contexto_id,
            materia_seca_total_kg, materia_seca_utilizable_kg,
            demanda_diaria_lote_kg_ms, dias_ocupacion_estimados, created_at
       from agx.potrero_recomendaciones_pastoreo
      where potrero_id = $1
      order by created_at desc
      limit 1`,
    [potreroId],
  );
  if (result.rows.length === 0) {
    throw semanticError(
      ESTADO_DESCANSO.NO_GRAZING_RECOMMENDATION,
      404,
      'Primero guarda una recomendación de pastoreo para este potrero.',
    );
  }
  return result.rows[0];
}

async function fetchFichaPorId(client, fichaId, potreroId) {
  const result = await client.query(
    `select ficha_id, biomasa_total_kg, tipo_cobertura,
            to_char(fecha_aforo, 'YYYY-MM-DD') as fecha_aforo, created_at
       from agx.potrero_fichas_productivas
      where ficha_id = $1 and potrero_id = $2`,
    [fichaId, potreroId],
  );
  if (result.rows.length === 0) {
    throw semanticError(
      ESTADO_DESCANSO.REST_UNAVAILABLE,
      500,
      'No fue posible recuperar la ficha productiva de la recomendación de pastoreo.',
    );
  }
  return result.rows[0];
}

/**
 * Nombres de la pastura dominante de la ficha (input del baseline
 * fisiológico de referencia). Si la ficha es una mezcla, no se prioriza
 * una sola especie.
 */
async function resolveNombresPastura(client, fichaRow) {
  if (fichaRow.tipo_cobertura === 'mezcla') {
    return { nombreComun: null, nombreCientifico: null };
  }
  const result = await client.query(
    `select cp.nombre_comun, cp.nombre_cientifico
       from agx.potrero_ficha_pasturas fp
       join agx.catalogo_pasturas cp on cp.pastura_id = fp.pastura_id
      where fp.ficha_id = $1
      order by fp.orden asc, fp.ficha_pastura_id asc
      limit 1`,
    [fichaRow.ficha_id],
  );
  if (result.rows.length === 0) {
    return { nombreComun: null, nombreCientifico: null };
  }
  return { nombreComun: result.rows[0].nombre_comun, nombreCientifico: result.rows[0].nombre_cientifico };
}

/**
 * Contexto agroclimático MÁS RECIENTE del potrero -- señal de clima fresca
 * al momento de calcular el descanso (puede ser posterior a la que usó la
 * recomendación de pastoreo guardada). Opcional -- sin contexto, el motor
 * sigue en modo degradado (nunca una excepción).
 */
async function fetchContextoMasReciente(client, potreroId) {
  const result = await client.query(
    `select contexto_id, precipitacion_7d_mm, precipitacion_15d_mm, precipitacion_30d_mm,
            temperatura_media_c, temperatura_max_c, humedad_relativa_media_pct,
            humedad_suelo_superficial, humedad_suelo_subsuperficial,
            radiacion_solar, source_observed_until, created_at, fuente_principal
       from agx.potrero_contextos_agroclimaticos
      where potrero_id = $1
      order by created_at desc
      limit 1`,
    [potreroId],
  );
  return result.rows[0] ?? null;
}

/**
 * HARDENING OPERACIONAL §1/§2/§3/§4: climatología LOCAL lista para usar --
 * reutiliza la caché válida si existe (`isClimatologyCacheValid`), o la
 * genera automáticamente AHORA MISMO (dentro de la MISMA transacción
 * tenant-safe ya abierta, nunca una segunda transacción anidada) si no
 * existe o quedó invalidada (method_version/periodo distintos). El
 * cliente NUNCA ejecuta un paso adicional (§1/§2: preview Y create se
 * autogeneran por igual, nunca asumen que el otro ya corrió).
 *
 * §5 del hardening: la obtención histórica está acotada por lotes
 * concurrentes + presupuesto de tiempo (ver
 * era5HistoricalClimatologyProvider.js) -- nunca cuelga indefinidamente.
 * Si el proveedor falla POR COMPLETO (p. ej. sin red), se degrada
 * honestamente a `null` -- el clasificador cae a
 * INSUFFICIENT_LOCAL_CLIMATOLOGY (guardrail auxiliar), nunca revienta el
 * cálculo de descanso completo por un fallo de climatología.
 */
async function getOrGenerateClimatologia(client, organizacionId, predioId, potreroId, { fetchImpl } = {}) {
  const cacheada = await fetchClimatologiaMasRecienteCore(client, potreroId);
  if (isClimatologyCacheValid(cacheada)) {
    return { row: cacheada, generated: false };
  }

  // HARDENING OPERACIONAL §7 (concurrencia): dos requests simultáneas para
  // el MISMO potrero sin caché podrían disparar dos generaciones
  // duplicadas. Mecanismo simple (sin infraestructura nueva): advisory
  // lock TRANSACCIONAL de Postgres, keyed por potrero_id (ya es único
  // globalmente) -- se libera solo al COMMIT/ROLLBACK de esta MISMA
  // transacción. La segunda transacción concurrente queda bloqueada aquí
  // hasta que la primera confirme, y entonces re-lee la caché (double-
  // check) -- si ya quedó válida, NUNCA vuelve a generar.
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [potreroId]);
  const cacheadaTrasLock = await fetchClimatologiaMasRecienteCore(client, potreroId);
  if (isClimatologyCacheValid(cacheadaTrasLock)) {
    return { row: cacheadaTrasLock, generated: false };
  }

  try {
    const generada = await refreshPotreroClimatologiaCore(client, organizacionId, predioId, potreroId, { fetchImpl });
    return { row: generada, generated: true };
  } catch {
    // Fallo del proveedor histórico (red, timeout total, etc.) -- degrada
    // a sin climatología, nunca lanza (§5: el cálculo de descanso sigue
    // funcionando en modo degradado, mismo criterio que "sin contexto
    // agroclimático" ya establecido en el hardening dinámico).
    return { row: null, generated: false };
  }
}

/**
 * Extrae los breakpoints P10/P25/P50/P75/P90 del MES ACTUAL para cada
 * variable de la climatología cacheada (§19/§6 del hardening territorial)
 * -- null si el potrero todavía no tiene climatología calculada (el
 * clasificador degrada honestamente a INSUFFICIENT_LOCAL_CLIMATOLOGY,
 * nunca inventa una distribución).
 */
function extractClimatologiaMensual(climatologiaRow, mes) {
  if (!climatologiaRow) return null;
  const stats = climatologiaRow.monthly_statistics_json || {};
  const pick = (variable) => stats?.[variable]?.[String(mes)] ?? null;
  return {
    precipitacion7dMm: pick('precipitacion7dMm'),
    precipitacion15dMm: pick('precipitacion15dMm'),
    precipitacion30dMm: pick('precipitacion30dMm'),
    temperaturaMediaC: pick('temperaturaMediaC'),
    humedadSueloSuperficial: pick('humedadSueloSuperficial'),
    humedadSueloSubsuperficial: pick('humedadSueloSubsuperficial'),
  };
}

/**
 * Descanso más reciente YA GUARDADO de este potrero (§19/§24 del
 * hardening) -- se usa como `previous_descanso_id` y para detectar si la
 * nueva estimación difiere de la anterior (REASSESSMENT_RECOMMENDED).
 */
async function fetchDescansoMasReciente(client, potreroId) {
  const result = await client.query(
    `select descanso_id, agroclimate_status,
            to_char(fecha_reingreso_recomendada, 'YYYY-MM-DD') as fecha_reingreso_recomendada,
            dias_descanso_recomendado
       from agx.potrero_recomendaciones_descanso
      where potrero_id = $1
      order by created_at desc
      limit 1`,
    [potreroId],
  );
  return result.rows[0] ?? null;
}

function edadEnDias(fecha) {
  const creado = new Date(fecha).getTime();
  if (!Number.isFinite(creado)) return null;
  return (Date.now() - creado) / MS_POR_DIA;
}

function num(valor) {
  return valor === null || valor === undefined ? null : Number(valor);
}

function validateFechaInicioPastoreo(rawValue) {
  if (typeof rawValue !== 'string' || !FECHA_ISO_PATTERN.test(rawValue)) {
    throw semanticError('INVALID_FECHA_INICIO_PASTOREO', 400, 'fechaInicioPastoreo debe tener formato YYYY-MM-DD.');
  }
  const [anio, mes, dia] = rawValue.split('-').map(Number);
  const timestamp = Date.UTC(anio, mes - 1, dia);
  const reconstruida = new Date(timestamp);
  const valido = reconstruida.getUTCFullYear() === anio
    && reconstruida.getUTCMonth() === mes - 1
    && reconstruida.getUTCDate() === dia;
  if (!valido) {
    throw semanticError('INVALID_FECHA_INICIO_PASTOREO', 400, 'fechaInicioPastoreo no es una fecha válida.');
  }
  return rawValue;
}

/**
 * Resuelve toda la trazabilidad + resultado DINÁMICO del motor de
 * descanso -- única fuente de verdad de cálculo, compartida entre preview
 * y create.
 */
async function resolveDescanso(client, { organizacionId, predioId, potreroId, fechaInicioPastoreo, climatologyFetchImpl }) {
  await assertPotreroBelongsToPredio(client, predioId, potreroId);
  validateFechaInicioPastoreo(fechaInicioPastoreo);

  const recomendacionRow = await fetchRecomendacionPastoreoMasReciente(client, potreroId);
  const fichaRow = await fetchFichaPorId(client, recomendacionRow.ficha_id, potreroId);
  const nombresPastura = await resolveNombresPastura(client, fichaRow);
  const contextoRow = await fetchContextoMasReciente(client, potreroId);
  const descansoAnteriorRow = await fetchDescansoMasReciente(client, potreroId);
  // HARDENING OPERACIONAL §1/§2: auto-genera la climatología local si no
  // existe o quedó invalidada -- el cliente NUNCA ejecuta un paso
  // adicional. Preview Y create se autogeneran por igual (nunca asumen
  // que el otro ya corrió antes).
  const { row: climatologiaRow, generated: climatologyGenerated } = await getOrGenerateClimatologia(client, organizacionId, predioId, potreroId, { fetchImpl: climatologyFetchImpl });

  // §4 del hardening: SIN perfil regional específico, el motor NUNCA
  // inventa un fallback -- bloquea con NO_PASTURE_PROFILE.
  const baseline = resolvePasturaDescansoBaseline(nombresPastura);
  if (!baseline) {
    throw semanticError(
      ESTADO_DESCANSO.NO_PASTURE_PROFILE,
      404,
      'Esta pastura todavía no tiene un perfil de descanso con evidencia técnica suficiente. AgroGenomaX prefiere no recomendar automáticamente antes que inventar un descanso genérico.',
    );
  }

  const materiaSecaTotalKg = Number(recomendacionRow.materia_seca_total_kg);
  const materiaSecaUtilizableKg = Number(recomendacionRow.materia_seca_utilizable_kg);
  const demandaDiariaLoteKgMs = Number(recomendacionRow.demanda_diaria_lote_kg_ms);
  const diasOcupacionEstimados = Number(recomendacionRow.dias_ocupacion_estimados);

  if (!Number.isFinite(diasOcupacionEstimados) || diasOcupacionEstimados < 0) {
    throw semanticError(
      ESTADO_DESCANSO.REST_UNAVAILABLE,
      500,
      'No fue posible completar el cálculo de descanso con los datos disponibles.',
    );
  }

  const remnant = computeRemnantDerivatives({
    materiaSecaTotalKg, materiaSecaUtilizableKg, demandaDiariaLoteKgMs, diasOcupacionEstimados,
  });

  // §17 del hardening: frescura EXPLÍCITA y SOURCE-AWARE -- prioriza
  // sourceObservedUntil (último dato real) sobre created_at, y usa la
  // ventana de la fuente real (ERA5_LAND/IDEAM), nunca una ventana ciega.
  const freshnessResult = assessAgroClimateFreshness({
    createdAt: contextoRow?.created_at ?? null,
    sourceObservedUntil: contextoRow?.source_observed_until ?? null,
    fuentePrincipal: contextoRow?.fuente_principal ?? null,
  });

  // §11 del hardening: clasificador agroclimático determinístico -- SIEMPRE
  // se ejecuta (incluso sin contexto/climatología, produce
  // INSUFFICIENT_DATA/INSUFFICIENT_LOCAL_CLIMATOLOGY de forma honesta en
  // vez de omitir el paso). climatologiaMensual: percentiles LOCALES del
  // mes actual (§1: la señal es relativa al lugar, nunca un umbral
  // absoluto universal) -- null si el potrero no tiene climatología aún
  // (degrada a guardrail auxiliar absoluto, ver agroClimateAssessment.js).
  const mesActual = new Date().getUTCMonth() + 1;
  const climatologiaMensual = extractClimatologiaMensual(climatologiaRow, mesActual);
  const assessment = assessAgroClimate({
    precipitacion7dMm: num(contextoRow?.precipitacion_7d_mm),
    precipitacion15dMm: num(contextoRow?.precipitacion_15d_mm),
    precipitacion30dMm: num(contextoRow?.precipitacion_30d_mm),
    temperaturaMediaC: num(contextoRow?.temperatura_media_c),
    temperaturaMaxC: num(contextoRow?.temperatura_max_c),
    humedadSueloSuperficial: num(contextoRow?.humedad_suelo_superficial),
    humedadSueloSubsuperficial: num(contextoRow?.humedad_suelo_subsuperficial),
    radiacionSolar: num(contextoRow?.radiacion_solar),
    humedadRelativaMediaPct: num(contextoRow?.humedad_relativa_media_pct),
    climatologiaMensual,
  });

  const ajustePresion = computeAjustePresionDias({
    remanenteProyectadoKg: remnant.remanenteProyectadoKg,
    remanenteObjetivoKg: remnant.remanenteObjetivoKg,
  });

  // §1/§14 del hardening: el baseline SIEMPRE atraviesa el ajuste dinámico
  // -- nunca se devuelve el baseline tal cual.
  const rango = computeRangoDescansoDias({
    baseline,
    agroClimateStatus: assessment.status,
    deltaPresionDias: ajustePresion.deltaDias,
  });

  const fechaSalidaEstimada = computeFechaSalidaEstimada(fechaInicioPastoreo, remnant.diasOcupacionRecomendados);
  const fechasReingreso = computeFechasReingreso(fechaSalidaEstimada, rango);

  // §22 del hardening: estado explícito -- STALE domina sobre PARTIAL (un
  // snapshot viejo es el problema más severo, tenga o no todos los campos).
  let estado = ESTADO_DESCANSO.READY;
  if (freshnessResult.freshness === AGROCLIMATE_FRESHNESS.NONE) {
    estado = ESTADO_DESCANSO.NO_AGROCLIMATE_CONTEXT;
  } else if (freshnessResult.freshness === AGROCLIMATE_FRESHNESS.STALE) {
    estado = ESTADO_DESCANSO.STALE_AGROCLIMATE_CONTEXT;
  } else if (assessment.status === AGROCLIMATE_STATUS.INSUFFICIENT_DATA) {
    estado = ESTADO_DESCANSO.PARTIAL_CONTEXT;
  }

  const recomendacionEdadDias = edadEnDias(recomendacionRow.created_at);
  const nivelConfianza = resolveNivelConfianzaDescanso({
    agroClimateFreshness: freshnessResult.freshness,
    agroClimateConfidenceImpact: assessment.confidenceImpact,
    recomendacionEdadDias,
    ajustePresionAplicado: ajustePresion.aplicado,
  });

  const condicionesReentrada = resolveCondicionesReentrada({ referenceEntryHeightCm: baseline.referenceEntryHeightCm });

  // §21/§28 del hardening: si ya existía una recomendación previa y la
  // nueva estimación difiere (fecha recomendada o clasificación
  // agroclimática), se marca REASSESSMENT_RECOMMENDED -- nunca se edita la
  // anterior, solo se señaliza el cambio.
  const windowConditions = [WINDOW_CONDITION.REENTRY_WINDOW_ESTIMATED];
  if (descansoAnteriorRow && (
    descansoAnteriorRow.fecha_reingreso_recomendada !== fechasReingreso.fechaReingresoRecomendada
    || descansoAnteriorRow.agroclimate_status !== assessment.status
  )) {
    windowConditions.push(WINDOW_CONDITION.REASSESSMENT_RECOMMENDED);
  }

  return {
    recomendacionRow,
    fichaRow,
    contextoRow,
    descansoAnteriorRow,
    baseline,
    assessment,
    freshnessResult,
    ajustePresion,
    rango,
    fechaSalidaEstimada,
    fechasReingreso,
    condicionesReentrada,
    nivelConfianza,
    estado,
    windowConditions,
    recomendacionEdadDias,
    diasOcupacionRecomendados: remnant.diasOcupacionRecomendados,
    climatologyGenerated,
  };
}

function buildParametrosFuenteJson({
  recomendacionRow, fichaRow, contextoRow, baseline, assessment, freshnessResult, ajustePresion, recomendacionEdadDias, climatologyGenerated,
}) {
  return {
    climatologyGenerated,
    pastura: {
      sourceType: baseline.sourceType,
      fuenteTecnica: baseline.fuenteTecnica,
      fuenteTecnicaAltura: baseline.fuenteTecnicaAltura ?? null,
      restDaysMinReference: baseline.restDaysMinReference,
      restDaysTypicalReference: baseline.restDaysTypicalReference,
      restDaysMaxReference: baseline.restDaysMaxReference,
      referenceEntryHeightCm: baseline.referenceEntryHeightCm,
      referenceExitHeightCm: baseline.referenceExitHeightCm,
      metadata: baseline.metadata,
    },
    agroClimate: {
      status: assessment.status,
      localClimatologyStatus: assessment.localClimatologyStatus,
      precipitationSignal: assessment.precipitationSignal,
      soilMoistureSignal: assessment.soilMoistureSignal,
      temperatureSignal: assessment.temperatureSignal,
      radiationSignal: assessment.radiationSignal,
      humiditySignal: assessment.humiditySignal,
      localAnomalies: assessment.localAnomalies,
      appliedRules: assessment.appliedRules,
      freshness: freshnessResult.freshness,
      freshnessEdadDias: freshnessResult.edadDias === null ? null : Math.round(freshnessResult.edadDias * 100) / 100,
    },
    ajustePresion: {
      deltaDias: ajustePresion.deltaDias,
      aplicado: ajustePresion.aplicado,
    },
    recomendacionPastoreoId: String(recomendacionRow.recomendacion_id),
    recomendacionPastoreoEdadDias: recomendacionEdadDias === null ? null : Math.round(recomendacionEdadDias * 100) / 100,
    fichaId: String(fichaRow.ficha_id),
    contextoId: contextoRow ? String(contextoRow.contexto_id) : null,
    motorVersion: MOTOR_VERSION,
  };
}

function buildResponsePayload({
  recomendacionRow, fichaRow, contextoRow, baseline, assessment, freshnessResult, rango, fechaSalidaEstimada,
  fechasReingreso, condicionesReentrada, nivelConfianza, estado, windowConditions, inputs, climatologyGenerated,
}) {
  return {
    estado,
    windowConditions,
    // HARDENING OPERACIONAL §9: true SOLO cuando este cálculo disparó la
    // generación de climatología (primera vez para este potrero, o caché
    // invalidada) -- el frontend lo usa para mostrar "Construyendo
    // referencia climática local..." en vez del copy genérico de carga.
    climatologyGenerated,
    motorVersion: MOTOR_VERSION,
    recomendacionPastoreoId: String(recomendacionRow.recomendacion_id),
    fichaId: String(fichaRow.ficha_id),
    contextoId: contextoRow ? String(contextoRow.contexto_id) : null,
    inputs: {
      fechaInicioPastoreo: inputs.fechaInicioPastoreo,
    },
    fechaSalidaEstimada,
    resultado: {
      diasDescansoMin: rango.diasDescansoMin,
      diasDescansoMax: rango.diasDescansoMax,
      diasDescansoRecomendado: rango.diasDescansoRecomendado,
      fechaReingresoMin: fechasReingreso.fechaReingresoMin,
      fechaReingresoMax: fechasReingreso.fechaReingresoMax,
      fechaReingresoRecomendada: fechasReingreso.fechaReingresoRecomendada,
    },
    condicionesReentrada,
    agroClimate: {
      status: assessment.status,
      localClimatologyStatus: assessment.localClimatologyStatus,
      precipitationSignal: assessment.precipitationSignal,
      soilMoistureSignal: assessment.soilMoistureSignal,
      temperatureSignal: assessment.temperatureSignal,
      radiationSignal: assessment.radiationSignal,
      humiditySignal: assessment.humiditySignal,
      localAnomalies: assessment.localAnomalies,
      appliedRules: assessment.appliedRules,
      freshness: freshnessResult.freshness,
    },
    provenance: {
      pasturaSourceType: baseline.sourceType,
      pasturaFuenteTecnica: baseline.fuenteTecnica,
      pasturaFuenteTecnicaAltura: baseline.fuenteTecnicaAltura ?? null,
      pasturaMetadata: baseline.metadata,
    },
    nivelConfianza,
  };
}

/**
 * Preview: calcula server-side, NUNCA persiste.
 */
// `{ climatologyFetchImpl }` -- SOLO para tests (inyecta un fetchImpl
// determinístico para era5HistoricalClimatologyProvider.js, mismo patrón
// que potreroClimatologiaRepositoryIntegration.test.js). La ruta HTTP
// pública NUNCA pasa este parámetro -- en producción siempre usa el
// `fetch` real por defecto del proveedor.
export async function previewDescansoReentrada(organizacionId, predioId, potreroId, params, { climatologyFetchImpl } = {}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const resolved = await resolveDescanso(client, { organizacionId, predioId, potreroId, ...params, climatologyFetchImpl });
    return buildResponsePayload({ ...resolved, inputs: params });
  });
}

function serializeDescansoRow(row) {
  return {
    descansoId: String(row.descanso_id),
    previousDescansoId: row.previous_descanso_id === null ? null : String(row.previous_descanso_id),
    recomendacionPastoreoId: String(row.recomendacion_pastoreo_id),
    fichaId: String(row.ficha_id),
    contextoId: row.contexto_id === null ? null : String(row.contexto_id),
    fechaInicioPastoreo: row.fecha_inicio_pastoreo,
    fechaSalidaEstimada: row.fecha_salida_estimada,
    diasDescansoMin: Number(row.dias_descanso_min),
    diasDescansoMax: Number(row.dias_descanso_max),
    diasDescansoRecomendado: Number(row.dias_descanso_recomendado),
    fechaReingresoMin: row.fecha_reingreso_min,
    fechaReingresoMax: row.fecha_reingreso_max,
    fechaReingresoRecomendada: row.fecha_reingreso_recomendada,
    nivelConfianza: row.nivel_confianza,
    agroclimateStatus: row.agroclimate_status,
    condicionesReentrada: row.condiciones_reentrada_json,
    appliedRules: row.applied_rules_json,
    parametrosFuente: row.parametros_fuente_json,
    motorVersion: row.motor_version,
    createdAt: row.created_at,
  };
}

/**
 * Create: recalcula server-side (SIEMPRE con las condiciones actuales) y
 * persiste una fila NUEVA, histórica -- nunca edita una recomendación de
 * descanso previa (§19 del hardening: recalcular es crear una fila nueva).
 */
export async function createDescansoReentrada(organizacionId, predioId, potreroId, params, { climatologyFetchImpl } = {}) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const resolved = await resolveDescanso(client, { organizacionId, predioId, potreroId, ...params, climatologyFetchImpl });
    const {
      recomendacionRow, fichaRow, contextoRow, descansoAnteriorRow, baseline, assessment, freshnessResult,
      ajustePresion, rango, fechaSalidaEstimada, fechasReingreso, condicionesReentrada, nivelConfianza,
      recomendacionEdadDias, climatologyGenerated,
    } = resolved;

    const parametrosFuenteJson = buildParametrosFuenteJson({
      recomendacionRow, fichaRow, contextoRow, baseline, assessment, freshnessResult, ajustePresion, recomendacionEdadDias, climatologyGenerated,
    });

    const insertResult = await client.query(
      `insert into agx.potrero_recomendaciones_descanso
         (organizacion_id, predio_id, potrero_id, ficha_id, contexto_id, recomendacion_pastoreo_id, previous_descanso_id,
          fecha_inicio_pastoreo, fecha_salida_estimada,
          dias_descanso_min, dias_descanso_max, dias_descanso_recomendado,
          fecha_reingreso_min, fecha_reingreso_max, fecha_reingreso_recomendada,
          nivel_confianza, agroclimate_status, condiciones_reentrada_json, applied_rules_json,
          parametros_fuente_json, motor_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       returning descanso_id, previous_descanso_id, recomendacion_pastoreo_id, ficha_id, contexto_id,
                 to_char(fecha_inicio_pastoreo, 'YYYY-MM-DD') as fecha_inicio_pastoreo,
                 to_char(fecha_salida_estimada, 'YYYY-MM-DD') as fecha_salida_estimada,
                 dias_descanso_min, dias_descanso_max, dias_descanso_recomendado,
                 to_char(fecha_reingreso_min, 'YYYY-MM-DD') as fecha_reingreso_min,
                 to_char(fecha_reingreso_max, 'YYYY-MM-DD') as fecha_reingreso_max,
                 to_char(fecha_reingreso_recomendada, 'YYYY-MM-DD') as fecha_reingreso_recomendada,
                 nivel_confianza, agroclimate_status, condiciones_reentrada_json, applied_rules_json,
                 parametros_fuente_json, motor_version, created_at`,
      [
        organizacionId,
        predioId,
        potreroId,
        fichaRow.ficha_id,
        contextoRow ? contextoRow.contexto_id : null,
        recomendacionRow.recomendacion_id,
        descansoAnteriorRow ? descansoAnteriorRow.descanso_id : null,
        params.fechaInicioPastoreo,
        fechaSalidaEstimada,
        rango.diasDescansoMin,
        rango.diasDescansoMax,
        rango.diasDescansoRecomendado,
        fechasReingreso.fechaReingresoMin,
        fechasReingreso.fechaReingresoMax,
        fechasReingreso.fechaReingresoRecomendada,
        nivelConfianza,
        assessment.status,
        JSON.stringify(condicionesReentrada),
        JSON.stringify(assessment.appliedRules),
        JSON.stringify(parametrosFuenteJson),
        MOTOR_VERSION,
      ],
    );

    return serializeDescansoRow(insertResult.rows[0]);
  });
}

/**
 * Recomendación de descanso más reciente + historial resumido de un
 * potrero. Devuelve { actual: null, historial: [] } si el potrero todavía
 * no tiene ninguna recomendación de descanso registrada -- nunca 404 (el
 * potrero sí existe).
 */
export async function getDescansoReentradaByPotrero(organizacionId, predioId, potreroId) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    await assertPotreroBelongsToPredio(client, predioId, potreroId);

    const result = await client.query(
      `select descanso_id, previous_descanso_id, recomendacion_pastoreo_id, ficha_id, contexto_id,
              to_char(fecha_inicio_pastoreo, 'YYYY-MM-DD') as fecha_inicio_pastoreo,
              to_char(fecha_salida_estimada, 'YYYY-MM-DD') as fecha_salida_estimada,
              dias_descanso_min, dias_descanso_max, dias_descanso_recomendado,
              to_char(fecha_reingreso_min, 'YYYY-MM-DD') as fecha_reingreso_min,
              to_char(fecha_reingreso_max, 'YYYY-MM-DD') as fecha_reingreso_max,
              to_char(fecha_reingreso_recomendada, 'YYYY-MM-DD') as fecha_reingreso_recomendada,
              nivel_confianza, agroclimate_status, condiciones_reentrada_json, applied_rules_json,
              parametros_fuente_json, motor_version, created_at
         from agx.potrero_recomendaciones_descanso
        where potrero_id = $1
        order by created_at desc
        limit $2`,
      [potreroId, HISTORIAL_LIMIT + 1],
    );

    if (result.rows.length === 0) {
      return { actual: null, historial: [] };
    }

    const [actualRow, ...historialRows] = result.rows;
    return {
      actual: serializeDescansoRow(actualRow),
      historial: historialRows.map(serializeDescansoRow),
    };
  });
}
