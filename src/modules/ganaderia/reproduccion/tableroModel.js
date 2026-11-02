// FASE 4C -- modelo PURO del tablero reproductivo de la organización (sin
// React ni red). Presenta lo que entrega el backend:
//   GET /api/ganaderia/reproduccion/resumen   KPIs (misma CTE que el listado)
//   GET /api/ganaderia/reproduccion/animales  listado filtrado y paginado
// Estados, gestación, fechas probables de parto y alertas los DERIVA el
// servidor (SQL con paridad con reproduccionEstado.js); aquí nunca se
// recalculan ni se filtra el subconjunto cargado: cada filtro es una consulta.
// Los errores pasan por el modelo de la Fase 3C.
import { mensajeError } from '../api/errorModel.js';
import { formatFecha } from '../hato/pesajesModel.js';
import { formatIdentidad } from '../hato/hatoFormModel.js';
import { ETIQUETAS_ESTADO_REPRODUCTIVO, ETIQUETAS_TIPO_EVENTO, etiquetaOpcion } from '../hato/reproduccionModel.js';

export const TABLERO_PAGINA = 50;

export const MENSAJE_CARGA_TABLERO = 'No fue posible cargar el tablero reproductivo.';
export const TEXTO_CARGANDO_TABLERO = 'Cargando tablero reproductivo…';

// Niveles simples (sin semáforos clínicos). Texto, no solo color.
export const ETIQUETAS_NIVEL = Object.freeze({
  ATENCION: 'Atención',
  PROXIMA_ACCION: 'Próxima acción',
  INFORMATIVA: 'Informativa',
});

export const ETIQUETAS_ALERTA = Object.freeze({
  DIAGNOSTICO_PENDIENTE: 'Diagnóstico pendiente',
  PARTO_PROXIMO: 'Parto próximo',
  DIAGNOSTICO_DUDOSO: 'Diagnóstico dudoso',
  SIN_SEGUIMIENTO_REPRODUCTIVO: 'Sin historial reproductivo',
});

/** Alerta del backend -> { codigo, nivel, titulo, nivelTexto, mensaje }. */
export function presentarAlerta(alerta) {
  let mensaje;
  switch (alerta?.codigo) {
    case 'DIAGNOSTICO_PENDIENTE':
      mensaje = `Programar diagnóstico de preñez (servicio del ${formatFecha(alerta.fecha)}${typeof alerta.dias === 'number' ? `, hace ${alerta.dias} días` : ''}).`;
      break;
    case 'PARTO_PROXIMO':
      mensaje = typeof alerta.dias === 'number' && alerta.dias < 0
        ? `Parto estimado vencido el ${formatFecha(alerta.fecha)}.`
        : `Parto estimado para ${formatFecha(alerta.fecha)}.`;
      break;
    case 'DIAGNOSTICO_DUDOSO':
      mensaje = 'Requiere nuevo diagnóstico.';
      break;
    case 'SIN_SEGUIMIENTO_REPRODUCTIVO':
      mensaje = 'Sin eventos reproductivos registrados.';
      break;
    default:
      return null; // código desconocido: nunca se muestra crudo
  }
  return {
    codigo: alerta.codigo,
    nivel: alerta.nivel,
    titulo: ETIQUETAS_ALERTA[alerta.codigo],
    nivelTexto: ETIQUETAS_NIVEL[alerta.nivel] ?? 'Informativa',
    mensaje,
  };
}

// Filtros rápidos: cada uno es una consulta al backend (estadoReproductivo o alerta).
export const FILTROS_RAPIDOS = Object.freeze([
  { id: 'TODOS', label: 'Todos', query: {} },
  { id: 'SIN_ESTADO', label: 'Sin estado', query: { estadoReproductivo: 'SIN_ESTADO' }, kpi: ['porEstado', 'SIN_ESTADO'] },
  { id: 'CICLANDO', label: 'Ciclando', query: { estadoReproductivo: 'CICLANDO' }, kpi: ['porEstado', 'CICLANDO'] },
  { id: 'SERVIDA', label: 'Servidas', query: { estadoReproductivo: 'SERVIDA' }, kpi: ['porEstado', 'SERVIDA'] },
  { id: 'PRENADA', label: 'Preñadas', query: { estadoReproductivo: 'PRENADA' }, kpi: ['porEstado', 'PRENADA'] },
  { id: 'VACIA', label: 'Vacías', query: { estadoReproductivo: 'VACIA' }, kpi: ['porEstado', 'VACIA'] },
  { id: 'POSPARTO', label: 'Posparto', query: { estadoReproductivo: 'POSPARTO' }, kpi: ['porEstado', 'POSPARTO'] },
  { id: 'DIAGNOSTICO_PENDIENTE', label: 'Diagnóstico pendiente', query: { alerta: 'DIAGNOSTICO_PENDIENTE' }, kpi: ['porAlerta', 'DIAGNOSTICO_PENDIENTE'] },
  { id: 'PARTO_PROXIMO', label: 'Próximas a parto', query: { alerta: 'PARTO_PROXIMO' }, kpi: ['porAlerta', 'PARTO_PROXIMO'] },
  { id: 'DIAGNOSTICO_DUDOSO', label: 'Diagnóstico dudoso', query: { alerta: 'DIAGNOSTICO_DUDOSO' }, kpi: ['porAlerta', 'DIAGNOSTICO_DUDOSO'] },
]);

/** ¿El filtro rápido es una alerta? (las alertas solo existen en el hato actual). */
export function esFiltroAlerta(filtro) {
  return Boolean(FILTROS_RAPIDOS.find((f) => f.id === filtro)?.query.alerta);
}

/** Cambio de situación: en el histórico un filtro de alerta vuelve a "Todos". */
export function filtrosConSituacion(filtros, situacion) {
  const historico = situacion !== 'EN_HATO';
  return { ...filtros, situacion, filtro: historico && esFiltroAlerta(filtros.filtro) ? 'TODOS' : filtros.filtro };
}

export const SITUACIONES = Object.freeze([
  { value: 'EN_HATO', label: 'Hato actual' },
  { value: 'SALIDO', label: 'Histórico: salidos' },
  { value: 'MUERTO', label: 'Histórico: muertos' },
]);

/** Filtros de la UI -> query del listado (sin parámetros vacíos). */
export function queryListado({ filtro = 'TODOS', predioId = '', q = '', situacion = 'EN_HATO' } = {}, { limit = TABLERO_PAGINA, offset = 0 } = {}) {
  const rapido = FILTROS_RAPIDOS.find((f) => f.id === filtro) ?? FILTROS_RAPIDOS[0];
  const query = { ...rapido.query };
  if (predioId) query.predioId = predioId;
  if (q.trim()) query.q = q.trim();
  if (situacion && situacion !== 'EN_HATO') query.situacion = situacion;
  query.limit = String(limit);
  if (offset) query.offset = String(offset);
  return query;
}

/** KPIs del hato actual (ACTIVO + EN_HATO); cada uno es también un filtro rápido. */
export function kpisDe(resumen) {
  if (!resumen) return [];
  const conteo = (ruta) => (ruta ? resumen[ruta[0]]?.[ruta[1]] ?? 0 : resumen.hembrasEnSeguimiento ?? 0);
  return [
    { id: 'TODOS', label: 'Hembras en seguimiento', valor: conteo(null) },
    ...FILTROS_RAPIDOS.filter((f) => f.kpi).map((f) => ({ id: f.id, label: f.label, valor: conteo(f.kpi), alerta: f.kpi[0] === 'porAlerta' })),
  ];
}

/** Texto de los umbrales vigentes (transparencia de la regla, no recomendación). */
export function textoUmbrales(configuracion) {
  if (!configuracion) return null;
  return `Diagnóstico pendiente: ${configuracion.diasDiagnosticoPendiente} días o más desde el último servicio. `
    + `Parto próximo: ${configuracion.diasPartoProximo} días o menos para la fecha probable. `
    + `Sin historial: hembras de ${configuracion.edadMinimaSinSeguimientoMeses} meses o más (o de edad desconocida). `
    + 'Reglas operativas iniciales, no recomendaciones veterinarias.';
}

function refEvento(ref) {
  return ref ? `${ETIQUETAS_TIPO_EVENTO[ref.tipoEvento] ?? 'Evento'} · ${formatFecha(ref.fechaEvento)}` : null;
}

/** Fila del backend -> tarjeta: identidad, estado, datos clave y alertas presentadas. */
export function tarjetaAnimal(fila) {
  const datos = [];
  if (fila.ultimoServicio) datos.push(['Último servicio', refEvento(fila.ultimoServicio)]);
  if (fila.ultimoDiagnostico) {
    const resultado = etiquetaOpcion('diagnosticoResultado', fila.ultimoDiagnostico.resultado) ?? 'Sin dato';
    datos.push(['Último diagnóstico', `${resultado} · ${formatFecha(fila.ultimoDiagnostico.fechaEvento)}`]);
  }
  if (fila.gestacion?.fechaProbableParto) datos.push(['Parto probable', formatFecha(fila.gestacion.fechaProbableParto)]);
  if (fila.ultimoParto) datos.push(['Último parto', formatFecha(fila.ultimoParto.fechaEvento)]);
  if (!datos.length && fila.ultimoEvento) datos.push(['Último evento', refEvento(fila.ultimoEvento)]);
  return {
    animalId: fila.animalId,
    identidad: formatIdentidad({ numeroVisual: fila.numeroVisual, nombre: fila.nombre }),
    predio: fila.predioNombre ?? null,
    estado: fila.estadoReproductivo,
    estadoTexto: ETIQUETAS_ESTADO_REPRODUCTIVO[fila.estadoReproductivo] ?? 'Sin estado',
    cerrado: fila.estadoOperativo && fila.estadoOperativo !== 'EN_HATO' ? (fila.estadoOperativo === 'SALIDO' ? 'Salido' : 'Muerto') : null,
    anulado: fila.estadoRegistro === 'ANULADO',
    datos,
    alertas: (fila.alertas ?? []).map(presentarAlerta).filter(Boolean),
    ruta: rutaFichaReproduccion(fila.animalId),
  };
}

/** Ficha individual con la pestaña Reproducción abierta. */
export function rutaFichaReproduccion(animalId) {
  return `/ganaderia/animales/${encodeURIComponent(animalId)}?pestana=reproduccion`;
}

/** Resultado de un GET -> { ok, data } o { ok:false, mensaje } con mensajes seguros (3C). */
export function resultadoCarga(result, clave) {
  if (result?.ok && result.data && (clave ? Array.isArray(result.data[clave]) : true)) return { ok: true, data: result.data };
  return { ok: false, mensaje: mensajeError(result, null, { fallback: MENSAJE_CARGA_TABLERO }) };
}

/** Mensaje del estado vacío según filtros. */
export function textoVacio({ filtro, q, predioId, situacion }) {
  if (q || predioId) return 'Ninguna hembra coincide con la búsqueda.';
  if (situacion && situacion !== 'EN_HATO') return 'No hay hembras en este histórico.';
  if (filtro && filtro !== 'TODOS') return 'No hay hembras en esta categoría.';
  return 'Aún no hay hembras en el hato.';
}
