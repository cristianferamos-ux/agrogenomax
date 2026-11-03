// FASE 4D -- modelo PURO de la analítica reproductiva (sin React ni red).
// Presenta lo que entrega GET /api/ganaderia/reproduccion/analitica: las
// métricas, los ciclos y los umbrales los calcula el servidor; aquí nunca se
// recalculan. Con n < muestra mínima el indicador dice "Datos insuficientes" y
// siempre se muestran conteos, cobertura y M14. Los errores pasan por el modelo
// de la Fase 3C; response-race con crearSecuencia/cargarVigente de 4C.
import { mensajeDeExcepcion, mensajeError } from '../api/errorModel.js';
import { ETIQUETAS_TIPO_EVENTO } from '../hato/reproduccionModel.js';
import { formatFecha } from '../hato/pesajesModel.js';

export const MENSAJE_CARGA_ANALITICA = 'No fue posible cargar la analítica reproductiva.';
export const TEXTO_CARGANDO_ANALITICA = 'Cargando analítica reproductiva…';
export const TEXTO_DATOS_INSUFICIENTES = 'Datos insuficientes';
export const TEXTO_NO_CALCULABLE = 'No calculable';
export const MENSAJE_VOLUMEN_ANALITICA = 'La analítica contiene demasiados eventos para procesarse en una sola consulta. Reduce el alcance por predio o contacta al administrador.';
const MENSAJES_ANALITICA = Object.freeze({ ANALITICA_VOLUMEN_EXCEDIDO: MENSAJE_VOLUMEN_ANALITICA });

export const ETIQUETAS_METRICA_CALIDAD = Object.freeze({
  'M2-M4': 'Concepción por servicio',
  M5: 'Diagnósticos positivos',
  M7: 'Intervalo entre partos',
  M8: 'Días abiertos',
  M9: 'Parto a primer servicio',
  M10: 'Edad al primer servicio y parto',
  M12: 'Pérdida posterior a preñez',
  General: 'Calidad general',
});

export const ETIQUETAS_CALIDAD = Object.freeze({
  MONTA_LIBRE: 'Monta libre, fuera del denominador',
  MONTA_LIBRE_POSTERIOR: 'No atribuible: monta libre después del servicio',
  RETORNO_NO_PLAUSIBLE: 'No atribuible: nuevo servicio demasiado pronto',
  CONCEPCION_FUERA_DE_TOLERANCIA: 'No atribuible: concepción lejos del servicio',
  SERVICIO_PARTO_FUERA_DE_RANGO: 'No atribuible: servicio a parto fuera de rango',
  SERVICIO_ABORTO_FUERA_DE_RANGO: 'No atribuible: servicio a aborto fuera de rango',
  PENDIENTE_VENCIDO: 'Pendientes con plazo de diagnóstico vencido',
  PENDIENTE_ANIMAL_CERRADO: 'Pendientes de animales salidos o muertos',
  INICIO_CICLO_DESCONOCIDO: 'Inicio de ciclo desconocido, fuera del primer servicio',
  DUDOSA: 'Diagnósticos dudosos',
  REPETICION: 'Diagnósticos repetidos, contados una vez',
  ATIPICO: 'Atípicos',
  SIN_BASE: 'Sin base para estimar la concepción',
  NO_ATRIBUIBLE: 'No atribuibles',
  CENSURADA_CERRADA: 'Sin desenlace: animal salido o muerto',
  SERVICIO_LIBRE: 'Excluidos: servicio con monta libre',
  ORIGEN_NO_ELEGIBLE: 'Excluidos: no nacidas en el predio',
  NACIMIENTO_NO_EXACTO: 'Excluidos: nacimiento sin fecha exacta',
  EN_CURSO: 'Gestaciones en curso hoy',
  CON_DUDOSA_INTERMEDIA: 'Resueltas con diagnóstico dudoso intermedio',
  PRENADA_SIN_SERVICIO: 'Preñez sin servicio registrado',
  PRENADA_SIN_BASE: 'Preñez sin base de gestación',
});

/** Filtros aplicados -> query (sin vacíos: el servidor pone la ventana por defecto). */
export function queryAnalitica({ predioId = '', desde = '', hasta = '' } = {}) {
  const query = {};
  if (predioId) query.predioId = predioId;
  if (desde) query.desde = desde;
  if (hasta) query.hasta = hasta;
  return query;
}

/** Resultado de cargarVigente -> estado de la página (mensajes seguros, 3C). */
export function estadoAnalitica(resultado) {
  if (!resultado.ok) return { status: 'error', data: null, mensaje: mensajeDeExcepcion(resultado.error, MENSAJE_CARGA_ANALITICA) };
  const r = resultado.valor;
  if (r?.ok && r.data?.metricas) return { status: 'ok', data: r.data, mensaje: null };
  return {
    status: 'error',
    data: null,
    mensaje: mensajeError(r, MENSAJES_ANALITICA, { fallback: MENSAJE_CARGA_ANALITICA }),
    // Reintentar con el mismo alcance daría el mismo resultado: hay que cambiar de predio.
    reintentable: r?.data?.error !== 'ANALITICA_VOLUMEN_EXCEDIDO',
  };
}

const conUnidad = (valor, unidad) => `${String(valor).replace('.', ',')}${unidad}`;

/** Indicador del backend -> texto. Nunca muestra un valor con muestra insuficiente. */
export function textoIndicador(indicador, unidad = '') {
  if (indicador?.estado === 'OK' && indicador.valor !== null && indicador.valor !== undefined) return conUnidad(indicador.valor, unidad);
  if (indicador?.estado === 'NO_CALCULABLE') return TEXTO_NO_CALCULABLE;
  return TEXTO_DATOS_INSUFICIENTES;
}

const textoEstadistica = (e, unidad) => textoIndicador({ estado: e.estado, valor: e.mediana }, unidad);
const textoCobertura = (cobertura) => (cobertura === null || cobertura === undefined ? 'Sin casos' : conUnidad(cobertura, ' %'));

function desgloseTipos(metrica, unidad) {
  return Object.entries(metrica.porTipo ?? {}).map(([tipo, resumen]) => ({
    tipo,
    etiqueta: ETIQUETAS_TIPO_EVENTO[tipo] ?? 'Servicio',
    valor: textoIndicador(resumen.indicador, unidad),
    n: resumen.nEvaluable,
  }));
}

function tarjetaConcepcion(id, titulo, metrica, unidad) {
  const datos = [
    ['Concepciones', metrica.concepciones],
    ['No concepciones', metrica.noConcepciones],
    ['Pendientes', metrica.pendientes],
    ['No atribuibles', metrica.noAtribuibles],
    ['Monta libre', metrica.montaLibre],
    ['n evaluable', metrica.nEvaluable],
  ];
  if (metrica.inicioCicloDesconocido !== undefined) datos.splice(5, 0, ['Inicio desconocido', metrica.inicioCicloDesconocido]);
  return { id, titulo, valor: textoIndicador(metrica.indicador, unidad), detalle: null, datos, cobertura: textoCobertura(metrica.cobertura), desglose: desgloseTipos(metrica, unidad) };
}

function tarjetaEstadistica(id, titulo, metrica, unidad, datos) {
  return {
    id,
    titulo,
    valor: textoEstadistica(metrica, unidad),
    detalle: metrica.estado === 'OK' ? `Mediana · P25 ${conUnidad(metrica.p25, '')} · P75 ${conUnidad(metrica.p75, '')}` : null,
    datos: [['n', metrica.n], ...datos],
    cobertura: textoCobertura(metrica.cobertura),
    desglose: [],
  };
}

/** Métricas del backend -> tarjetas (M6 y M11 están aplazadas). */
export function tarjetasMetricas(metricas) {
  if (!metricas) return [];
  const { M1, M2, M3, M4, M5, M7, M8, M9, M10, M12, M13 } = metricas;
  return [
    {
      id: 'M1',
      titulo: 'Servicios registrados',
      valor: String(M1.total),
      detalle: null,
      datos: [
        ...Object.entries(M1.porTipo).map(([tipo, conteo]) => [ETIQUETAS_TIPO_EVENTO[tipo] ?? 'Servicio', conteo]),
        ['Con monta libre', M1.montaLibre],
        ['Intentos', M1.intentos],
      ],
      cobertura: null,
      desglose: [],
    },
    tarjetaConcepcion('M2', 'Concepción por servicio evaluable', M2, ' %'),
    tarjetaConcepcion('M3', 'Concepción al primer servicio evaluable', M3, ' %'),
    tarjetaConcepcion('M4', 'Servicios evaluables por concepción', M4, ''),
    {
      id: 'M5',
      titulo: 'Diagnósticos positivos',
      valor: textoIndicador(M5.indicador, ' %'),
      detalle: null,
      datos: [['Preñadas', M5.positivos], ['Vacías', M5.negativos], ['Dudosos', M5.dudosas], ['Repetidos', M5.repeticiones], ['n', M5.n]],
      cobertura: textoCobertura(M5.cobertura),
      desglose: [],
    },
    tarjetaEstadistica('M7', 'Intervalo entre partos', M7, ' días', [['Atípicos', M7.atipicos]]),
    tarjetaEstadistica('M8', 'Días abiertos', M8, ' días', [
      ['Atípicos', M8.atipicos],
      ['Sin base', M8.sinBase],
      ['No atribuibles', M8.noAtribuibles],
      ['Sin desenlace', M8.censuradasCerradas],
      ['Abiertas hoy', M8.abiertasHoy.n],
      ['Días abiertas hoy', textoEstadistica(M8.abiertasHoy, '')],
    ]),
    tarjetaEstadistica('M9', 'Parto a primer servicio', M9, ' días', [['Excluidos', M9.excluidos]]),
    tarjetaEstadistica('M10-S', 'Edad al primer servicio', M10.primerServicio, ' meses', [['Excluidos', M10.primerServicio.excluidos]]),
    tarjetaEstadistica('M10-P', 'Edad al primer parto', M10.primerParto, ' meses', [['Excluidos', M10.primerParto.excluidos]]),
    {
      id: 'M12',
      titulo: 'Pérdida posterior a preñez confirmada',
      valor: textoIndicador(M12.indicador, ' %'),
      detalle: null,
      datos: [
        ['Pérdidas', M12.perdidas],
        ['Gestaciones resueltas evaluables', M12.n],
        ['No atribuibles', M12.noAtribuibles],
        ['Atípicos', M12.atipicos],
        ['En curso hoy', M12.enCurso],
        ['Sin desenlace', M12.censuradasCerradas],
      ],
      cobertura: textoCobertura(M12.cobertura),
      desglose: [],
    },
    {
      id: 'M13',
      titulo: 'Partos con intervención',
      valor: textoIndicador(M13.indicador, ' %'),
      detalle: null,
      datos: [['Partos', M13.partos], ['Con intervención', M13.conIntervencion], ['Crías declaradas', M13.criasDeclaradas]],
      cobertura: null,
      desglose: [],
    },
  ];
}

/** M14 -> grupos con etiqueta; un código desconocido nunca se muestra crudo ni se oculta. */
export function gruposCalidad(metricas) {
  return (metricas?.M14 ?? []).map((grupo) => ({
    metrica: grupo.metrica,
    titulo: ETIQUETAS_METRICA_CALIDAD[grupo.metrica] ?? 'Otros',
    items: grupo.items.map((item) => ({ codigo: item.codigo, etiqueta: ETIQUETAS_CALIDAD[item.codigo] ?? 'Otro motivo', conteo: item.conteo })),
  }));
}

export function textoPeriodo(periodo) {
  return periodo ? `Del ${formatFecha(periodo.desde)} al ${formatFecha(periodo.hasta)}, ambos inclusive.` : null;
}

export function textoPoblacion(poblacion) {
  if (!poblacion) return null;
  return `${poblacion.hembrasConEventos} hembras con eventos: ${poblacion.enHato} en el hato, ${poblacion.salidas} salidas y ${poblacion.muertas} muertas. Los eventos anulados no cuentan.`;
}

/** Transparencia de los umbrales: plausibilidad de datos, no regla clínica. */
export function textoUmbralesCalidad(configuracion, muestraMinima) {
  if (!configuracion) return null;
  return `Servicios a ${configuracion.mismoIntentoMaxDias} día o menos son el mismo intento; retorno plausible desde ${configuracion.retornoServicioMinDias} días. `
    + `Concepción a ±${configuracion.toleranciaConcepcionDias} días del servicio; servicio a parto de ${configuracion.servicioPartoMinDias} a ${configuracion.servicioPartoMaxDias} días; `
    + `entre partos de ${configuracion.intervaloPartosMinDias} a ${configuracion.intervaloPartosMaxDias} días; parto a concepción desde ${configuracion.partoConcepcionMinDias} días. `
    + `Con menos de ${muestraMinima} casos no se muestra el indicador. `
    + 'Son reglas provisionales para revisar la calidad de los datos, no reglas clínicas ni recomendaciones veterinarias.';
}
