// FASE 4D -- analítica reproductiva (modelo PURO: sin base de datos ni reloj).
// Recibe el historial ACTIVO de cada hembra (una sola lectura en
// reproduccionAnaliticaRepository.js) y lo pliega en orden (fechaEvento,
// eventoId) -- mismo orden que reproduccionEstado.js. Los ciclos son máquinas
// secuenciales, así que viven aquí y no duplicados en SQL.
//
// El periodo solo decide en qué ventana cae cada resultado: para clasificar se
// usa TODO el historial hasta hoy. Nada se excluye en silencio: cada caso fuera
// de un indicador queda contado en M14. M6 y M11 están aplazadas.
//
// Intento de servicio (M2, M3, M4):
//   - servicios no LIBRE separados por 0 o 1 día, sin resolución entre ellos:
//     mismo intento; se asigna por la fecha de su primer servicio;
//   - monta LIBRE: MONTA_LIBRE, fuera del denominador;
//   - siguiente evento (CELO y DUDOSA no resuelven):
//       monta LIBRE                -> NO_ATRIBUIBLE
//       servicio a 2-16 días       -> NO_ATRIBUIBLE
//       servicio a >= 17 días      -> NO_CONCEPCION
//       diagnóstico VACIA          -> NO_CONCEPCION
//       PRENADA/ABORTO con días    -> CONCEPCION si la concepción estimada cae a
//                                     +-21 días del servicio; si no, NO_ATRIBUIBLE
//       PRENADA sin días           -> CONCEPCION
//       ABORTO sin días            -> CONCEPCION a <= 310 días; si no, NO_ATRIBUIBLE
//       PARTO                      -> CONCEPCION a 240-310 días; si no, NO_ATRIBUIBLE
//       ninguno                    -> PENDIENTE
//   - M3 toma siempre el primer intento del episodio (posterior al último
//     PARTO/ABORTO). Sin parto o aborto de apertura registrado y sin ser
//     NACIDO_EN_PREDIO: INICIO_CICLO_DESCONOCIDO (fuera de M3, sí en M2).
//
// Días abiertos (M8): de cada PARTO a la concepción vigente, en la ventana hasta
// el siguiente PARTO (un ABORTO no la cierra). Vigente = último PRENADA sin VACIA
// ni ABORTO posterior en la ventana. Fecha: diagnóstico - días o, sin días, el
// servicio del ciclo (TE - 7). Sin PRENADA pero con parto de cierre: último
// servicio del ciclo a 240-310 días de ese parto.
//
// Pérdida posterior a preñez confirmada (M12): gestación abierta por el primer
// PRENADA. DUDOSA es transparente, igual que en la máquina de estados: no abre,
// no cierra ni rompe la atribución. Resolución: VACIA o ABORTO -> PERDIDA;
// PARTO -> TERMINO; servicio o celo -> NO_ATRIBUIBLE; VACIA en la misma fecha del
// PRENADA -> NO_ATRIBUIBLE (rectificación).
import { badRequest, CONFIGURACION_ALERTAS_REPRODUCCION, predioParam, rejectUnknown } from './reproduccionAlertas.js';
import { compararEventos, diasEntre, EDAD_EMBRION_TRANSFERENCIA_DIAS, sumarDias, TIPOS_SERVICIO } from './reproduccionEstado.js';

/**
 * UMBRALES PROVISIONALES CONFIGURABLES de plausibilidad y calidad de datos.
 * Son una regla ANALÍTICA para decidir si una secuencia registrada es
 * interpretable: no son una regla clínica, productiva ni una recomendación
 * veterinaria. No hay configuración por organización todavía.
 */
export const CONFIGURACION_CALIDAD_REPRODUCCION = Object.freeze({
  mismoIntentoMaxDias: 1,
  retornoServicioMinDias: 17,
  toleranciaConcepcionDias: 21,
  servicioPartoMinDias: 240,
  servicioPartoMaxDias: 310,
  intervaloPartosMinDias: 300,
  intervaloPartosMaxDias: 900,
  partoConcepcionMinDias: 20,
});

export const MUESTRA_MINIMA_ANALITICA = 10;

/**
 * Salvaguarda operativa de memoria y event loop: el motor materializa y pliega
 * todo el historial en el proceso principal. No es una regla de negocio.
 */
export const CONFIGURACION_ANALITICA_REPRODUCCION = Object.freeze({
  maxEventosProcesables: 100_000,
  maxConcurrentes: 1,
  reintentarTrasSegundos: 2,
});

export const CODIGO_VOLUMEN_ANALITICA = 'ANALITICA_VOLUMEN_EXCEDIDO';
export const MENSAJE_VOLUMEN_ANALITICA = 'La analítica contiene demasiados eventos para procesarse en una sola consulta. Reduce el alcance por predio o contacta al administrador.';

/** Error funcional sin conteos ni detalles internos. */
export function errorVolumenAnalitica() {
  return Object.assign(new Error(MENSAJE_VOLUMEN_ANALITICA), { status: 422, code: CODIGO_VOLUMEN_ANALITICA });
}

export const CODIGO_ANALITICA_OCUPADA = 'ANALITICA_OCUPADA';
export const MENSAJE_ANALITICA_OCUPADA = 'Hay una analítica reproductiva en proceso. Intenta nuevamente en unos segundos.';

/**
 * Semáforo en memoria del proceso (1 réplica), sin cola: `adquirir()` devuelve
 * la función de liberación (idempotente) o null si ya está al máximo.
 */
export function crearSemaforoAnalitica(maximo = CONFIGURACION_ANALITICA_REPRODUCCION.maxConcurrentes) {
  let enCurso = 0;
  return {
    adquirir() {
      if (enCurso >= maximo) return null;
      enCurso += 1;
      let liberado = false;
      return () => {
        if (liberado) return;
        liberado = true;
        enCurso -= 1;
      };
    },
    get enCurso() {
      return enCurso;
    },
  };
}

export const ESTADOS_INDICADOR = Object.freeze({
  OK: 'OK',
  DATOS_INSUFICIENTES: 'DATOS_INSUFICIENTES',
  NO_CALCULABLE: 'NO_CALCULABLE',
});

const DIAS_POR_MES = 30.4375;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const ANALITICA_KEYS = new Set(['predioId', 'desde', 'hasta']);
const INTERVENCION = new Set(['ASISTIDO', 'CESAREA']);

const esServicio = (e) => TIPOS_SERVICIO.includes(e.tipoEvento);
const esLibre = (e) => e.tipoEvento === 'SERVICIO_MONTA' && e.tipoServicio === 'LIBRE';
const esDiagnostico = (e, resultado) => e.tipoEvento === 'DIAGNOSTICO_PRENEZ' && e.diagnosticoResultado === resultado;
const esCierre = (e) => e.tipoEvento === 'PARTO' || e.tipoEvento === 'ABORTO';
const tieneDias = (e) => Number(e.diasGestacion) > 0;
const referenciaServicio = (e) => (e.tipoEvento === 'TRANSFERENCIA_EMBRION' ? sumarDias(e.fechaEvento, -EDAD_EMBRION_TRANSFERENCIA_DIAS) : e.fechaEvento);

function fechaParam(raw, field) {
  const fecha = RE_FECHA.test(raw) ? new Date(`${raw}T00:00:00Z`) : null;
  if (!fecha || Number.isNaN(fecha.getTime()) || fecha.toISOString().slice(0, 10) !== raw) {
    throw badRequest(`${field} debe ser una fecha válida (AAAA-MM-DD).`);
  }
  return raw;
}

/** Ventana móvil de 12 meses terminada en `hasta`, inclusive (no meses cerrados). */
export function periodoPorDefecto(hasta) {
  const [y, m, d] = hasta.split('-').map(Number);
  const ultimoDia = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  const base = new Date(Date.UTC(y - 1, m - 1, Math.min(d, ultimoDia))).toISOString().slice(0, 10);
  return { desde: sumarDias(base, 1), hasta };
}

/** GET /api/ganaderia/reproduccion/analitica?predioId&desde&hasta */
export function validateAnaliticaQuery(query, { hoy }) {
  rejectUnknown(query, ANALITICA_KEYS);
  const hasta = query?.hasta ? fechaParam(query.hasta, 'hasta') : hoy;
  if (hasta > hoy) throw badRequest('hasta no puede ser posterior a hoy.');
  const desde = query?.desde ? fechaParam(query.desde, 'desde') : periodoPorDefecto(hasta).desde;
  if (desde > hasta) throw badRequest('desde no puede ser posterior a hasta.');
  if (desde < '1990-01-01') throw badRequest('desde no puede ser anterior a 1990-01-01.');
  return { predioId: predioParam(query?.predioId), desde, hasta };
}

// ---------------------------------------------------------------------------
// Plegado por hembra
// ---------------------------------------------------------------------------

/** Último servicio del ciclo antes de `indice` (posterior al último parto/aborto). */
function servicioDelCiclo(eventos, indice) {
  for (let i = indice - 1; i >= 0; i -= 1) {
    if (esCierre(eventos[i])) return null;
    if (esServicio(eventos[i])) return eventos[i];
  }
  return null;
}

/** Concepción de un diagnóstico PRENADA: misma regla que la gestación de 4C. */
function concepcionDeDiagnostico(eventos, indice) {
  const diagnostico = eventos[indice];
  if (tieneDias(diagnostico)) return { fecha: sumarDias(diagnostico.fechaEvento, -diagnostico.diasGestacion) };
  const servicio = servicioDelCiclo(eventos, indice);
  if (!servicio) return null;
  return esLibre(servicio) ? { libre: true } : { fecha: referenciaServicio(servicio) };
}

function construirIntentos(eventos, hembra, config) {
  const intentos = [];
  let candidato = null; // intento que aún admite otro servicio del mismo celo
  let huboCierre = false;
  let intentoEnEpisodio = false;
  const inicioPropio = hembra.origenTipo === 'NACIDO_EN_PREDIO';

  eventos.forEach((e, indice) => {
    if (esServicio(e)) {
      const libre = esLibre(e);
      if (!libre && candidato && diasEntre(candidato.ultimaFecha, e.fechaEvento) <= config.mismoIntentoMaxDias) {
        candidato.ultimaFecha = e.fechaEvento;
        candidato.ultimoIndice = indice;
        return;
      }
      const intento = {
        fecha: e.fechaEvento,
        tipo: e.tipoEvento,
        referencia: referenciaServicio(e),
        libre,
        ultimaFecha: e.fechaEvento,
        ultimoIndice: indice,
        primeroEpisodio: !intentoEnEpisodio,
        inicioConocido: huboCierre || inicioPropio,
      };
      intentos.push(intento);
      intentoEnEpisodio = true;
      candidato = libre ? null : intento;
      return;
    }
    if (esCierre(e)) {
      huboCierre = true;
      intentoEnEpisodio = false;
      candidato = null;
    } else if (esDiagnostico(e, 'PRENADA') || esDiagnostico(e, 'VACIA')) {
      candidato = null;
    }
  });
  return intentos;
}

function clasificarIntento(intento, eventos, config) {
  if (intento.libre) return { resultado: 'MONTA_LIBRE', motivo: null };
  const concepcionPlausible = (e) => Math.abs(diasEntre(intento.referencia, sumarDias(e.fechaEvento, -e.diasGestacion))) <= config.toleranciaConcepcionDias;

  for (let i = intento.ultimoIndice + 1; i < eventos.length; i += 1) {
    const e = eventos[i];
    if (esServicio(e)) {
      if (esLibre(e)) return { resultado: 'NO_ATRIBUIBLE', motivo: 'MONTA_LIBRE_POSTERIOR' };
      return diasEntre(intento.ultimaFecha, e.fechaEvento) >= config.retornoServicioMinDias
        ? { resultado: 'NO_CONCEPCION', motivo: null }
        : { resultado: 'NO_ATRIBUIBLE', motivo: 'RETORNO_NO_PLAUSIBLE' };
    }
    if (esDiagnostico(e, 'VACIA')) return { resultado: 'NO_CONCEPCION', motivo: null };
    if (esDiagnostico(e, 'PRENADA') || e.tipoEvento === 'ABORTO') {
      if (tieneDias(e)) {
        return concepcionPlausible(e)
          ? { resultado: 'CONCEPCION', motivo: null }
          : { resultado: 'NO_ATRIBUIBLE', motivo: 'CONCEPCION_FUERA_DE_TOLERANCIA' };
      }
      if (e.tipoEvento === 'ABORTO' && diasEntre(intento.referencia, e.fechaEvento) > config.servicioPartoMaxDias) {
        return { resultado: 'NO_ATRIBUIBLE', motivo: 'SERVICIO_ABORTO_FUERA_DE_RANGO' };
      }
      return { resultado: 'CONCEPCION', motivo: null };
    }
    if (e.tipoEvento === 'PARTO') {
      const dias = diasEntre(intento.referencia, e.fechaEvento);
      return dias >= config.servicioPartoMinDias && dias <= config.servicioPartoMaxDias
        ? { resultado: 'CONCEPCION', motivo: null }
        : { resultado: 'NO_ATRIBUIBLE', motivo: 'SERVICIO_PARTO_FUERA_DE_RANGO' };
    }
  }
  return { resultado: 'PENDIENTE', motivo: null };
}

function plegarDiasAbiertos(eventos, hembra, { hoy, config }) {
  const casos = [];
  let abierta = null;
  const partos = eventos.map((e, i) => (e.tipoEvento === 'PARTO' ? i : -1)).filter((i) => i >= 0);

  partos.forEach((indiceParto, posicion) => {
    const parto = eventos[indiceParto];
    const indiceCierre = partos[posicion + 1] ?? null;
    const partoCierre = indiceCierre === null ? null : eventos[indiceCierre];
    const limite = indiceCierre ?? eventos.length;

    let vigente = null;
    for (let i = indiceParto + 1; i < limite; i += 1) {
      if (esDiagnostico(eventos[i], 'PRENADA')) vigente = i;
      else if (esDiagnostico(eventos[i], 'VACIA') || eventos[i].tipoEvento === 'ABORTO') vigente = null;
    }

    if (vigente === null && !partoCierre) {
      if (hembra.estadoOperativo === 'EN_HATO') abierta = { dias: diasEntre(parto.fechaEvento, hoy) };
      else casos.push({ fecha: parto.fechaEvento, resultado: 'CENSURADA_CERRADA' });
      return;
    }

    let concepcion;
    if (vigente !== null) {
      concepcion = concepcionDeDiagnostico(eventos, vigente);
    } else {
      const servicio = servicioDelCiclo(eventos, indiceCierre);
      if (servicio && esLibre(servicio)) {
        concepcion = { libre: true };
      } else if (servicio) {
        const dias = diasEntre(referenciaServicio(servicio), partoCierre.fechaEvento);
        concepcion = dias >= config.servicioPartoMinDias && dias <= config.servicioPartoMaxDias ? { fecha: referenciaServicio(servicio) } : null;
      } else {
        concepcion = null;
      }
    }

    if (!concepcion) {
      casos.push({ fecha: parto.fechaEvento, resultado: 'SIN_BASE' });
    } else if (concepcion.libre) {
      casos.push({ fecha: parto.fechaEvento, resultado: 'NO_ATRIBUIBLE' });
    } else {
      const dias = diasEntre(parto.fechaEvento, concepcion.fecha);
      const hastaCierre = partoCierre ? diasEntre(concepcion.fecha, partoCierre.fechaEvento) : null;
      const atipico = dias < config.partoConcepcionMinDias
        || (hastaCierre !== null && (hastaCierre < config.servicioPartoMinDias || hastaCierre > config.servicioPartoMaxDias));
      casos.push({ fecha: concepcion.fecha, resultado: atipico ? 'ATIPICO' : 'VALIDO', dias });
    }
  });
  return { casos, abierta };
}

function plegarGestaciones(eventos, hembra, config) {
  const gestaciones = [];
  let abierta = null;
  const cerrar = (fecha, resultado) => {
    gestaciones.push({ fecha, resultado, conDudosa: abierta.conDudosa });
    abierta = null;
  };

  eventos.forEach((e, indice) => {
    if (esDiagnostico(e, 'PRENADA')) {
      if (abierta) abierta.ultimoIndice = indice;
      else abierta = { primeraFecha: e.fechaEvento, ultimoIndice: indice, conDudosa: false };
      return;
    }
    if (!abierta) return;
    if (esDiagnostico(e, 'DUDOSA')) {
      abierta.conDudosa = true;
    } else if (esDiagnostico(e, 'VACIA')) {
      cerrar(e.fechaEvento, e.fechaEvento === eventos[abierta.ultimoIndice].fechaEvento ? 'NO_ATRIBUIBLE' : 'PERDIDA');
    } else if (e.tipoEvento === 'ABORTO') {
      cerrar(e.fechaEvento, 'PERDIDA');
    } else if (e.tipoEvento === 'PARTO') {
      const concepcion = concepcionDeDiagnostico(eventos, abierta.ultimoIndice);
      const dias = concepcion?.fecha ? diasEntre(concepcion.fecha, e.fechaEvento) : null;
      const atipico = dias !== null && (dias < config.servicioPartoMinDias || dias > config.servicioPartoMaxDias);
      cerrar(e.fechaEvento, atipico ? 'ATIPICO' : 'TERMINO');
    } else {
      cerrar(e.fechaEvento, 'NO_ATRIBUIBLE'); // servicio o celo sobre una preñez confirmada
    }
  });

  if (abierta) {
    gestaciones.push({
      fecha: abierta.primeraFecha,
      resultado: hembra.estadoOperativo === 'EN_HATO' ? 'EN_CURSO' : 'CENSURADA_CERRADA',
      conDudosa: abierta.conDudosa,
    });
  }
  return gestaciones;
}

function plegarDiagnosticos(eventos) {
  const diagnosticos = [];
  let ultimoConcluyente = null;
  for (const e of eventos) {
    if (esServicio(e) || esCierre(e)) {
      ultimoConcluyente = null;
    } else if (e.tipoEvento === 'DIAGNOSTICO_PRENEZ') {
      const resultado = e.diagnosticoResultado;
      if (resultado === 'DUDOSA') {
        diagnosticos.push({ fecha: e.fechaEvento, resultado });
      } else {
        diagnosticos.push({ fecha: e.fechaEvento, resultado, repetido: resultado === ultimoConcluyente });
        ultimoConcluyente = resultado;
      }
    }
  }
  return diagnosticos;
}

function plegarEdades(eventos, hembra) {
  const edad = (fecha) => Math.round((diasEntre(hembra.fechaNacimiento, fecha) / DIAS_POR_MES) * 10) / 10;
  let exclusion = null;
  if (hembra.origenTipo !== 'NACIDO_EN_PREDIO') exclusion = 'ORIGEN_NO_ELEGIBLE';
  else if (hembra.nacimientoTipo !== 'EXACTA' || !hembra.fechaNacimiento) exclusion = 'NACIMIENTO_NO_EXACTO';

  const caso = (evento, exclusionEvento) => {
    if (!evento) return null;
    const motivo = exclusion ?? exclusionEvento;
    return motivo ? { fecha: evento.fechaEvento, excluido: motivo } : { fecha: evento.fechaEvento, meses: edad(evento.fechaEvento) };
  };
  const primerServicio = eventos.find(esServicio);
  return {
    primerServicio: caso(primerServicio, primerServicio && esLibre(primerServicio) ? 'SERVICIO_LIBRE' : null),
    primerParto: caso(eventos.find((e) => e.tipoEvento === 'PARTO'), null),
  };
}

/** Pliega el historial de una hembra en casos por métrica (sin agregar). */
export function analizarHembra(hembra, { hoy, config = CONFIGURACION_CALIDAD_REPRODUCCION }) {
  const eventos = (hembra.eventos ?? []).filter((e) => e.estadoRegistro === undefined || e.estadoRegistro === 'ACTIVO').sort(compararEventos);
  const cerrada = hembra.estadoOperativo !== 'EN_HATO';

  const intentos = construirIntentos(eventos, hembra, config).map((intento) => {
    const { resultado, motivo } = clasificarIntento(intento, eventos, config);
    return {
      fecha: intento.fecha,
      tipo: intento.tipo,
      resultado,
      motivo,
      primeroEpisodio: intento.primeroEpisodio,
      inicioConocido: intento.inicioConocido,
      pendienteVencido: resultado === 'PENDIENTE' && diasEntre(intento.ultimaFecha, hoy) >= CONFIGURACION_ALERTAS_REPRODUCCION.diasDiagnosticoPendiente,
      cerrada,
    };
  });

  const partos = eventos.filter((e) => e.tipoEvento === 'PARTO');
  const intervalos = partos.slice(1).map((parto, i) => {
    const dias = diasEntre(partos[i].fechaEvento, parto.fechaEvento);
    return { fecha: parto.fechaEvento, dias, atipico: dias < config.intervaloPartosMinDias || dias > config.intervaloPartosMaxDias };
  });

  const partoServicio = [];
  eventos.forEach((e, indice) => {
    if (e.tipoEvento !== 'PARTO') return;
    for (let i = indice + 1; i < eventos.length && eventos[i].tipoEvento !== 'PARTO'; i += 1) {
      if (esServicio(eventos[i])) {
        partoServicio.push(esLibre(eventos[i])
          ? { fecha: eventos[i].fechaEvento, excluido: 'SERVICIO_LIBRE' }
          : { fecha: eventos[i].fechaEvento, dias: diasEntre(e.fechaEvento, eventos[i].fechaEvento) });
        return;
      }
    }
  });

  const prenadas = [];
  eventos.forEach((e, indice) => {
    if (!esDiagnostico(e, 'PRENADA')) return;
    const sinServicio = !servicioDelCiclo(eventos, indice);
    prenadas.push({ fecha: e.fechaEvento, sinServicio, sinBase: sinServicio && !tieneDias(e) });
  });

  return {
    servicios: eventos.filter(esServicio).map((e) => ({ fecha: e.fechaEvento, tipo: e.tipoEvento, libre: esLibre(e) })),
    intentos,
    diagnosticos: plegarDiagnosticos(eventos),
    intervalos,
    diasAbiertos: plegarDiasAbiertos(eventos, hembra, { hoy, config }),
    partoServicio,
    edades: plegarEdades(eventos, hembra),
    gestaciones: plegarGestaciones(eventos, hembra, config),
    partos: partos.map((e) => ({ fecha: e.fechaEvento, partoTipo: e.partoTipo, numeroCrias: Number(e.numeroCrias) || 0 })),
    prenadas,
  };
}

// ---------------------------------------------------------------------------
// Agregación
// ---------------------------------------------------------------------------

const redondear = (valor) => Math.round(valor * 10) / 10;
const porcentaje = (parte, total) => (total > 0 ? redondear((parte / total) * 100) : null);

/** Percentil continuo (interpolación lineal, equivalente a percentile_cont). */
export function percentil(ordenados, p) {
  if (!ordenados.length) return null;
  const posicion = (ordenados.length - 1) * p;
  const base = Math.floor(posicion);
  const siguiente = ordenados[base + 1];
  return redondear(siguiente === undefined ? ordenados[base] : ordenados[base] + (siguiente - ordenados[base]) * (posicion - base));
}

/** n < muestra mínima: conteos sí, indicador agregado no. */
export function indicador(n, valor) {
  if (n < MUESTRA_MINIMA_ANALITICA) return { estado: ESTADOS_INDICADOR.DATOS_INSUFICIENTES, valor: null };
  if (valor === null) return { estado: ESTADOS_INDICADOR.NO_CALCULABLE, valor: null };
  return { estado: ESTADOS_INDICADOR.OK, valor };
}

function estadistica(valores) {
  const ordenados = [...valores].sort((a, b) => a - b);
  const n = ordenados.length;
  const suficiente = n >= MUESTRA_MINIMA_ANALITICA;
  return {
    n,
    estado: suficiente ? ESTADOS_INDICADOR.OK : ESTADOS_INDICADOR.DATOS_INSUFICIENTES,
    mediana: suficiente ? percentil(ordenados, 0.5) : null,
    p25: suficiente ? percentil(ordenados, 0.25) : null,
    p75: suficiente ? percentil(ordenados, 0.75) : null,
  };
}

function contar(lista, predicado) {
  return lista.reduce((total, item) => total + (predicado(item) ? 1 : 0), 0);
}

function conteosIntentos(intentos) {
  const concepciones = contar(intentos, (i) => i.resultado === 'CONCEPCION');
  const noConcepciones = contar(intentos, (i) => i.resultado === 'NO_CONCEPCION');
  return {
    totalIntentos: intentos.length,
    concepciones,
    noConcepciones,
    pendientes: contar(intentos, (i) => i.resultado === 'PENDIENTE'),
    noAtribuibles: contar(intentos, (i) => i.resultado === 'NO_ATRIBUIBLE'),
    montaLibre: contar(intentos, (i) => i.resultado === 'MONTA_LIBRE'),
    nEvaluable: concepciones + noConcepciones,
  };
}

function metricaConcepcion(intentos, valorDe) {
  const resumen = (lista) => {
    const conteos = conteosIntentos(lista);
    return {
      ...conteos,
      cobertura: porcentaje(conteos.nEvaluable, conteos.totalIntentos),
      indicador: indicador(conteos.nEvaluable, valorDe(conteos)),
    };
  };
  const porTipo = {};
  for (const tipo of TIPOS_SERVICIO) {
    const lista = intentos.filter((i) => i.tipo === tipo);
    if (lista.length) porTipo[tipo] = resumen(lista);
  }
  return { ...resumen(intentos), porTipo };
}

const tasaConcepcion = ({ concepciones, nEvaluable }) => porcentaje(concepciones, nEvaluable);
const serviciosPorConcepcion = ({ concepciones, nEvaluable }) => (concepciones > 0 ? Math.round((nEvaluable / concepciones) * 100) / 100 : null);

/** Agrega las hembras plegadas en las métricas del periodo y M14. */
export function agregarMetricas(hembras, { desde, hasta, hoy, config = CONFIGURACION_CALIDAD_REPRODUCCION }) {
  const enPeriodo = (item) => item && item.fecha >= desde && item.fecha <= hasta;
  const casos = hembras.map((h) => ({ hembra: h, ...analizarHembra(h, { hoy, config }) }));
  const reunir = (selector) => casos.flatMap(selector).filter(enPeriodo);

  const servicios = reunir((c) => c.servicios);
  const intentos = reunir((c) => c.intentos);
  const primeros = intentos.filter((i) => i.primeroEpisodio);
  const inicioDesconocido = primeros.filter((i) => !i.inicioConocido);
  const primerosConocidos = primeros.filter((i) => i.inicioConocido);
  const diagnosticos = reunir((c) => c.diagnosticos);
  const intervalos = reunir((c) => c.intervalos);
  const diasAbiertos = reunir((c) => c.diasAbiertos.casos);
  const abiertasHoy = casos.map((c) => c.diasAbiertos.abierta).filter(Boolean);
  const partoServicio = reunir((c) => c.partoServicio);
  const edadServicio = reunir((c) => [c.edades.primerServicio]);
  const edadParto = reunir((c) => [c.edades.primerParto]);
  // Gestaciones en curso: foto de hoy, independiente del periodo.
  const todasGestaciones = casos.flatMap((c) => c.gestaciones);
  const gestaciones = todasGestaciones.filter((g) => g.resultado !== 'EN_CURSO' && enPeriodo(g));
  const partos = reunir((c) => c.partos);
  const prenadas = reunir((c) => c.prenadas);

  const porTipoServicio = {};
  for (const tipo of TIPOS_SERVICIO) porTipoServicio[tipo] = contar(servicios, (s) => s.tipo === tipo);

  const m3 = metricaConcepcion(primerosConocidos, tasaConcepcion);
  const m3Total = m3.totalIntentos + inicioDesconocido.length;

  const positivos = contar(diagnosticos, (d) => d.resultado === 'PRENADA' && !d.repetido);
  const negativos = contar(diagnosticos, (d) => d.resultado === 'VACIA' && !d.repetido);
  const dudosas = contar(diagnosticos, (d) => d.resultado === 'DUDOSA');
  const repeticiones = contar(diagnosticos, (d) => d.repetido);
  const nDiagnosticos = positivos + negativos;

  const intervalosValidos = intervalos.filter((i) => !i.atipico).map((i) => i.dias);
  const intervalosAtipicos = intervalos.length - intervalosValidos.length;

  const abiertosValidos = diasAbiertos.filter((c) => c.resultado === 'VALIDO').map((c) => c.dias);
  const conteoAbiertos = (resultado) => contar(diasAbiertos, (c) => c.resultado === resultado);

  const partoServicioValidos = partoServicio.filter((c) => !c.excluido).map((c) => c.dias);

  const metricaEdad = (lista) => ({
    ...estadistica(lista.filter((c) => !c.excluido).map((c) => c.meses)),
    excluidos: lista.filter((c) => c.excluido).length,
    cobertura: porcentaje(lista.filter((c) => !c.excluido).length, lista.length),
  });

  const conteoGestaciones = (resultado) => contar(gestaciones, (g) => g.resultado === resultado);
  const perdidas = conteoGestaciones('PERDIDA');
  const terminos = conteoGestaciones('TERMINO');
  const nGestaciones = perdidas + terminos;
  const noAtribuiblesGestacion = conteoGestaciones('NO_ATRIBUIBLE');
  const atipicosGestacion = conteoGestaciones('ATIPICO');
  const enCurso = contar(todasGestaciones, (g) => g.resultado === 'EN_CURSO');

  const partosPorTipo = {};
  for (const parto of partos) partosPorTipo[parto.partoTipo] = (partosPorTipo[parto.partoTipo] ?? 0) + 1;
  const conIntervencion = contar(partos, (p) => INTERVENCION.has(p.partoTipo));

  const motivoIntento = (motivo) => contar(intentos, (i) => i.motivo === motivo);
  const motivoEdad = (lista, motivo) => contar(lista, (c) => c.excluido === motivo);
  const conteoCalidad = {
    'M2-M4': {
      MONTA_LIBRE: contar(intentos, (i) => i.resultado === 'MONTA_LIBRE'),
      MONTA_LIBRE_POSTERIOR: motivoIntento('MONTA_LIBRE_POSTERIOR'),
      RETORNO_NO_PLAUSIBLE: motivoIntento('RETORNO_NO_PLAUSIBLE'),
      CONCEPCION_FUERA_DE_TOLERANCIA: motivoIntento('CONCEPCION_FUERA_DE_TOLERANCIA'),
      SERVICIO_PARTO_FUERA_DE_RANGO: motivoIntento('SERVICIO_PARTO_FUERA_DE_RANGO'),
      SERVICIO_ABORTO_FUERA_DE_RANGO: motivoIntento('SERVICIO_ABORTO_FUERA_DE_RANGO'),
      PENDIENTE_VENCIDO: contar(intentos, (i) => i.pendienteVencido),
      PENDIENTE_ANIMAL_CERRADO: contar(intentos, (i) => i.resultado === 'PENDIENTE' && i.cerrada),
      INICIO_CICLO_DESCONOCIDO: inicioDesconocido.length,
    },
    M5: { DUDOSA: dudosas, REPETICION: repeticiones },
    M7: { ATIPICO: intervalosAtipicos },
    M8: {
      ATIPICO: conteoAbiertos('ATIPICO'),
      SIN_BASE: conteoAbiertos('SIN_BASE'),
      NO_ATRIBUIBLE: conteoAbiertos('NO_ATRIBUIBLE'),
      CENSURADA_CERRADA: conteoAbiertos('CENSURADA_CERRADA'),
    },
    M9: { SERVICIO_LIBRE: contar(partoServicio, (c) => c.excluido === 'SERVICIO_LIBRE') },
    M10: {
      ORIGEN_NO_ELEGIBLE: motivoEdad(edadServicio, 'ORIGEN_NO_ELEGIBLE') + motivoEdad(edadParto, 'ORIGEN_NO_ELEGIBLE'),
      NACIMIENTO_NO_EXACTO: motivoEdad(edadServicio, 'NACIMIENTO_NO_EXACTO') + motivoEdad(edadParto, 'NACIMIENTO_NO_EXACTO'),
      SERVICIO_LIBRE: motivoEdad(edadServicio, 'SERVICIO_LIBRE'),
    },
    M12: {
      ATIPICO: atipicosGestacion,
      NO_ATRIBUIBLE: noAtribuiblesGestacion,
      EN_CURSO: enCurso,
      CENSURADA_CERRADA: conteoGestaciones('CENSURADA_CERRADA'),
      CON_DUDOSA_INTERMEDIA: contar(gestaciones, (g) => g.conDudosa),
    },
    General: {
      PRENADA_SIN_SERVICIO: contar(prenadas, (p) => p.sinServicio),
      PRENADA_SIN_BASE: contar(prenadas, (p) => p.sinBase),
    },
  };

  return {
    poblacion: {
      hembrasConEventos: hembras.length,
      enHato: contar(hembras, (h) => h.estadoOperativo === 'EN_HATO'),
      salidas: contar(hembras, (h) => h.estadoOperativo === 'SALIDO'),
      muertas: contar(hembras, (h) => h.estadoOperativo === 'MUERTO'),
    },
    metricas: {
      M1: { total: servicios.length, porTipo: porTipoServicio, montaLibre: contar(servicios, (s) => s.libre), intentos: intentos.length },
      M2: metricaConcepcion(intentos, tasaConcepcion),
      M3: { ...m3, totalIntentos: m3Total, inicioCicloDesconocido: inicioDesconocido.length, cobertura: porcentaje(m3.nEvaluable, m3Total) },
      M4: metricaConcepcion(intentos, serviciosPorConcepcion),
      M5: {
        positivos,
        negativos,
        n: nDiagnosticos,
        dudosas,
        repeticiones,
        cobertura: porcentaje(nDiagnosticos, diagnosticos.length),
        indicador: indicador(nDiagnosticos, porcentaje(positivos, nDiagnosticos)),
      },
      M7: { ...estadistica(intervalosValidos), atipicos: intervalosAtipicos, cobertura: porcentaje(intervalosValidos.length, intervalos.length) },
      M8: {
        ...estadistica(abiertosValidos),
        atipicos: conteoAbiertos('ATIPICO'),
        sinBase: conteoAbiertos('SIN_BASE'),
        noAtribuibles: conteoAbiertos('NO_ATRIBUIBLE'),
        censuradasCerradas: conteoAbiertos('CENSURADA_CERRADA'),
        cobertura: porcentaje(abiertosValidos.length, diasAbiertos.length),
        abiertasHoy: estadistica(abiertasHoy.map((a) => a.dias)),
      },
      M9: {
        ...estadistica(partoServicioValidos),
        excluidos: partoServicio.length - partoServicioValidos.length,
        cobertura: porcentaje(partoServicioValidos.length, partoServicio.length),
      },
      M10: { primerServicio: metricaEdad(edadServicio), primerParto: metricaEdad(edadParto) },
      M12: {
        perdidas,
        terminos,
        n: nGestaciones,
        noAtribuibles: noAtribuiblesGestacion,
        atipicos: atipicosGestacion,
        enCurso,
        censuradasCerradas: conteoGestaciones('CENSURADA_CERRADA'),
        conDudosa: contar(gestaciones, (g) => g.conDudosa),
        cobertura: porcentaje(nGestaciones, nGestaciones + noAtribuiblesGestacion + atipicosGestacion),
        indicador: indicador(nGestaciones, porcentaje(perdidas, nGestaciones)),
      },
      M13: {
        partos: partos.length,
        porTipo: partosPorTipo,
        conIntervencion,
        criasDeclaradas: partos.reduce((total, p) => total + p.numeroCrias, 0),
        indicador: indicador(partos.length, porcentaje(conIntervencion, partos.length)),
      },
      M14: Object.entries(conteoCalidad).map(([metrica, items]) => ({
        metrica,
        items: Object.entries(items).map(([codigo, conteo]) => ({ codigo, conteo })),
      })),
    },
  };
}
