// SPRINT-3D7.2-RECOMENDACION-PASTOREO-AUTO: orquestación del motor
// automático de recomendación de pastoreo (agx.potrero_recomendaciones_pastoreo,
// fundación en 0007_potrero_recomendacion_pastoreo.sql). Mismo principio de
// separación router/repositorio que potreroCapacidadPastoreoRepository.js
// (3D7, "Modo técnico") -- de hecho reutiliza sus mismas fórmulas físicas
// vía recomendacionPastoreoFormulas.js.
//
// Regla de dominio: ORGANIZACIÓN -> PREDIO -> POTRERO -> FICHA PRODUCTIVA
// (+ CONTEXTO AGROCLIMÁTICO opcional) -> CATEGORÍA PRODUCTIVA ->
// RECOMENDACIÓN. Regla de historial: cada POST create crea una fila NUEVA
// -- nunca actualiza una recomendación existente.
//
// Regla de fuente autoritativa (§7/§17 del sprint): biomasa fresca,
// materia_seca_pct_aplicada, utilizacion_pct_aplicada,
// consumo_pct_pv_aplicado y TODOS los resultados calculados se resuelven
// SIEMPRE aquí (ficha real + categoría del catálogo + motor pastura/clima)
// -- el cliente solo aporta categoriaCodigo, numeroAnimales,
// pesoPromedioKg y los campos condicionales de la categoría elegida.
//
// HARDENING RONDA 3: vacas en producción usan la ecuación real NRC (2001)
// de DMI (peso + litros/día + días en leche) en vez de un coeficiente
// inventado -- ver computeDemandaIndividualLecheNrc2001. Ternero al pie ya
// NO suma una constante fija -- degrada confianza y expone una limitación
// explícita (sin evidencia suficiente para cuantificarlo en v1). El peso
// promedio ahora se valida contra el rango de referencia de la categoría
// (antes decorativo) -- necesario para que el %PV equivalente derivado de
// la ecuación NRC nunca exceda el guardrail técnico de la tabla.
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { fetchCategoriaByCodigo } from './categoriaProductivaRepository.js';
import { resolvePastureClimateParams } from './motorPastoreoAuto/pastureClimateEngine.js';
import {
  computeRecomendacionPastoreo,
  computeRemnantDerivatives,
  resolveNivelConfianza,
} from './motorPastoreoAuto/recomendacionPastoreoFormulas.js';
import { ESTADO_RECOMENDACION } from './motorPastoreoAuto/estadosRecomendacion.js';
import { MOTOR_VERSION } from './motorPastoreoAuto/motorVersion.js';

const HISTORIAL_LIMIT = 10;
const MS_POR_DIA = 24 * 60 * 60 * 1000;

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
  return result.rows[0];
}

/**
 * Ficha productiva más reciente (§17 del sprint: snapshot autoritativo).
 * Sin ficha -> INSUFFICIENT_FORAGE_DATA (§18), nunca un cálculo con
 * biomasa asumida.
 */
async function fetchFichaMasReciente(client, potreroId) {
  const result = await client.query(
    `select ficha_id, biomasa_total_kg, tipo_cobertura,
            to_char(fecha_aforo, 'YYYY-MM-DD') as fecha_aforo, created_at
       from agx.potrero_fichas_productivas
      where potrero_id = $1
      order by created_at desc
      limit 1`,
    [potreroId],
  );
  if (result.rows.length === 0) {
    throw semanticError(
      ESTADO_RECOMENDACION.INSUFFICIENT_FORAGE_DATA,
      404,
      'Primero registra una ficha productiva con un aforo del potrero.',
    );
  }
  return result.rows[0];
}

/**
 * Tipo botánico dominante de la ficha (§8 del sprint: input del motor
 * pastura+clima). Si la ficha es una mezcla (tipo_cobertura = 'mezcla'),
 * se usa 'mezcla' directamente -- no se prioriza una sola especie. En
 * caso contrario, se resuelve el tipo de la única especie registrada.
 */
async function resolveTipoPasturaBotanico(client, fichaRow) {
  if (fichaRow.tipo_cobertura === 'mezcla') {
    // Mezcla de especies -- no se prioriza una sola, así que tampoco hay
    // nombre único para intentar un match PASTURE_SPECIFIC_BASELINE.
    return { tipo: 'mezcla', nombreComun: null, nombreCientifico: null };
  }
  const result = await client.query(
    `select cp.tipo, cp.nombre_comun, cp.nombre_cientifico
       from agx.potrero_ficha_pasturas fp
       join agx.catalogo_pasturas cp on cp.pastura_id = fp.pastura_id
      where fp.ficha_id = $1
      order by fp.orden asc, fp.ficha_pastura_id asc
      limit 1`,
    [fichaRow.ficha_id],
  );
  if (result.rows.length === 0) {
    return { tipo: 'otra', nombreComun: null, nombreCientifico: null };
  }
  return {
    tipo: result.rows[0].tipo,
    nombreComun: result.rows[0].nombre_comun,
    nombreCientifico: result.rows[0].nombre_cientifico,
  };
}

/**
 * Contexto agroclimático más reciente (§17 del sprint: opcional -- sin
 * contexto, el motor sigue funcionando en modo degradado con menor
 * confianza, nunca una excepción fatal, §18).
 */
async function fetchContextoMasReciente(client, potreroId) {
  const result = await client.query(
    `select contexto_id, precipitacion_7d_mm, created_at
       from agx.potrero_contextos_agroclimaticos
      where potrero_id = $1
      order by created_at desc
      limit 1`,
    [potreroId],
  );
  return result.rows[0] ?? null;
}

function fichaEdadEnDias(fichaRow) {
  const creado = new Date(fichaRow.created_at).getTime();
  if (!Number.isFinite(creado)) return null;
  return (Date.now() - creado) / MS_POR_DIA;
}

function serializeFichaRef(fichaRow) {
  return {
    fichaId: String(fichaRow.ficha_id),
    biomasaFrescaKg: Number(fichaRow.biomasa_total_kg),
    fechaAforo: fichaRow.fecha_aforo,
    fichaCreatedAt: fichaRow.created_at,
  };
}

function serializeContextoRef(contextoRow) {
  if (!contextoRow) return null;
  return {
    contextoId: String(contextoRow.contexto_id),
    precipitacion7dMm: contextoRow.precipitacion_7d_mm === null ? null : Number(contextoRow.precipitacion_7d_mm),
    createdAt: contextoRow.created_at,
  };
}

// Hardening ronda 3: peso_min/max_referencia_kg del catálogo pasa de
// informativo a COTA DURA -- necesario para que el %PV equivalente
// derivado de la ecuación NRC (2001) de vacas lactantes nunca exceda el
// guardrail técnico de la tabla (agx.potrero_recomendaciones_pastoreo,
// consumo_pct_pv_aplicado <= 10) con litros/día realistas. Aplica a TODAS
// las categorías, no solo leche -- cierra el mismo vacío de "input
// decorativo" que motivó este hardening.
function assertPesoDentroDeRangoCategoria(categoria, pesoPromedioKg) {
  const { pesoMinReferenciaKg, pesoMaxReferenciaKg } = categoria;
  if (pesoMinReferenciaKg === null || pesoMaxReferenciaKg === null) return;
  if (pesoPromedioKg < pesoMinReferenciaKg || pesoPromedioKg > pesoMaxReferenciaKg) {
    throw semanticError(
      'PESO_FUERA_DE_RANGO_CATEGORIA',
      400,
      `El peso promedio para "${categoria.nombre}" debe estar entre ${pesoMinReferenciaKg} y ${pesoMaxReferenciaKg} kg.`,
    );
  }
}

// Hardening §3/§4 (ronda 3) + §1/§5 (ronda 4): los campos condicionales
// dejaron de ser decorativos -- cuando la categoría los requiere, son
// OBLIGATORIOS. litrosPromedioVacaDia SIEMPRE es obligatorio para
// categorías lactantes (§6 del sprint original). grasaLechePct es SIEMPRE
// OPCIONAL (§4/§5 hardening ronda 4 -- "no obligar al pequeño productor a
// conocerla"). diasEnLeche es obligatorio SOLO si el cliente aporta
// grasaLechePct -- solo en ese caso el motor ejecuta la ecuación NRC
// (2001) completa, que exige WOL. Sin grasa, diasEnLeche no se usa (perfil
// %PV genérico) -- no tiene sentido exigirlo (§2 hardening ronda 4: "no
// pedir información que no entre al modelo").
function assertCamposCondicionalesCompletos(categoria, { produccionLecheLDia, diasEnLeche, grasaLechePct, terneroAlPie }) {
  if (categoria.requiereProduccionLeche) {
    if (produccionLecheLDia === null || produccionLecheLDia === undefined) {
      throw semanticError(
        'MISSING_PRODUCCION_LECHE',
        400,
        'Esta categoría requiere el promedio de litros/vaca/día.',
      );
    }
    const aportaGrasa = typeof grasaLechePct === 'number' && Number.isFinite(grasaLechePct) && grasaLechePct > 0;
    if (aportaGrasa && (diasEnLeche === null || diasEnLeche === undefined)) {
      throw semanticError(
        'MISSING_DIAS_EN_LECHE',
        400,
        'Si aportas el %grasa de la leche, también debes indicar los días en leche -- ambos alimentan la ecuación de cálculo completa.',
      );
    }
  }
  if (categoria.requiereTerneroAlPie && (terneroAlPie === null || terneroAlPie === undefined)) {
    throw semanticError(
      'MISSING_TERNERO_AL_PIE',
      400,
      'Esta categoría requiere indicar si hay ternero al pie.',
    );
  }
}

/**
 * Resuelve categoría + ficha + tipo de pastura + contexto + parámetros
 * aplicados + resultado -- única fuente de verdad de cálculo, compartida
 * entre preview y create (mismo criterio que capacidadPastoreoRepository).
 * Nunca lanza CALCULATION_UNAVAILABLE salvo un guardrail defensivo
 * (demanda diaria <= 0, que no debería ocurrir con las validaciones de
 * entrada del router, pero el motor nunca debe dividir por cero de forma
 * silenciosa).
 */
async function resolveRecomendacion(client, {
  predioId, potreroId, categoriaCodigo, numeroAnimales, pesoPromedioKg,
  produccionLecheLDia, diasEnLeche, grasaLechePct, terneroAlPie,
}) {
  await assertPotreroBelongsToPredio(client, predioId, potreroId);

  const categoria = await fetchCategoriaByCodigo(client, categoriaCodigo);
  assertPesoDentroDeRangoCategoria(categoria, pesoPromedioKg);
  assertCamposCondicionalesCompletos(categoria, { produccionLecheLDia, diasEnLeche, grasaLechePct, terneroAlPie });

  const fichaRow = await fetchFichaMasReciente(client, potreroId);
  const { tipo: tipoPasturaBotanico, nombreComun, nombreCientifico } = await resolveTipoPasturaBotanico(client, fichaRow);
  const contextoRow = await fetchContextoMasReciente(client, potreroId);

  const contextoSerializado = serializeContextoRef(contextoRow);
  // materiaSecaMedidaPct: hardening §7, arquitectura preparada para un
  // futuro %MS medido/bromatológico -- NUNCA poblado en v1.
  const pastureClimate = resolvePastureClimateParams(
    tipoPasturaBotanico,
    { nombreComun, nombreCientifico },
    { precipitacion7dMm: contextoSerializado?.precipitacion7dMm ?? null },
    null,
  );

  const esCategoriaLeche = categoria.requiereProduccionLeche;
  const biomasaFrescaKg = Number(fichaRow.biomasa_total_kg);
  const resultado = computeRecomendacionPastoreo({
    biomasaFrescaKg,
    materiaSecaPct: pastureClimate.materiaSecaPct,
    utilizacionPct: pastureClimate.utilizacionPct,
    consumoPctPesoVivo: categoria.consumoMsPctPvTipico,
    pesoPromedioKg,
    numeroAnimales,
    esCategoriaLeche,
    litrosPromedioVacaDia: esCategoriaLeche ? produccionLecheLDia : null,
    diasEnLeche: esCategoriaLeche ? diasEnLeche : null,
    grasaLechePct: esCategoriaLeche ? grasaLechePct : null,
    terneroAlPie: categoria.requiereTerneroAlPie ? terneroAlPie : null,
  });

  if (!Number.isFinite(resultado.diasOcupacionEstimados) || resultado.diasOcupacionEstimados < 0) {
    throw semanticError(
      ESTADO_RECOMENDACION.CALCULATION_UNAVAILABLE,
      500,
      'No fue posible completar el cálculo con los datos disponibles.',
    );
  }

  // Hardening ronda 4 §1/§5: solo hubo ecuación NRC (2001) real cuando el
  // motor efectivamente la ejecutó (dmiModel === 'NRC_2001_DAIRY_DMI',
  // requiere %grasa real) -- si usó el perfil %PV genérico
  // (GENERIC_LACTATING_PROFILE), el %PV "aplicado" ES el valor del
  // catálogo (eso fue literalmente lo que se usó, honestidad de
  // "aplicado", hardening ronda 2 §7).
  const usoEcuacionRealLeche = resultado.dmiModel === 'NRC_2001_DAIRY_DMI';
  const usaPerfilGenericoLeche = esCategoriaLeche && resultado.dmiModel === 'GENERIC_LACTATING_PROFILE';
  const consumoPctPvAplicado = usoEcuacionRealLeche
    ? (resultado.demandaIndividualKgMsDia / pesoPromedioKg) * 100
    : categoria.consumoMsPctPvTipico;

  // Hardening §4: limitaciones explícitas -- ternero al pie no cuantificado.
  const limitaciones = [];
  if (categoria.requiereTerneroAlPie && terneroAlPie === true) {
    limitaciones.push('TERNERO_AL_PIE_DEMANDA_NO_CUANTIFICADA');
  }
  // Hardening ronda 4 §5: nunca se presenta el perfil genérico como si
  // hubiera corrido la ecuación NRC (2001) real.
  if (usaPerfilGenericoLeche) {
    limitaciones.push('LECHE_SIN_GRASA_PERFIL_GENERICO');
  }

  const fichaEdadDias = fichaEdadEnDias(fichaRow);
  const nivelConfianza = resolveNivelConfianza({
    tieneContexto: Boolean(contextoSerializado),
    fichaEdadDias,
    dryMatterSource: pastureClimate.dryMatterSource,
    categoriaFuenteTipo: categoria.fuenteTipo,
    terneroAlPie: categoria.requiereTerneroAlPie ? terneroAlPie : null,
    usaPerfilGenericoLeche,
  });

  const estado = contextoSerializado ? ESTADO_RECOMENDACION.READY : ESTADO_RECOMENDACION.PARTIAL_CONTEXT;

  return {
    categoria,
    fichaRow,
    contextoSerializado,
    pastureClimate,
    resultado,
    consumoPctPvAplicado,
    limitaciones,
    nivelConfianza,
    estado,
    fichaEdadDias,
    usoEcuacionRealLeche,
    usaPerfilGenericoLeche,
  };
}

function buildParametrosFuenteJson({
  categoria, pastureClimate, fichaRow, contextoSerializado, fichaEdadDias,
  resultado, consumoPctPvAplicado, limitaciones, usoEcuacionRealLeche, usaPerfilGenericoLeche,
}) {
  return {
    categoria: {
      codigo: categoria.codigo,
      nombre: categoria.nombre,
      grupoProductivo: categoria.grupoProductivo,
      fuenteTecnica: categoria.metadataTecnica?.fuente ?? null,
      fuenteEdicion: categoria.metadataTecnica?.fuente_edicion ?? null,
      // Hardening §1/§2/§9: ADAPTED (ecuación NASEM/NRC simplificada) o
      // FALLBACK (sin tabla específica -- degrada confianza).
      fuenteTipo: categoria.fuenteTipo,
    },
    pastura: {
      tipoAplicado: pastureClimate.tipoPasturaAplicado,
      fuenteTecnicaMateriaSeca: pastureClimate.fuenteTecnica.materiaSeca,
      fuenteTecnicaUtilizacion: pastureClimate.fuenteTecnica.utilizacion,
      // Hardening ronda 3 §6: MEASURED > PASTURE_SPECIFIC_BASELINE >
      // BOTANICAL_TYPE > FALLBACK -- nunca falsa precisión.
      dryMatterSource: pastureClimate.dryMatterSource,
      pasturaEspecificaMetadata: pastureClimate.pasturaEspecificaMetadata,
      utilizacionFuenteTipo: pastureClimate.utilizacionFuenteTipo,
      ajusteDeficitHidricoAplicado: pastureClimate.ajusteDeficitHidricoAplicado,
    },
    // Hardening ronda 4 §1/§3/§7: auditoría completa de la ecuación de
    // leche -- SOLO poblada cuando realmente corrió (grasa real aportada).
    // Con perfil genérico (sin grasa), queda null y la limitación
    // LECHE_SIN_GRASA_PERFIL_GENERICO documenta por qué.
    ecuacionLeche: usoEcuacionRealLeche ? {
      dmiModel: resultado.dmiModel,
      dmiModelSourceType: resultado.dmiDetalle.dmiModelSourceType,
      milkInputLitersDay: resultado.dmiDetalle.milkInputLitersDay,
      milkKgDayUsed: resultado.dmiDetalle.milkKgDayUsed,
      milkDensityOrConversionSource: resultado.dmiDetalle.milkDensityOrConversionSource,
      milkFatPct: resultado.dmiDetalle.milkFatPct,
      milkFatKgDay: resultado.dmiDetalle.milkFatKgDay,
      fcmKgDay: resultado.dmiDetalle.fcmKgDay,
      fcmFormulaSource: 'GAINES_1923_FCM',
      daysInMilk: resultado.dmiDetalle.daysInMilk,
      weeksOfLactation: resultado.dmiDetalle.weeksOfLactation,
      bwKg: resultado.dmiDetalle.bwKg,
      predictedDmiKgDay: resultado.dmiDetalle.predictedDmiKgDay,
      equationSource: resultado.dmiDetalle.equationSource,
      consumoPctPvEquivalente: consumoPctPvAplicado,
    } : (usaPerfilGenericoLeche ? { dmiModel: 'GENERIC_LACTATING_PROFILE', fuenteTecnica: 'GENERIC_LACTATING_PROFILE' } : null),
    // Hardening §4: limitaciones explícitas -- nunca fingir precisión.
    limitaciones,
    fichaId: String(fichaRow.ficha_id),
    fichaEdadDias: fichaEdadDias === null ? null : Math.round(fichaEdadDias * 100) / 100,
    contextoId: contextoSerializado ? contextoSerializado.contextoId : null,
    motorVersion: MOTOR_VERSION,
  };
}

// Hardening §7 (ronda 2, reforzado ronda 3): el output distingue
// explícitamente CALCULATED (`resultado` -- derivado matemáticamente,
// siempre reproducible) de ASSUMED/ESTIMATED (`parametrosAplicados` --
// %MS/%utilización/%consumo, ninguno medido en este potrero) --
// `provenance` documenta de dónde salió cada asumido (dryMatterSource,
// fuente de categoría) y `nivelConfianza` cierra el cuadro. `limitaciones`
// expone honestamente lo que el motor NO cuantifica (ternero al pie).
function buildResponsePayload({
  categoria, fichaRow, contextoSerializado, pastureClimate, resultado,
  consumoPctPvAplicado, limitaciones, nivelConfianza, estado, inputs,
}) {
  return {
    estado,
    motorVersion: MOTOR_VERSION,
    categoria: {
      categoriaId: categoria.categoriaId,
      codigo: categoria.codigo,
      nombre: categoria.nombre,
      grupoProductivo: categoria.grupoProductivo,
    },
    ficha: serializeFichaRef(fichaRow),
    contexto: contextoSerializado,
    inputs: {
      numeroAnimales: inputs.numeroAnimales,
      pesoPromedioKg: inputs.pesoPromedioKg,
      produccionLecheLDia: inputs.produccionLecheLDia ?? null,
      diasEnLeche: inputs.diasEnLeche ?? null,
      grasaLechePct: inputs.grasaLechePct ?? null,
      terneroAlPie: inputs.terneroAlPie ?? null,
    },
    // ASSUMED/ESTIMATED -- nunca medidos en este potrero (§7 hardening).
    parametrosAplicados: {
      materiaSecaPct: pastureClimate.materiaSecaPct,
      utilizacionPct: pastureClimate.utilizacionPct,
      consumoPctPesoVivo: consumoPctPvAplicado,
    },
    // CALCULATED -- derivado matemáticamente de biomasa real + los
    // ASSUMED de arriba (§7 hardening). Hardening ronda 5: remanente
    // objetivo (reserva planeada) y remanente/consumo proyectado (usando
    // los DÍAS REALMENTE RECOMENDADOS, ya redondeados hacia abajo) son
    // conceptos separados -- ninguno es alias del otro.
    resultado: {
      materiaSecaTotalKg: resultado.materiaSecaTotalKg,
      materiaSecaUtilizableKg: resultado.materiaSecaUtilizableKg,
      demandaIndividualKgMsDia: resultado.demandaIndividualKgMsDia,
      demandaDiariaLoteKgMs: resultado.demandaDiariaLoteKgMs,
      diasOcupacionEstimados: resultado.diasOcupacionEstimados,
      diasOcupacionRecomendados: resultado.diasOcupacionRecomendados,
      consumoProyectadoKg: resultado.consumoProyectadoKg,
      remanenteObjetivoKg: resultado.remanenteObjetivoKg,
      remanenteProyectadoKg: resultado.remanenteProyectadoKg,
    },
    // Provenance de cada ASSUMED (§3/§4/§5/§6/§7 hardening) -- nunca
    // scoring opaco, nunca falsa precisión.
    provenance: {
      categoriaFuenteTipo: categoria.fuenteTipo,
      categoriaFuenteTecnica: categoria.metadataTecnica?.fuente ?? null,
      // Hardening ronda 4 §1/§4/§5: qué modelo produjo demandaIndividualKgMsDia
      // para categorías lactantes -- 'NRC_2001_DAIRY_DMI' (grasa real
      // aportada, DIRECT) | 'GENERIC_LACTATING_PROFILE' (sin grasa,
      // ADAPTED, confianza topada en MEDIA) | null (categoría no lactante).
      dmiModel: resultado.dmiModel,
      dryMatterSource: pastureClimate.dryMatterSource,
      pasturaEspecificaMetadata: pastureClimate.pasturaEspecificaMetadata,
      pasturaFuenteTecnicaMateriaSeca: pastureClimate.fuenteTecnica.materiaSeca,
      utilizacionFuenteTipo: pastureClimate.utilizacionFuenteTipo,
      pasturaFuenteTecnicaUtilizacion: pastureClimate.fuenteTecnica.utilizacion,
      ajusteDeficitHidricoAplicado: pastureClimate.ajusteDeficitHidricoAplicado,
    },
    limitaciones,
    nivelConfianza,
    requiereAdvertenciaLeche: categoria.requiereProduccionLeche,
  };
}

/**
 * Preview (§16 del sprint): calcula server-side, NUNCA persiste.
 */
export async function previewRecomendacionPastoreo(organizacionId, predioId, potreroId, params) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const resolved = await resolveRecomendacion(client, { predioId, potreroId, ...params });
    return buildResponsePayload({ ...resolved, inputs: params });
  });
}

function serializeRecomendacionRow(row) {
  const materiaSecaTotalKg = Number(row.materia_seca_total_kg);
  const materiaSecaUtilizableKg = Number(row.materia_seca_utilizable_kg);
  const demandaDiariaLoteKgMs = Number(row.demanda_diaria_lote_kg_ms);
  const diasOcupacionEstimados = Number(row.dias_ocupacion_estimados);
  // Hardening ronda 5: remanente/consumo proyectado NUNCA se persistieron
  // como columnas (son 100% derivables de lo ya persistido) -- se
  // recalculan aquí en cada lectura, misma fórmula que en el cálculo
  // fresco (computeRemnantDerivatives), para que una recomendación
  // histórica muestre la semántica correcta sin necesitar migrar datos.
  const remnant = computeRemnantDerivatives({
    materiaSecaTotalKg, materiaSecaUtilizableKg, demandaDiariaLoteKgMs, diasOcupacionEstimados,
  });

  return {
    recomendacionId: String(row.recomendacion_id),
    categoriaCodigo: row.categoria_codigo,
    categoriaNombre: row.categoria_nombre,
    categoriaGrupoProductivo: row.categoria_grupo_productivo,
    requiereAdvertenciaLeche: Boolean(row.categoria_requiere_produccion_leche),
    fichaId: String(row.ficha_id),
    contextoId: row.contexto_id === null ? null : String(row.contexto_id),
    numeroAnimales: Number(row.numero_animales),
    pesoPromedioKg: Number(row.peso_promedio_kg),
    produccionLecheLDia: row.produccion_leche_l_dia === null ? null : Number(row.produccion_leche_l_dia),
    diasEnLeche: row.dias_en_leche === null ? null : Number(row.dias_en_leche),
    grasaLechePct: row.grasa_leche_pct === null ? null : Number(row.grasa_leche_pct),
    materiaSecaPctAplicada: Number(row.materia_seca_pct_aplicada),
    utilizacionPctAplicada: Number(row.utilizacion_pct_aplicada),
    consumoPctPvAplicado: Number(row.consumo_pct_pv_aplicado),
    materiaSecaTotalKg,
    materiaSecaUtilizableKg,
    demandaDiariaLoteKgMs,
    diasOcupacionEstimados,
    diasOcupacionRecomendados: remnant.diasOcupacionRecomendados,
    consumoProyectadoKg: remnant.consumoProyectadoKg,
    remanenteObjetivoKg: remnant.remanenteObjetivoKg,
    remanenteProyectadoKg: remnant.remanenteProyectadoKg,
    nivelConfianza: row.nivel_confianza,
    motorVersion: row.motor_version,
    parametrosFuente: row.parametros_fuente_json,
    createdAt: row.created_at,
  };
}

/**
 * Create (§16 del sprint): recalcula server-side (NUNCA confía en
 * resultados enviados por el cliente) y persiste una fila NUEVA, histórica.
 */
export async function createRecomendacionPastoreo(organizacionId, predioId, potreroId, params) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const resolved = await resolveRecomendacion(client, { predioId, potreroId, ...params });
    const {
      categoria, fichaRow, contextoSerializado, pastureClimate, resultado,
      consumoPctPvAplicado, limitaciones, nivelConfianza, fichaEdadDias,
      usoEcuacionRealLeche, usaPerfilGenericoLeche,
    } = resolved;

    const parametrosFuenteJson = buildParametrosFuenteJson({
      categoria, pastureClimate, fichaRow, contextoSerializado, fichaEdadDias,
      resultado, consumoPctPvAplicado, limitaciones, usoEcuacionRealLeche, usaPerfilGenericoLeche,
    });

    const insertResult = await client.query(
      `insert into agx.potrero_recomendaciones_pastoreo
         (organizacion_id, predio_id, potrero_id, ficha_id, contexto_id, categoria_id,
          numero_animales, peso_promedio_kg, produccion_leche_l_dia, dias_en_leche, grasa_leche_pct,
          materia_seca_pct_aplicada, utilizacion_pct_aplicada, consumo_pct_pv_aplicado,
          materia_seca_total_kg, materia_seca_utilizable_kg, demanda_diaria_lote_kg_ms, dias_ocupacion_estimados,
          nivel_confianza, parametros_fuente_json, motor_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       returning recomendacion_id, ficha_id, contexto_id, numero_animales, peso_promedio_kg,
                 produccion_leche_l_dia, dias_en_leche, grasa_leche_pct, materia_seca_pct_aplicada, utilizacion_pct_aplicada,
                 consumo_pct_pv_aplicado, materia_seca_total_kg, materia_seca_utilizable_kg,
                 demanda_diaria_lote_kg_ms, dias_ocupacion_estimados, nivel_confianza,
                 parametros_fuente_json, motor_version, created_at`,
      [
        organizacionId,
        predioId,
        potreroId,
        fichaRow.ficha_id,
        contextoSerializado ? contextoSerializado.contextoId : null,
        categoria.categoriaId,
        params.numeroAnimales,
        params.pesoPromedioKg,
        params.produccionLecheLDia ?? null,
        params.diasEnLeche ?? null,
        params.grasaLechePct ?? null,
        pastureClimate.materiaSecaPct,
        pastureClimate.utilizacionPct,
        consumoPctPvAplicado,
        resultado.materiaSecaTotalKg,
        resultado.materiaSecaUtilizableKg,
        resultado.demandaDiariaLoteKgMs,
        resultado.diasOcupacionEstimados,
        nivelConfianza,
        JSON.stringify(parametrosFuenteJson),
        MOTOR_VERSION,
      ],
    );

    const row = insertResult.rows[0];
    return {
      ...serializeRecomendacionRow({
        ...row,
        categoria_codigo: categoria.codigo,
        categoria_nombre: categoria.nombre,
        categoria_grupo_productivo: categoria.grupoProductivo,
        categoria_requiere_produccion_leche: categoria.requiereProduccionLeche,
      }),
      ficha: serializeFichaRef(fichaRow),
      contexto: contextoSerializado,
    };
  });
}

/**
 * Recomendación más reciente + historial resumido de un potrero. Devuelve
 * { actual: null, historial: [] } si el potrero todavía no tiene ninguna
 * recomendación registrada -- nunca 404 (el potrero sí existe).
 */
export async function getRecomendacionPastoreoByPotrero(organizacionId, predioId, potreroId) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    await assertPotreroBelongsToPredio(client, predioId, potreroId);

    const result = await client.query(
      `select r.recomendacion_id, r.ficha_id, r.contexto_id, r.numero_animales, r.peso_promedio_kg,
              r.produccion_leche_l_dia, r.dias_en_leche, r.grasa_leche_pct, r.materia_seca_pct_aplicada, r.utilizacion_pct_aplicada,
              r.consumo_pct_pv_aplicado, r.materia_seca_total_kg, r.materia_seca_utilizable_kg,
              r.demanda_diaria_lote_kg_ms, r.dias_ocupacion_estimados, r.nivel_confianza,
              r.parametros_fuente_json, r.motor_version, r.created_at,
              c.codigo as categoria_codigo, c.nombre as categoria_nombre, c.grupo_productivo as categoria_grupo_productivo,
              c.requiere_produccion_leche as categoria_requiere_produccion_leche
         from agx.potrero_recomendaciones_pastoreo r
         join agx.catalogo_categorias_productivas c on c.categoria_id = r.categoria_id
        where r.potrero_id = $1
        order by r.created_at desc
        limit $2`,
      [potreroId, HISTORIAL_LIMIT + 1],
    );

    if (result.rows.length === 0) {
      return { actual: null, historial: [] };
    }

    const [actualRow, ...historialRows] = result.rows;
    return {
      actual: serializeRecomendacionRow(actualRow),
      historial: historialRows.map(serializeRecomendacionRow),
    };
  });
}
