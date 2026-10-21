// FASE 1C.1 / 1C.2 -- fuente CANÓNICA compartida de las alertas de pesaje:
// la reexporta el frontend (src/modules/ganaderia/engine/alertasPesajes.js ->
// hato/pesajesAlertas.js) y el backend usa su COPIA BYTE A BYTE en
// server/services/ganaderia/engine/ (reporte productivo PDF). Paridad exigida
// por server/services/__tests__/ganaderiaEngineParidad.test.js.
//
// Alertas DERIVADAS de los pesajes (modelo PURO: sin React,
// sin red, sin leer el reloj). Se recalculan en cada render a partir del
// historial/resumen que entrega la API Business de Fase 1A y de una fecha de
// referencia explícita (fecha calendario de negocio, la decide quien llama).
// NO se persisten: ni la alerta, ni su severidad, ni su vencimiento. El
// reconocimiento/descarte de alertas queda para una fase futura.
//
// Reglas:
//   * Sin pesajes            -> INFO.
//   * Pesaje atrasado        -> 0..diasAtencion días: sin alerta;
//                               diasAtencion+1..diasUrgente: ATENCION;
//                               > diasUrgente: URGENTE.
//     (reutiliza clasificarAntiguedadPesaje del engine canónico).
//   * Pérdida de peso        -> solo si hay pesaje anterior, días > 0 y
//                               GMD < 0: ATENCION. GMD = 0 no alerta.
//   * Sin umbrales productivos de GMD (Excelente/Bueno/Malo/...): no existe
//     una configuración oficial.
import { aFechaISO } from './fechas.js';
import { clasificarAntiguedadPesaje } from './pesajes.js';

/**
 * UMBRALES PROVISIONALES CONFIGURABLES de antigüedad del último pesaje (días).
 * No son una recomendación veterinaria ni una regla productiva oficial.
 */
export const CONFIGURACION_ALERTAS_PESAJE = Object.freeze({
  diasAtencion: 30,
  diasUrgente: 60,
});

export const SEVERIDADES_ALERTA = Object.freeze(['URGENTE', 'ATENCION', 'INFO']);

export const ETIQUETAS_SEVERIDAD = Object.freeze({
  URGENTE: 'URGENTE',
  ATENCION: 'ATENCIÓN',
  INFO: 'INFO',
});

export const CODIGOS_ALERTA = Object.freeze({
  SIN_PESAJES: 'PESAJE_SIN_REGISTROS',
  ATRASADO: 'PESAJE_ATRASADO',
  PERDIDA_PESO: 'PERDIDA_DE_PESO',
});

const RANGO_SEVERIDAD = Object.freeze(Object.fromEntries(SEVERIDADES_ALERTA.map((s, i) => [s, i])));

function entero(valor) {
  return Number.isInteger(valor) && valor >= 0;
}

/** Combina la configuración con los valores provisionales y la valida. */
export function resolverConfiguracionAlertas(configuracion) {
  const conf = { ...CONFIGURACION_ALERTAS_PESAJE, ...(configuracion ?? {}) };
  if (!entero(conf.diasAtencion) || !entero(conf.diasUrgente) || conf.diasUrgente < conf.diasAtencion) {
    throw new RangeError('Configuración de alertas de pesaje inválida: diasAtencion <= diasUrgente, enteros >= 0.');
  }
  return conf;
}

function numeroKg(valor) {
  return Number(valor).toLocaleString('es-CO', { maximumFractionDigits: 1 });
}

function textoDias(dias) {
  return dias === 1 ? '1 día' : `${dias} días`;
}

function finito(valor) {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

/**
 * Alertas derivadas de los pesajes de un animal.
 * @param {object} p
 * @param {Array}  [p.pesajes]          historial ASCENDENTE de la API (opcional si hay resumen).
 * @param {object} [p.resumen]          resumen de la API (fuente preferente).
 * @param {string} p.fechaReferencia   fecha calendario 'YYYY-MM-DD' de negocio.
 * @param {object} [p.configuracion]   { diasAtencion, diasUrgente }.
 * @returns {Array<{codigo, severidad, mensaje, datos}>} ordenadas URGENTE > ATENCION > INFO.
 */
export function construirAlertasPesajes({ pesajes, resumen, fechaReferencia, configuracion } = {}) {
  const conf = resolverConfiguracionAlertas(configuracion);
  const lista = Array.isArray(pesajes) ? pesajes : [];
  const r = resumen ?? {};
  const ultimo = lista.at(-1) ?? null;
  const total = finito(r.totalPesajes) ?? lista.length;
  const alertas = [];

  if (total === 0) {
    alertas.push({
      codigo: CODIGOS_ALERTA.SIN_PESAJES,
      severidad: 'INFO',
      mensaje: 'Este animal aún no tiene pesajes registrados.',
      datos: { totalPesajes: 0 },
    });
    return alertas;
  }

  // Antigüedad del último pesaje respecto a la fecha de referencia.
  const fechaUltimo = aFechaISO(r.fechaUltimoPeso ?? ultimo?.fecha ?? null);
  const referencia = aFechaISO(fechaReferencia ?? null);
  if (fechaUltimo && referencia) {
    const { estado, dias } = clasificarAntiguedadPesaje(fechaUltimo, referencia, {
      diasRecomendado: conf.diasAtencion,
      diasAtrasado: conf.diasUrgente,
    });
    if (estado === 'RECOMENDADO' || estado === 'ATRASADO') {
      alertas.push({
        codigo: CODIGOS_ALERTA.ATRASADO,
        severidad: estado === 'ATRASADO' ? 'URGENTE' : 'ATENCION',
        mensaje: `${dias === 1 ? 'Ha pasado' : 'Han pasado'} ${textoDias(dias)} desde el último pesaje.`,
        datos: {
          diasDesdeUltimoPesaje: dias,
          fechaUltimoPesaje: fechaUltimo,
          fechaReferencia: referencia,
          diasAtencion: conf.diasAtencion,
          diasUrgente: conf.diasUrgente,
        },
      });
    }
  }

  // Pérdida de peso en el último período (GMD < 0 con días > 0).
  const gmd = finito(r.gmdKgDia ?? ultimo?.gmdKgDia ?? null);
  const dias = finito(r.diasDesdeAnterior ?? ultimo?.diasDesdeAnterior ?? null);
  const diferencia = finito(r.diferenciaKg ?? ultimo?.diferenciaKg ?? null);
  const anterior = finito(r.pesoAnteriorKg ?? null) ?? finito(lista.at(-2)?.pesoKg ?? null);
  const actual = finito(r.ultimoPesoKg ?? ultimo?.pesoKg ?? null);
  if (anterior !== null && dias !== null && dias > 0 && gmd !== null && gmd < 0) {
    const perdida = diferencia !== null ? Math.abs(diferencia) : null;
    alertas.push({
      codigo: CODIGOS_ALERTA.PERDIDA_PESO,
      severidad: 'ATENCION',
      mensaje: perdida !== null
        ? `Se registró una pérdida de ${numeroKg(perdida)} kg desde el pesaje anterior.`
        : 'Se registró pérdida de peso desde el pesaje anterior.',
      datos: {
        pesoAnteriorKg: anterior,
        ultimoPesoKg: actual,
        diferenciaKg: diferencia,
        diasDesdeAnterior: dias,
        gmdKgDia: gmd,
      },
    });
  }

  // Orden estable por severidad (URGENTE > ATENCION > INFO).
  return alertas
    .map((alerta, i) => ({ alerta, i }))
    .sort((a, b) => RANGO_SEVERIDAD[a.alerta.severidad] - RANGO_SEVERIDAD[b.alerta.severidad] || a.i - b.i)
    .map(({ alerta }) => alerta);
}

function fechaCorta(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Dato que origina la alerta, en texto (para la UI). */
export function detalleAlerta(alerta) {
  const d = alerta?.datos ?? {};
  if (alerta?.codigo === CODIGOS_ALERTA.ATRASADO) {
    return `Último pesaje: ${fechaCorta(d.fechaUltimoPesaje)} · Referencia: ${fechaCorta(d.fechaReferencia)}`;
  }
  if (alerta?.codigo === CODIGOS_ALERTA.PERDIDA_PESO) {
    const gmd = Math.abs(d.gmdKgDia).toLocaleString('es-CO', { maximumFractionDigits: 2 });
    const pesos = d.ultimoPesoKg !== null ? `De ${numeroKg(d.pesoAnteriorKg)} kg a ${numeroKg(d.ultimoPesoKg)} kg` : `Desde ${numeroKg(d.pesoAnteriorKg)} kg`;
    return `${pesos} en ${textoDias(d.diasDesdeAnterior)} · GMD −${gmd} kg/día`;
  }
  return null;
}
