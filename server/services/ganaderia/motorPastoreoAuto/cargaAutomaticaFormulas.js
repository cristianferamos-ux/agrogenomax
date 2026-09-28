// SPRINT-3D10.4 FASE 2 -- MOTOR AUTOMATICO DE CARGA RECOMENDADA: funciones
// puras, sin DB/HTTP/agroclima. Contrato cientifico cerrado en
// 3D10.2/3D10.2.1/3D10.2.2/3D10.2.3/3D10.2.4 y de implementacion en
// 3D10.3/3D10.3.1 (ver esos sprints para la demostracion matematica
// completa -- aqui solo se implementa el contrato ya aprobado, no se
// re-deriva).
//
// Principio central (3D10.2.4): la duracion de ocupacion es una decision
// de POLITICA (targetDays=3, fallback minDays=2), nunca una coincidencia
// de redondear la capacidad fisica maxima. diasMaximosSoportadosExactos
// es SIEMPRE diagnostico -- calculado DESPUES de decidir N, nunca usado
// para decidir N ni la duracion.
//
// Este modulo NO conoce fechas, HTTP, tenant ni IDs de base de datos --
// eso pertenece a la capa de orquestacion (FASE 3, no implementada aqui).

// -----------------------------------------------------------------------
// Politica cientifica de ocupacion (v1) -- 3D10.2, confidence MEDIA para
// gramineas de catalogo de sistema. maxDays=4 vive UNICAMENTE como
// metadata/provenance -- ninguna rama de este modulo lo usa para decidir
// una duracion (3D10.3 SS1: "no crear logica muerta solo porque maxDays
// exista" -- aqui se cumple no creando ninguna rama en absoluto).
// -----------------------------------------------------------------------
export const OCCUPATION_POLICY_VERSION = 'occupation-policy-tropical-v1';
export const MOTOR_CARGA_AUTOMATICA_VERSION = 'carga-automatica-v1';

export const OCCUPATION_POLICY_V1 = Object.freeze({
  minDays: 2,
  targetDays: 3,
  maxDays: 4,
  version: OCCUPATION_POLICY_VERSION,
});

// -----------------------------------------------------------------------
// SS2 -- Politica de soporte por tipo de pastura (3D10.2.1 SSL, 3D10.3 SSL).
// Pura: recibe una descripcion ya resuelta de la pastura (genero/tipo/
// alcance), nunca consulta el catalogo. Generos aceptados EXACTAMENTE
// como enumera el sprint -- incluye sinonimos populares (Brachiaria,
// Panicum) ademas de los nombres de genero reales del catalogo (Urochloa,
// Megathyrsus), para no exigir que el llamador normalice sinonimia.
// -----------------------------------------------------------------------
const GENEROS_GRAMINEA_SISTEMA = ['Urochloa', 'Brachiaria', 'Megathyrsus', 'Panicum', 'Cynodon', 'Cenchrus'];
const GENEROS_LEGUMINOSA = ['Arachis', 'Leucaena'];

export const ESTADO_PASTURA_SIN_POLITICA = 'PASTURA_SIN_POLITICA_DEFINIDA';

function esGeneroGramineaSistema(genero) {
  return typeof genero === 'string' && GENEROS_GRAMINEA_SISTEMA.includes(genero);
}
function esGeneroLeguminosa(genero) {
  return typeof genero === 'string' && GENEROS_LEGUMINOSA.includes(genero);
}

/**
 * resolverPoliticaOcupacion -- SS2 del sprint.
 *
 * Input: { tipo, genero=null, alcance='sistema', generoDominante=null }
 *   tipo: 'graminea' | 'leguminosa' | 'mezcla' | 'otra'
 *   genero: genero botanico si se conoce (solo relevante cuando alcance='sistema')
 *   alcance: 'sistema' | 'personalizado'
 *   generoDominante: solo para tipo='mezcla' -- genero de la especie dominante
 *                     identificable, si existe.
 *
 * Output:
 *   { estado: 'OK', policy: { ...OCCUPATION_POLICY_V1, confidence } }
 *   { estado: 'PASTURA_SIN_POLITICA_DEFINIDA', policy: null }
 *
 * NO inventa politica para leguminosas -- caso C/E retornan sin policy,
 * nunca un fallback numerico.
 */
export function resolverPoliticaOcupacion({ tipo, genero = null, alcance = 'sistema', generoDominante = null } = {}) {
  // Caso A: gramínea de género de catálogo de sistema identificado -> MEDIA.
  if (alcance === 'sistema' && esGeneroGramineaSistema(genero)) {
    return { estado: 'OK', policy: { ...OCCUPATION_POLICY_V1, confidence: 'MEDIA' } };
  }

  // Caso C: leguminosa (por género conocido o por tipo declarado) -> bloqueado.
  if (esGeneroLeguminosa(genero) || tipo === 'leguminosa') {
    return { estado: ESTADO_PASTURA_SIN_POLITICA, policy: null };
  }

  // Caso B: personalizada (o sistema sin género reconocido) declarada graminea -> BAJA.
  if (tipo === 'graminea') {
    return { estado: 'OK', policy: { ...OCCUPATION_POLICY_V1, confidence: 'BAJA' } };
  }

  // Caso D/E: mezcla.
  if (tipo === 'mezcla') {
    if (esGeneroGramineaSistema(generoDominante)) {
      return { estado: 'OK', policy: { ...OCCUPATION_POLICY_V1, confidence: 'MEDIA' } };
    }
    return { estado: ESTADO_PASTURA_SIN_POLITICA, policy: null };
  }

  // tipo='otra' o desconocido -> bloqueado, nunca un fallback inventado.
  return { estado: ESTADO_PASTURA_SIN_POLITICA, policy: null };
}

// -----------------------------------------------------------------------
// SS8 -- Contrato de input invalido. Estas funciones son la PRIMERA capa
// que recibe MSU/DI ya resueltos -- un valor no finito/no positivo aqui
// es un error de programacion/orquestacion upstream, NUNCA un resultado
// de negocio valido. Se lanza una excepcion (nunca se devuelve como
// 'estado') para no esconder el defecto detras de
// NO_RECOMMENDATION_INSUFFICIENT_FORAGE -- mismo criterio que
// CALCULATION_UNAVAILABLE en potreroRecomendacionPastoreoRepository.js
// (un guardrail que "nunca deberia activarse" con inputs validos, pero
// que jamas debe fallar en silencio si el upstream tiene un bug).
// -----------------------------------------------------------------------
function assertNumeroFinitoPositivo(valor, nombreCampo) {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor <= 0) {
    throw Object.assign(
      new Error(`${nombreCampo} debe ser un numero finito positivo (recibido: ${String(valor)}).`),
      { code: 'INPUT_INVALID', field: nombreCampo },
    );
  }
}

function assertOccupationPolicyValida(occupationPolicy) {
  if (!occupationPolicy || typeof occupationPolicy !== 'object') {
    throw Object.assign(new Error('occupationPolicy es obligatorio.'), { code: 'INPUT_INVALID', field: 'occupationPolicy' });
  }
  assertNumeroFinitoPositivo(occupationPolicy.targetDays, 'occupationPolicy.targetDays');
  assertNumeroFinitoPositivo(occupationPolicy.minDays, 'occupationPolicy.minDays');
}

function construirResultadoAutomaticoOk({
  numeroAnimalesRaw, numeroAnimalesRecomendado, diasPermanenciaRecomendada, motivoDuracion,
  materiaSecaTotalKg, materiaSecaUtilizableKg, demandaIndividualKgMsDia, occupationPolicy,
}) {
  const consumoOperativoKg = demandaIndividualKgMsDia * numeroAnimalesRecomendado * diasPermanenciaRecomendada;
  return {
    estado: 'OK',
    numeroAnimalesRaw,
    numeroAnimalesRecomendado,
    diasPermanenciaRecomendada,
    motivoDuracion,
    consumoOperativoKg,
    remanenteOperativoKg: materiaSecaTotalKg - consumoOperativoKg,
    margenForrajeKg: materiaSecaUtilizableKg - consumoOperativoKg,
    diasMaximosSoportadosExactos: materiaSecaUtilizableKg / (demandaIndividualKgMsDia * numeroAnimalesRecomendado),
    occupationPolicy,
  };
}

function construirResultadoInsuficiente(occupationPolicy) {
  return {
    estado: 'NO_RECOMMENDATION_INSUFFICIENT_FORAGE',
    numeroAnimalesRaw: null,
    numeroAnimalesRecomendado: null,
    diasPermanenciaRecomendada: null,
    motivoDuracion: null,
    consumoOperativoKg: null,
    remanenteOperativoKg: null,
    margenForrajeKg: null,
    diasMaximosSoportadosExactos: null,
    occupationPolicy,
  };
}

/**
 * computeCargaRecomendadaAutomatica -- SS5/SS6 del sprint (algoritmo final
 * 3D10.2.4/3D10.3). Recibe MSU/DI/occupationPolicy YA resueltos -- no
 * consulta DB, no llama agroclima, no conoce HTTP.
 *
 * targetDays gobierna la rama normal; minDays SOLO se usa como fallback
 * de bajo forraje; maxDays nunca crea una rama (vive solo en
 * occupationPolicy, como metadata).
 */
export function computeCargaRecomendadaAutomatica({
  materiaSecaTotalKg,
  materiaSecaUtilizableKg,
  demandaIndividualKgMsDia,
  occupationPolicy,
}) {
  assertNumeroFinitoPositivo(materiaSecaTotalKg, 'materiaSecaTotalKg');
  assertNumeroFinitoPositivo(materiaSecaUtilizableKg, 'materiaSecaUtilizableKg');
  assertNumeroFinitoPositivo(demandaIndividualKgMsDia, 'demandaIndividualKgMsDia');
  assertOccupationPolicyValida(occupationPolicy);

  const { targetDays, minDays } = occupationPolicy;
  const MSU = materiaSecaUtilizableKg;
  const DI = demandaIndividualKgMsDia;

  const numeroAnimalesRawTarget = MSU / (DI * targetDays);
  if (Math.floor(numeroAnimalesRawTarget) >= 1) {
    return construirResultadoAutomaticoOk({
      numeroAnimalesRaw: numeroAnimalesRawTarget,
      numeroAnimalesRecomendado: Math.floor(numeroAnimalesRawTarget),
      diasPermanenciaRecomendada: targetDays,
      motivoDuracion: 'TARGET_3_DAYS',
      materiaSecaTotalKg, materiaSecaUtilizableKg, demandaIndividualKgMsDia, occupationPolicy,
    });
  }

  // Fallback SS6: solo se evalua si target no alcanza ni para 1 animal.
  const numeroAnimalesRawFallback = MSU / (DI * minDays);
  if (Math.floor(numeroAnimalesRawFallback) >= 1) {
    return construirResultadoAutomaticoOk({
      numeroAnimalesRaw: numeroAnimalesRawFallback,
      numeroAnimalesRecomendado: Math.floor(numeroAnimalesRawFallback),
      diasPermanenciaRecomendada: minDays,
      motivoDuracion: 'FALLBACK_MIN_2_DAYS',
      materiaSecaTotalKg, materiaSecaUtilizableKg, demandaIndividualKgMsDia, occupationPolicy,
    });
  }

  return construirResultadoInsuficiente(occupationPolicy);
}

// -----------------------------------------------------------------------
// SS9/SS10/SS11 -- Override puro del escenario del usuario. `maximo` es
// CAPACIDAD FISICA DIAGNOSTICA, nunca duracion de plan -- explicitamente
// prohibido: floor(maximo) como dias, clamp(maximo,2,4), o tratar
// maximo>4 como "ocupacion prolongada". La duracion del escenario sale
// EXCLUSIVAMENTE de comparar `maximo` contra los dos umbrales de politica
// (targetDays, minDays), nunca de redondear `maximo` en si.
// -----------------------------------------------------------------------
export function evaluarEscenarioUsuario({
  materiaSecaTotalKg,
  materiaSecaUtilizableKg,
  demandaIndividualKgMsDia,
  numeroAnimalesUsuario,
  occupationPolicy,
}) {
  assertNumeroFinitoPositivo(materiaSecaTotalKg, 'materiaSecaTotalKg');
  assertNumeroFinitoPositivo(materiaSecaUtilizableKg, 'materiaSecaUtilizableKg');
  assertNumeroFinitoPositivo(demandaIndividualKgMsDia, 'demandaIndividualKgMsDia');
  assertNumeroFinitoPositivo(numeroAnimalesUsuario, 'numeroAnimalesUsuario');
  assertOccupationPolicyValida(occupationPolicy);

  const { targetDays, minDays } = occupationPolicy;
  const MSU = materiaSecaUtilizableKg;
  const DI = demandaIndividualKgMsDia;
  const maximo = MSU / (DI * numeroAnimalesUsuario);

  let diasPermanenciaEscenario = null;
  let clasificacionEscenario;
  let confirmable;

  if (maximo >= targetDays) {
    diasPermanenciaEscenario = targetDays;
    clasificacionEscenario = 'TARGET_COMPATIBLE';
    confirmable = true;
  } else if (maximo >= minDays) {
    diasPermanenciaEscenario = minDays;
    clasificacionEscenario = 'MINIMUM_COMPATIBLE';
    confirmable = true;
  } else {
    clasificacionEscenario = 'INSUFFICIENT_FORAGE';
    confirmable = false;
  }

  const consumoEscenarioKg = confirmable ? DI * numeroAnimalesUsuario * diasPermanenciaEscenario : null;

  return {
    numeroAnimalesUsuario,
    diasMaximosSoportadosExactos: maximo,
    diasPermanenciaEscenario,
    consumoEscenarioKg,
    remanenteEscenarioKg: confirmable ? materiaSecaTotalKg - consumoEscenarioKg : null,
    margenForrajeEscenarioKg: confirmable ? MSU - consumoEscenarioKg : null,
    clasificacionEscenario,
    confirmable,
  };
}
