// SPRINT-3D10.4 FASE 3 -- SERVICIO/ORQUESTADOR DEL MOTOR AUTOMÁTICO DE
// CARGA RECOMENDADA (agx.potrero_recomendaciones_pastoreo, modo_calculo=
// 'AUTOMATICO', columnas 0020_potrero_recomendacion_carga_automatica.sql).
//
// REGLA DE AUTORIDAD (§0 del sprint): el cliente SOLO aporta hechos del
// productor (categoriaCodigo, pesoPromedioKg, fechaIngresoPrevista +
// condicionales de leche/ternero). fichaId, tipoPastura/géneroPastura,
// occupationPolicy, MSU/DI, resultados calculados y provenance técnico
// se resuelven SIEMPRE aquí -- ver validateCargaAutomaticaBody en el
// router (whitelist estricta, 400 FORBIDDEN_FIELDS ante cualquier otro
// campo).
//
// UN SOLO ORQUESTADOR (§2): resolverContextoPastoreoAutomatico es
// exactamente el mismo pipeline para preview, escenario y guardar -- guardar
// jamás confía en un resultado de preview, siempre recalcula desde cero
// (§9 -- stale preview). No hay tres pipelines paralelos.
import { withOrganizacionTransaction } from '../../db/agxBusinessPool.js';
import { fetchCategoriaByCodigo } from './categoriaProductivaRepository.js';
import { resolvePastureClimateParams } from './motorPastoreoAuto/pastureClimateEngine.js';
import {
  resolveDemandaIndividualKgMsDia,
  resolveConsumoPctPvAplicado,
  resolveNivelConfianza,
} from './motorPastoreoAuto/recomendacionPastoreoFormulas.js';
import {
  computeMateriaSecaTotalKg,
  computeMateriaSecaUtilizableKg,
} from './capacidadPastoreoFormulas.js';
import {
  resolverPoliticaOcupacion,
  computeCargaRecomendadaAutomatica,
  evaluarEscenarioUsuario,
  ESTADO_PASTURA_SIN_POLITICA,
  MOTOR_CARGA_AUTOMATICA_VERSION,
} from './motorPastoreoAuto/cargaAutomaticaFormulas.js';
import { computeFechaSalidaEstimada } from './motorPastoreoAuto/fechaPlanHelpers.js';
import { ESTADO_RECOMENDACION } from './motorPastoreoAuto/estadosRecomendacion.js';
import { MOTOR_VERSION } from './motorPastoreoAuto/motorVersion.js';
import { resolveFichaVigente } from './potreroFichaVigenciaResolver.js';
import {
  assertPotreroBelongsToPredio,
  assertPesoDentroDeRangoCategoria,
  assertCamposCondicionalesCompletos,
  fetchContextoMasReciente,
  serializeContextoRef,
  serializeFichaRef,
  resolveTipoPasturaBotanico,
  fichaEdadEnDias,
} from './potreroRecomendacionPastoreoRepository.js';

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

// Convierte una excepción INPUT_INVALID del motor puro (Fase 2, sin
// .status -- HTTP-agnóstico por diseño) en un error semántico 400 -- §14
// del sprint: nunca 500 por input humano inválido, nunca confundido con
// NO_RECOMMENDATION_INSUFFICIENT_FORAGE (§8 Fase 2). Defensivo: con el
// pipeline resuelto correctamente esto nunca debería activarse.
function rethrowSiInputInvalido(error) {
  if (error?.code === 'INPUT_INVALID') {
    throw semanticError('INPUT_INVALID', 400, error.message);
  }
  throw error;
}

// Orden de severidad para componer el nivel de confianza final -- mismo
// criterio de "nunca mejorar, solo empeorar" que resolveNivelConfianza,
// aplicado aquí para combinar la confianza propia del cálculo científico
// (biomasa/NRC/contexto) con la confianza de la política de ocupación
// (MEDIA/BAJA, §16 3D10.4 Fase 2) -- ninguna de las dos puede maquillar a
// la otra.
const ORDEN_CONFIANZA = ['ALTA', 'MEDIA', 'BAJA'];
function peorNivelConfianza(a, b) {
  return ORDEN_CONFIANZA[Math.max(ORDEN_CONFIANZA.indexOf(a), ORDEN_CONFIANZA.indexOf(b))];
}

/**
 * §4 del sprint: resuelve género/tipo/alcance de la(s) especie(s) de la
 * ficha, EXCLUSIVAMENTE desde DB (ficha + catálogo) -- nunca desde body
 * HTTP. Para mezcla, el género dominante solo se declara "identificable"
 * si TODAS las especies tienen porcentaje_estimado registrado y existe un
 * único máximo sin empate -- de lo contrario se trata como no
 * identificable (nunca se inventa un ganador).
 */
async function resolverGeneroPasturaParaPolitica(client, fichaRow) {
  const result = await client.query(
    `select cp.genero, cp.tipo, cp.alcance, fp.porcentaje_estimado
       from agx.potrero_ficha_pasturas fp
       join agx.catalogo_pasturas cp on cp.pastura_id = fp.pastura_id
      where fp.ficha_id = $1
      order by fp.orden asc, fp.ficha_pastura_id asc`,
    [fichaRow.ficha_id],
  );
  const especies = result.rows;
  if (especies.length === 0) {
    return { tipo: 'otra', genero: null, alcance: 'sistema', generoDominante: null };
  }
  if (fichaRow.tipo_cobertura !== 'mezcla' || especies.length === 1) {
    const unica = especies[0];
    return { tipo: unica.tipo, genero: unica.genero, alcance: unica.alcance, generoDominante: null };
  }
  const todosConPorcentaje = especies.every((especie) => especie.porcentaje_estimado !== null && especie.porcentaje_estimado !== undefined);
  let generoDominante = null;
  if (todosConPorcentaje) {
    const porcentajes = especies.map((especie) => Number(especie.porcentaje_estimado));
    const maximo = Math.max(...porcentajes);
    const conElMaximo = especies.filter((especie) => Number(especie.porcentaje_estimado) === maximo);
    if (conElMaximo.length === 1) generoDominante = conElMaximo[0].genero;
  }
  return { tipo: 'mezcla', genero: null, alcance: 'sistema', generoDominante };
}

/**
 * §2 del sprint: orquestador ÚNICO, compartido por preview/escenario/
 * guardar. NO escribe DB. Retorna:
 *   { estado: 'OK', ...contexto completo }
 *   { estado: 'PASTURA_SIN_POLITICA_DEFINIDA' }
 * o lanza un error semántico (404 sin ficha vigente / 400 categoría o
 * peso o condicionales inválidos) -- exactamente la misma semántica ya
 * aprobada del flujo manual (§3 del sprint: "no crear semántica HTTP
 * nueva").
 */
async function resolverContextoPastoreoAutomatico(client, { predioId, potreroId, input }) {
  await assertPotreroBelongsToPredio(client, predioId, potreroId);

  const categoria = await fetchCategoriaByCodigo(client, input.categoriaCodigo);
  assertPesoDentroDeRangoCategoria(categoria, input.pesoPromedioKg);
  assertCamposCondicionalesCompletos(categoria, input);

  const { ficha } = await resolveFichaVigente(client, potreroId);
  if (!ficha) {
    // §3: misma semántica HTTP aprobada en 3D10.4 Fase 1 -- sin ficha
    // vigente (inexistente o anterior al último pastoreo real) es
    // INSUFFICIENT_FORAGE_DATA/404, sin distinguir el motivo interno.
    throw semanticError(
      ESTADO_RECOMENDACION.INSUFFICIENT_FORAGE_DATA,
      404,
      'Primero registra una ficha productiva con un aforo del potrero posterior al último pastoreo.',
    );
  }

  const pasturaInfo = await resolverGeneroPasturaParaPolitica(client, ficha);
  const politica = resolverPoliticaOcupacion(pasturaInfo);
  if (politica.estado === ESTADO_PASTURA_SIN_POLITICA) {
    return { estado: ESTADO_PASTURA_SIN_POLITICA };
  }

  const { tipo: tipoPasturaBotanico, nombreComun, nombreCientifico } = await resolveTipoPasturaBotanico(client, ficha);
  const contextoRow = await fetchContextoMasReciente(client, potreroId);
  const contextoSerializado = serializeContextoRef(contextoRow);

  // §5: reutiliza EXACTAMENTE el motor pastura/clima ya existente -- nunca
  // se acopla este servicio a ERA5/IDEAM directamente. Contexto ausente
  // degrada a PARTIAL_CONTEXT, nunca bloquea (mismo comportamiento actual).
  const pastureClimate = resolvePastureClimateParams(
    tipoPasturaBotanico,
    { nombreComun, nombreCientifico },
    { precipitacion7dMm: contextoSerializado?.precipitacion7dMm ?? null },
    null,
  );

  const biomasaFrescaKg = Number(ficha.biomasa_total_kg);
  const materiaSecaTotalKg = computeMateriaSecaTotalKg(biomasaFrescaKg, pastureClimate.materiaSecaPct);
  const materiaSecaUtilizableKg = computeMateriaSecaUtilizableKg(materiaSecaTotalKg, pastureClimate.utilizacionPct);

  const esCategoriaLeche = categoria.requiereProduccionLeche;
  const { demandaIndividualKgMsDia, dmiModel, dmiDetalle } = resolveDemandaIndividualKgMsDia({
    pesoPromedioKg: input.pesoPromedioKg,
    consumoPctPesoVivo: categoria.consumoMsPctPvTipico,
    esCategoriaLeche,
    litrosPromedioVacaDia: esCategoriaLeche ? input.produccionLecheLDia : null,
    diasEnLeche: esCategoriaLeche ? input.diasEnLeche : null,
    grasaLechePct: esCategoriaLeche ? input.grasaLechePct : null,
  });

  return {
    estado: 'OK',
    estadoContexto: contextoSerializado ? ESTADO_RECOMENDACION.READY : ESTADO_RECOMENDACION.PARTIAL_CONTEXT,
    ficha,
    categoria,
    politica,
    pastureClimate,
    contextoSerializado,
    materiaSecaTotalKg,
    materiaSecaUtilizableKg,
    demandaIndividualKgMsDia,
    dmiModel,
    dmiDetalle,
  };
}

function resolveNivelConfianzaFinal(contexto) {
  const usaPerfilGenericoLeche = contexto.categoria.requiereProduccionLeche && contexto.dmiModel === 'GENERIC_LACTATING_PROFILE';
  const nivelConfianzaCientifico = resolveNivelConfianza({
    tieneContexto: Boolean(contexto.contextoSerializado),
    fichaEdadDias: fichaEdadEnDias(contexto.ficha),
    dryMatterSource: contexto.pastureClimate.dryMatterSource,
    categoriaFuenteTipo: contexto.categoria.fuenteTipo,
    terneroAlPie: null,
    usaPerfilGenericoLeche,
  });
  return peorNivelConfianza(nivelConfianzaCientifico, contexto.politica.policy.confidence);
}

function buildDetalleTecnico(contexto) {
  return {
    ficha: serializeFichaRef(contexto.ficha),
    contexto: contexto.contextoSerializado,
    estadoContexto: contexto.estadoContexto,
    categoria: {
      categoriaId: contexto.categoria.categoriaId,
      codigo: contexto.categoria.codigo,
      nombre: contexto.categoria.nombre,
      grupoProductivo: contexto.categoria.grupoProductivo,
    },
    materiaSecaTotalKg: contexto.materiaSecaTotalKg,
    materiaSecaUtilizableKg: contexto.materiaSecaUtilizableKg,
    demandaIndividualKgMsDia: contexto.demandaIndividualKgMsDia,
    dmiModel: contexto.dmiModel,
    materiaSecaPctAplicada: contexto.pastureClimate.materiaSecaPct,
    utilizacionPctAplicada: contexto.pastureClimate.utilizacionPct,
    dryMatterSource: contexto.pastureClimate.dryMatterSource,
    occupationPolicy: contexto.politica.policy,
    nivelConfianza: resolveNivelConfianzaFinal(contexto),
  };
}

/**
 * §6 del sprint: preview -- recalcula TODO server-side, NUNCA persiste.
 */
export async function previewCargaAutomatica(organizacionId, predioId, potreroId, input) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const contexto = await resolverContextoPastoreoAutomatico(client, { predioId, potreroId, input });
    if (contexto.estado === ESTADO_PASTURA_SIN_POLITICA) {
      return { estado: ESTADO_PASTURA_SIN_POLITICA };
    }

    let resultado;
    try {
      resultado = computeCargaRecomendadaAutomatica({
        materiaSecaTotalKg: contexto.materiaSecaTotalKg,
        materiaSecaUtilizableKg: contexto.materiaSecaUtilizableKg,
        demandaIndividualKgMsDia: contexto.demandaIndividualKgMsDia,
        occupationPolicy: contexto.politica.policy,
      });
    } catch (error) {
      rethrowSiInputInvalido(error);
    }

    if (resultado.estado !== 'OK') {
      return { estado: resultado.estado, detalleTecnico: buildDetalleTecnico(contexto) };
    }

    const fechaSalidaEstimada = computeFechaSalidaEstimada(input.fechaIngresoPrevista, resultado.diasPermanenciaRecomendada);

    return {
      estado: 'OK',
      numeroAnimalesRecomendado: resultado.numeroAnimalesRecomendado,
      diasPermanenciaRecomendada: resultado.diasPermanenciaRecomendada,
      fechaIngresoPrevista: input.fechaIngresoPrevista,
      fechaSalidaEstimada,
      detalleTecnico: {
        ...buildDetalleTecnico(contexto),
        motivoDuracion: resultado.motivoDuracion,
        numeroAnimalesRaw: resultado.numeroAnimalesRaw,
        consumoOperativoKg: resultado.consumoOperativoKg,
        remanenteOperativoKg: resultado.remanenteOperativoKg,
        margenForrajeKg: resultado.margenForrajeKg,
        diasMaximosSoportadosExactos: resultado.diasMaximosSoportadosExactos,
        motorCargaAutomaticaVersion: MOTOR_CARGA_AUTOMATICA_VERSION,
      },
    };
  });
}

/**
 * §7 del sprint: escenario -- recalcula TODO desde cero (nunca reutiliza
 * un preview previo del navegador), luego evalúa N_usuario. NUNCA
 * persiste, nunca crea una recomendación ficticia.
 */
export async function evaluarEscenarioCargaAutomatica(organizacionId, predioId, potreroId, input) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const contexto = await resolverContextoPastoreoAutomatico(client, { predioId, potreroId, input });
    if (contexto.estado === ESTADO_PASTURA_SIN_POLITICA) {
      return { estado: ESTADO_PASTURA_SIN_POLITICA };
    }

    let escenario;
    try {
      escenario = evaluarEscenarioUsuario({
        materiaSecaTotalKg: contexto.materiaSecaTotalKg,
        materiaSecaUtilizableKg: contexto.materiaSecaUtilizableKg,
        demandaIndividualKgMsDia: contexto.demandaIndividualKgMsDia,
        numeroAnimalesUsuario: input.numeroAnimalesUsuario,
        occupationPolicy: contexto.politica.policy,
      });
    } catch (error) {
      rethrowSiInputInvalido(error);
    }

    const fechaSalidaEstimada = escenario.confirmable
      ? computeFechaSalidaEstimada(input.fechaIngresoPrevista, escenario.diasPermanenciaEscenario)
      : null;

    return {
      estado: escenario.clasificacionEscenario,
      numeroAnimalesUsuario: escenario.numeroAnimalesUsuario,
      diasPermanenciaEscenario: escenario.diasPermanenciaEscenario,
      fechaIngresoPrevista: input.fechaIngresoPrevista,
      fechaSalidaEstimada,
      confirmable: escenario.confirmable,
      detalleTecnico: {
        ...buildDetalleTecnico(contexto),
        diasMaximosSoportadosExactos: escenario.diasMaximosSoportadosExactos,
        consumoEscenarioKg: escenario.consumoEscenarioKg,
        remanenteEscenarioKg: escenario.remanenteEscenarioKg,
        margenForrajeEscenarioKg: escenario.margenForrajeEscenarioKg,
        motorCargaAutomaticaVersion: MOTOR_CARGA_AUTOMATICA_VERSION,
      },
    };
  });
}

function serializeRecomendacionAutomaticaRow(row) {
  return {
    recomendacionId: String(row.recomendacion_id),
    fichaId: String(row.ficha_id),
    categoriaCodigo: row.categoria_codigo,
    numeroAnimalesRecomendado: Number(row.numero_animales),
    pesoPromedioKg: Number(row.peso_promedio_kg),
    diasPermanenciaRecomendada: Number(row.dias_permanencia_recomendada),
    motivoDuracion: row.motivo_duracion,
    fechaIngresoPrevista: row.fecha_ingreso_prevista,
    occupationPolicyVersion: row.occupation_policy_version,
    createdAt: row.created_at,
  };
}

/**
 * §8/§9 del sprint: guardar -- RECALCULA DESDE CERO dentro de la misma
 * transacción (§16: BEGIN -> resolver -> calcular -> INSERT -> COMMIT,
 * mismo patrón que createRecomendacionPastoreo). Nunca acepta resultados
 * de un preview anterior -- si entre el preview del cliente y este POST
 * apareció una ficha nueva, el INSERT usa la ficha nueva automáticamente
 * (protección contra stale preview por construcción, no por versionado).
 * Solo persiste si estado='OK'.
 */
export async function guardarCargaAutomatica(organizacionId, predioId, potreroId, input) {
  assertPredioIdFormat(predioId);
  assertPotreroIdFormat(potreroId);

  return withOrganizacionTransaction(organizacionId, async (client) => {
    const contexto = await resolverContextoPastoreoAutomatico(client, { predioId, potreroId, input });
    if (contexto.estado === ESTADO_PASTURA_SIN_POLITICA) {
      return { estado: ESTADO_PASTURA_SIN_POLITICA };
    }

    let resultado;
    try {
      resultado = computeCargaRecomendadaAutomatica({
        materiaSecaTotalKg: contexto.materiaSecaTotalKg,
        materiaSecaUtilizableKg: contexto.materiaSecaUtilizableKg,
        demandaIndividualKgMsDia: contexto.demandaIndividualKgMsDia,
        occupationPolicy: contexto.politica.policy,
      });
    } catch (error) {
      rethrowSiInputInvalido(error);
    }

    if (resultado.estado !== 'OK') {
      return { estado: resultado.estado, detalleTecnico: buildDetalleTecnico(contexto) };
    }

    const fechaSalidaEstimada = computeFechaSalidaEstimada(input.fechaIngresoPrevista, resultado.diasPermanenciaRecomendada);

    // §13: consumo_pct_pv_aplicado con la MISMA honestidad de "aplicado"
    // que el flujo manual (equivalente NRC real si corrió, catálogo si no).
    const consumoPctPvAplicado = resolveConsumoPctPvAplicado({
      dmiModel: contexto.dmiModel,
      demandaIndividualKgMsDia: contexto.demandaIndividualKgMsDia,
      pesoPromedioKg: input.pesoPromedioKg,
      consumoMsPctPvTipico: contexto.categoria.consumoMsPctPvTipico,
    });
    const demandaDiariaLoteKgMs = contexto.demandaIndividualKgMsDia * resultado.numeroAnimalesRecomendado;
    const nivelConfianzaFinal = resolveNivelConfianzaFinal(contexto);

    const parametrosFuenteJson = {
      pastura: {
        tipoAplicado: contexto.pastureClimate.tipoPasturaAplicado,
        fuenteTecnicaMateriaSeca: contexto.pastureClimate.fuenteTecnica?.materiaSeca ?? null,
        fuenteTecnicaUtilizacion: contexto.pastureClimate.fuenteTecnica?.utilizacion ?? null,
        dryMatterSource: contexto.pastureClimate.dryMatterSource,
        utilizacionFuenteTipo: contexto.pastureClimate.utilizacionFuenteTipo,
        ajusteDeficitHidricoAplicado: contexto.pastureClimate.ajusteDeficitHidricoAplicado,
      },
      dmiModel: contexto.dmiModel,
      dmiDetalle: contexto.dmiDetalle,
      categoria: {
        codigo: contexto.categoria.codigo,
        nombre: contexto.categoria.nombre,
        grupoProductivo: contexto.categoria.grupoProductivo,
        fuenteTipo: contexto.categoria.fuenteTipo,
      },
      cargaAutomatica: {
        motorCargaAutomaticaVersion: MOTOR_CARGA_AUTOMATICA_VERSION,
        numeroAnimalesRaw: resultado.numeroAnimalesRaw,
        diasMaximosSoportadosExactos: resultado.diasMaximosSoportadosExactos,
        consumoOperativoKg: resultado.consumoOperativoKg,
        remanenteOperativoKg: resultado.remanenteOperativoKg,
        margenForrajeKg: resultado.margenForrajeKg,
        occupationPolicyConfidence: contexto.politica.policy.confidence,
      },
      fichaId: String(contexto.ficha.ficha_id),
      contextoId: contexto.contextoSerializado ? contexto.contextoSerializado.contextoId : null,
    };

    const insertResult = await client.query(
      `insert into agx.potrero_recomendaciones_pastoreo
         (organizacion_id, predio_id, potrero_id, ficha_id, contexto_id, categoria_id,
          numero_animales, peso_promedio_kg, produccion_leche_l_dia, dias_en_leche, grasa_leche_pct, ternero_al_pie,
          materia_seca_pct_aplicada, utilizacion_pct_aplicada, consumo_pct_pv_aplicado,
          materia_seca_total_kg, materia_seca_utilizable_kg, demanda_diaria_lote_kg_ms, dias_ocupacion_estimados,
          nivel_confianza, parametros_fuente_json, motor_version, modo_calculo,
          fecha_ingreso_prevista, dias_permanencia_recomendada, motivo_duracion, occupation_policy_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
               'AUTOMATICO', $23, $24, $25, $26)
       returning recomendacion_id, ficha_id, categoria_id, numero_animales, peso_promedio_kg,
                 dias_permanencia_recomendada, motivo_duracion,
                 to_char(fecha_ingreso_prevista, 'YYYY-MM-DD') as fecha_ingreso_prevista,
                 occupation_policy_version, created_at`,
      [
        organizacionId,
        predioId,
        potreroId,
        contexto.ficha.ficha_id,
        contexto.contextoSerializado ? contexto.contextoSerializado.contextoId : null,
        contexto.categoria.categoriaId,
        resultado.numeroAnimalesRecomendado,
        input.pesoPromedioKg,
        input.produccionLecheLDia ?? null,
        input.diasEnLeche ?? null,
        input.grasaLechePct ?? null,
        input.terneroAlPie ?? null,
        contexto.pastureClimate.materiaSecaPct,
        contexto.pastureClimate.utilizacionPct,
        consumoPctPvAplicado,
        contexto.materiaSecaTotalKg,
        contexto.materiaSecaUtilizableKg,
        demandaDiariaLoteKgMs,
        resultado.diasMaximosSoportadosExactos,
        nivelConfianzaFinal,
        JSON.stringify(parametrosFuenteJson),
        MOTOR_VERSION,
        input.fechaIngresoPrevista,
        resultado.diasPermanenciaRecomendada,
        resultado.motivoDuracion,
        contexto.politica.policy.version,
      ],
    );

    const row = insertResult.rows[0];
    return {
      estado: 'OK',
      recomendacion: {
        ...serializeRecomendacionAutomaticaRow({ ...row, categoria_codigo: contexto.categoria.codigo }),
        fechaSalidaEstimada,
      },
    };
  });
}
