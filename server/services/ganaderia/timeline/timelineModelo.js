// FASE 1D.2 -- línea de tiempo DERIVADA del animal (modelo PURO: sin base
// de datos, sin leer el reloj, sin JSX). No se persiste nada: cada evento
// sale de UNA fuente canónica y nunca dos eventos describen el mismo hecho.
//
// Mapa de fuentes (auditado):
//   ANIMAL_REGISTRADO   agx.animal_eventos REGISTRADO (único por animal).
//                       Respaldo SOLO si no existiera: agx.animales.created_at.
//   ANIMAL_CORREGIDO    agx.animal_eventos DATOS_CORREGIDOS (metadata.campos).
//   ANIMAL_ANULADO      agx.animal_eventos ANULADO (metadata.motivo). La
//                       columna animales.estado_* es el MISMO hecho: no se usa.
//   PESAJE_REGISTRADO   agx.animal_pesajes + derivaciones del motor canónico
//                       (construirHistorialPesajes). Nunca se copia a eventos.
//   QR_ASIGNADO         agx.animal_eventos QR_ASOCIADO.
//   QR_DESASIGNADO      agx.animal_eventos QR_REVOCADO (revocada/dañada/
//                       anulación/salida/muerte).
//   QR_REEMPLAZADO      agx.animal_eventos QR_REEMPLAZADO.
//   ANIMAL_SALIDO       agx.animal_eventos SALIDO (FASE 2A; metadata.fecha =
//   ANIMAL_MUERTO       fecha efectiva, motivo/causa). animales.cierre_* es el
//                       MISMO hecho: no se usa.
//   CELO / SERVICIO /   agx.reproduccion_eventos (FASE 4A; fecha = fecha_evento,
//   INSEMINACION / IATF hora declarada). Los ANULADO se muestran marcados
//   / TRANSFERENCIA_    "(anulado)" (trazabilidad); el estado reproductivo
//   EMBRION / PRENEZ /  NO se deriva aquí (reproduccionEstado.js).
//   ABORTO / PARTO
//   agx.qr_chapeta_eventos registra los MISMOS hechos QR desde la chapeta
//   (ASOCIADA_ANIMAL, REVOCADA, ...) y ASIGNADA_ORGANIZACION no es un hecho
//   del animal: se EXCLUYE por diseño (deduplicación).
//
// Nunca se expone: intentHash, qrId interno, tokens QR, actor, SQL ni el
// JSON crudo de metadata.
//
// Orden (DESCENDENTE, determinístico):
//   1. fecha efectiva (pesaje y salida/muerte: su fecha calendario; resto:
//      fecha de negocio America/Bogota del instante) DESC;
//   2. instante técnico (ocurrido_en / created_at del pesaje) DESC;
//   3. prioridad de tipo (registro al final de su día; anulación primero);
//   4. id numérico de la fuente DESC.
import { resolveFechaHoraNegocio } from '../motorDescansoAuto/businessTimezone.js';

export const TIMELINE_LIMIT_DEFAULT = 50;
export const TIMELINE_LIMIT_MAX = 200;

export const TIPOS_TIMELINE = Object.freeze({
  ANIMAL_REGISTRADO: 'ANIMAL_REGISTRADO',
  ANIMAL_CORREGIDO: 'ANIMAL_CORREGIDO',
  ANIMAL_ANULADO: 'ANIMAL_ANULADO',
  PESAJE_REGISTRADO: 'PESAJE_REGISTRADO',
  QR_ASIGNADO: 'QR_ASIGNADO',
  QR_DESASIGNADO: 'QR_DESASIGNADO',
  QR_REEMPLAZADO: 'QR_REEMPLAZADO',
  ANIMAL_SALIDO: 'ANIMAL_SALIDO',
  ANIMAL_MUERTO: 'ANIMAL_MUERTO',
  // FASE 4A: agx.reproduccion_eventos (fecha efectiva = fecha_evento).
  CELO: 'CELO',
  SERVICIO: 'SERVICIO',
  INSEMINACION: 'INSEMINACION',
  IATF: 'IATF',
  TRANSFERENCIA_EMBRION: 'TRANSFERENCIA_EMBRION',
  PRENEZ: 'PRENEZ',
  ABORTO: 'ABORTO',
  PARTO: 'PARTO',
});

// Menor = aparece antes (más reciente) ante empate de fecha e instante. El
// cierre (salida/muerte) precede a la revocación de chapeta que provoca.
const PRIORIDAD = Object.freeze({
  ANIMAL_ANULADO: 0,
  ANIMAL_MUERTO: 1,
  ANIMAL_SALIDO: 1,
  QR_DESASIGNADO: 2,
  QR_REEMPLAZADO: 3,
  QR_ASIGNADO: 4,
  ANIMAL_CORREGIDO: 5,
  PESAJE_REGISTRADO: 6,
  CELO: 6,
  SERVICIO: 6,
  INSEMINACION: 6,
  IATF: 6,
  TRANSFERENCIA_EMBRION: 6,
  PRENEZ: 6,
  ABORTO: 6,
  PARTO: 6,
  ANIMAL_REGISTRADO: 7,
});

// FASE 4A: tipo reproductivo -> [tipo de línea de tiempo, título].
const REPRODUCCION = Object.freeze({
  CELO_OBSERVADO: ['CELO', 'Celo observado'],
  SERVICIO_MONTA: ['SERVICIO', 'Servicio por monta'],
  INSEMINACION_ARTIFICIAL: ['INSEMINACION', 'Inseminación artificial'],
  IATF: ['IATF', 'Inseminación a tiempo fijo (IATF)'],
  TRANSFERENCIA_EMBRION: ['TRANSFERENCIA_EMBRION', 'Transferencia de embrión'],
  DIAGNOSTICO_PRENEZ: ['PRENEZ', 'Diagnóstico de preñez'],
  ABORTO: ['ABORTO', 'Aborto'],
  PARTO: ['PARTO', 'Parto'],
});
const RESULTADOS_PRENEZ = Object.freeze({ PRENADA: 'Preñada', VACIA: 'Vacía', DUDOSA: 'Dudosa' });
const TIPOS_PARTO = Object.freeze({ NORMAL: 'Normal', ASISTIDO: 'Asistido', CESAREA: 'Cesárea', OTRO: 'Otro' });

// FASE 2A: catálogos de cierre (cierreValidation.js) -> texto.
const MOTIVOS_SALIDA = Object.freeze({
  VENTA: 'Venta',
  TRASLADO: 'Traslado',
  DONACION: 'Donación',
  INTERCAMBIO: 'Intercambio',
  DEVOLUCION: 'Devolución',
  OTRA: 'Otra',
});
const CAUSAS_MUERTE = Object.freeze({
  MUERTE_NATURAL: 'Muerte natural',
  ENFERMEDAD: 'Enfermedad',
  ACCIDENTE: 'Accidente',
  SACRIFICIO: 'Sacrificio',
  DEPREDACION: 'Depredación',
  DESCONOCIDA: 'Desconocida',
  OTRA: 'Otra',
});
const CAUSAS_REVOCACION_QR = Object.freeze({
  ANIMAL_ANULADO: 'revocada por anulación del animal',
  ANIMAL_SALIDO: 'revocada por salida del animal',
  ANIMAL_MUERTO: 'revocada por muerte del animal',
  DANADO: 'marcada como dañada',
  REVOCADO: 'revocada',
});

// FASE 2B: la baja de la chapeta por cierre del animal es un hecho APARTE
// del cierre (su propio evento) y lo dice en el título.
const TITULOS_REVOCACION_QR = Object.freeze({
  ANIMAL_SALIDO: 'Chapeta QR dada de baja por salida del animal',
  ANIMAL_MUERTO: 'Chapeta QR dada de baja por muerte del animal',
});

const METODOS = Object.freeze({ BASCULA: 'Pesado en báscula', ESTIMADO: 'Estimado' });

// Columnas corregibles (animalesRepository.CORRECTABLE_COLUMNS) -> etiqueta.
const ETIQUETAS_CAMPOS = Object.freeze({
  numero_visual: 'Número de identificación',
  nombre: 'Nombre',
  sexo: 'Sexo',
  nacimiento_tipo: 'Nacimiento',
  fecha_nacimiento: 'Fecha de nacimiento',
  edad_aproximada_meses: 'Edad aproximada',
  edad_referencia_fecha: 'Edad aproximada',
  raza_tipo: 'Raza',
  raza_principal_id: 'Raza',
  raza_otro_nombre: 'Raza',
  cruce_descripcion: 'Raza',
  categoria_productiva_id: 'Categoría productiva',
  origen_tipo: 'Origen',
  procedencia: 'Procedencia',
  fecha_ingreso: 'Fecha de ingreso',
  observaciones: 'Observaciones',
});

/** Valida ?limit= : entero 1..200; ausente -> 50; inválido -> null. */
export function normalizarLimiteTimeline(raw) {
  if (raw === undefined || raw === null || raw === '') return TIMELINE_LIMIT_DEFAULT;
  const texto = String(raw);
  if (!/^\d{1,4}$/.test(texto)) return null;
  const n = Number(texto);
  return n >= 1 && n <= TIMELINE_LIMIT_MAX ? n : null;
}

function textoSeguro(valor, max = 300) {
  if (typeof valor !== 'string') return null;
  const t = valor.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

function codigoSeguro(valor) {
  // Código visible de chapeta (AGX-XXXX-XXXX-X o similar): nunca un token.
  return typeof valor === 'string' && /^[A-Z0-9-]{3,20}$/.test(valor) ? valor : null;
}

function numero(valor, maxDecimales) {
  return Number(valor).toLocaleString('es-CO', { maximumFractionDigits: maxDecimales });
}

function instante(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function conFecha(evento, instanteIso) {
  const d = instante(instanteIso);
  if (!d) return { ...evento, fechaHora: null, fecha: null, hora: null };
  const { fecha, hora } = resolveFechaHoraNegocio(d);
  return { ...evento, fechaHora: d.toISOString(), fecha, hora };
}

function eventoAnimal(row) {
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const base = { id: `animal_evento:${row.eventoId}`, origen: 'animal_eventos', _orden: { instante: row.ocurridoEn, fuenteId: Number(row.eventoId) } };
  switch (row.tipoEvento) {
    case 'REGISTRADO':
      return conFecha({ ...base, tipo: TIPOS_TIMELINE.ANIMAL_REGISTRADO, titulo: 'Animal registrado', descripcion: 'Alta del animal en AgroGenomaX.', datos: {} }, row.ocurridoEn);
    case 'DATOS_CORREGIDOS': {
      const campos = [...new Set((Array.isArray(meta.campos) ? meta.campos : []).map((c) => ETIQUETAS_CAMPOS[c]).filter(Boolean))];
      return conFecha({
        ...base,
        tipo: TIPOS_TIMELINE.ANIMAL_CORREGIDO,
        titulo: 'Datos del animal corregidos',
        descripcion: campos.length ? `Campos: ${campos.join(', ')}.` : 'Se corrigieron datos del animal.',
        datos: { campos },
      }, row.ocurridoEn);
    }
    case 'ANULADO': {
      const motivo = textoSeguro(meta.motivo);
      return conFecha({
        ...base,
        tipo: TIPOS_TIMELINE.ANIMAL_ANULADO,
        titulo: 'Animal anulado',
        descripcion: motivo ? `Motivo: ${motivo}` : 'Sin motivo registrado.',
        datos: { motivo },
      }, row.ocurridoEn);
    }
    case 'QR_ASOCIADO': {
      const codigo = codigoSeguro(meta.codigoVisible);
      return conFecha({
        ...base,
        tipo: TIPOS_TIMELINE.QR_ASIGNADO,
        titulo: 'Chapeta QR asignada',
        descripcion: codigo ? `Chapeta ${codigo}.` : 'Se asignó una chapeta QR.',
        datos: { codigoVisible: codigo },
      }, row.ocurridoEn);
    }
    case 'QR_REVOCADO': {
      const codigo = codigoSeguro(meta.codigoVisible);
      const causa = Object.hasOwn(CAUSAS_REVOCACION_QR, meta.causa) ? meta.causa : 'REVOCADO';
      const accion = CAUSAS_REVOCACION_QR[causa];
      const motivo = causa.startsWith('ANIMAL_') ? null : textoSeguro(meta.motivo);
      return conFecha({
        ...base,
        tipo: TIPOS_TIMELINE.QR_DESASIGNADO,
        titulo: TITULOS_REVOCACION_QR[causa] ?? 'Chapeta QR dada de baja',
        descripcion: `${codigo ? `Chapeta ${codigo}` : 'La chapeta'} ${accion}.${motivo ? ` Motivo: ${motivo}` : ''}`,
        datos: { codigoVisible: codigo, causa, motivo },
      }, row.ocurridoEn);
    }
    case 'QR_REEMPLAZADO': {
      const nueva = codigoSeguro(meta.codigoVisible);
      const anterior = codigoSeguro(meta.anteriorCodigoVisible);
      const motivo = textoSeguro(meta.motivo);
      return conFecha({
        ...base,
        tipo: TIPOS_TIMELINE.QR_REEMPLAZADO,
        titulo: 'Chapeta QR reemplazada',
        descripcion: `${anterior && nueva ? `${anterior} → ${nueva}.` : 'Se reemplazó la chapeta QR.'}${motivo ? ` Motivo: ${motivo}` : ''}`,
        datos: { codigoVisible: nueva, anteriorCodigoVisible: anterior, motivo },
      }, row.ocurridoEn);
    }
    case 'SALIDO':
    case 'MUERTO': {
      const salida = row.tipoEvento === 'SALIDO';
      const codigo = salida ? meta.motivo : meta.causa;
      const etiqueta = (salida ? MOTIVOS_SALIDA : CAUSAS_MUERTE)[codigo] ?? null;
      const observaciones = textoSeguro(meta.observaciones, 500);
      const fecha = typeof meta.fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(meta.fecha) ? meta.fecha : null;
      const evento = {
        ...base,
        tipo: salida ? TIPOS_TIMELINE.ANIMAL_SALIDO : TIPOS_TIMELINE.ANIMAL_MUERTO,
        titulo: salida ? 'Animal salió del hato' : 'Animal muerto',
        descripcion: `${etiqueta ? `${salida ? 'Motivo' : 'Causa'}: ${etiqueta}.` : 'Sin detalle registrado.'}${observaciones ? ` Observaciones: ${observaciones}` : ''}`,
        datos: { [salida ? 'motivo' : 'causa']: etiqueta ? codigo : null, observaciones, registradoEn: row.ocurridoEn ?? null },
      };
      // Fecha EFECTIVA del cierre (calendario), como los pesajes: nunca un
      // instante UTC ficticio. Sin fecha válida se usa el registro técnico.
      return fecha ? { ...evento, fechaHora: null, fecha, hora: null } : conFecha(evento, row.ocurridoEn);
    }
    default:
      return null; // tipo desconocido: nunca se inventa ni se expone crudo
  }
}

function eventoPesaje(p) {
  const peso = `${numero(p.pesoKg, 1)} kg`;
  const inicial = p.origen === 'REGISTRO_INICIAL';
  return {
    id: `pesaje:${p.pesajeId}`,
    tipo: TIPOS_TIMELINE.PESAJE_REGISTRADO,
    // Fecha EFECTIVA del pesaje (calendario): nunca un instante UTC ficticio.
    fechaHora: null,
    fecha: p.fecha,
    hora: null,
    titulo: inicial ? 'Peso inicial registrado' : 'Pesaje registrado',
    descripcion: `${peso} · ${METODOS[p.metodo] ?? p.metodo}`,
    datos: {
      pesoKg: p.pesoKg,
      metodo: p.metodo,
      origen: p.origen,
      diferenciaKg: p.diferenciaKg ?? null,
      diasDesdeAnterior: p.diasDesdeAnterior ?? null,
      gmdKgDia: p.gmdKgDia ?? null,
      observaciones: textoSeguro(p.observaciones, 500),
      registradoEn: p.createdAt ?? null,
    },
    origen: 'animal_pesajes',
    _orden: { instante: p.createdAt, fuenteId: Number(p.pesajeId) },
  };
}

function descripcionReproductiva(e) {
  const partes = [];
  const toro = textoSeguro(e.toroExterno, 120);
  switch (e.tipoEvento) {
    case 'DIAGNOSTICO_PRENEZ':
      partes.push(`Resultado: ${RESULTADOS_PRENEZ[e.diagnosticoResultado] ?? 'sin dato'}.`);
      if (e.diasGestacion) partes.push(`${e.diasGestacion} días de gestación estimados.`);
      break;
    case 'PARTO':
      partes.push(`Tipo: ${TIPOS_PARTO[e.partoTipo] ?? 'sin dato'}. Crías: ${e.numeroCrias ?? 'sin dato'}.`);
      break;
    case 'ABORTO': {
      const causa = textoSeguro(e.abortoCausa, 200);
      if (e.diasGestacion) partes.push(`${e.diasGestacion} días de gestación estimados.`);
      if (causa) partes.push(`Causa: ${causa}.`);
      break;
    }
    case 'TRANSFERENCIA_EMBRION': {
      const codigo = textoSeguro(e.embrionCodigo, 80);
      const raza = textoSeguro(e.embrionRaza, 120);
      partes.push(`Embrión ${e.embrionConservacion === 'CONGELADO' ? 'congelado' : 'fresco'}${codigo ? ` ${codigo}` : ''}${raza ? ` (${raza})` : ''}.`);
      break;
    }
    default:
      if (toro) partes.push(`Toro/genética: ${toro}.`);
      break;
  }
  const observaciones = textoSeguro(e.observaciones, 500);
  if (observaciones) partes.push(`Observaciones: ${observaciones}`);
  if (e.estadoRegistro === 'ANULADO') {
    const motivo = textoSeguro(e.anulacion?.motivo);
    partes.push(`Anulado${motivo ? `: ${motivo}` : '.'}`);
  }
  return partes.length ? partes.join(' ') : 'Sin detalle registrado.';
}

function eventoReproductivo(e) {
  const mapeo = REPRODUCCION[e.tipoEvento];
  if (!mapeo) return null; // tipo desconocido: nunca se inventa ni se expone crudo
  const [tipo, titulo] = mapeo;
  const anulado = e.estadoRegistro === 'ANULADO';
  return {
    id: `reproduccion:${e.eventoId}`,
    tipo,
    // Fecha EFECTIVA del evento (calendario) y hora declarada, como pesajes.
    fechaHora: null,
    fecha: e.fechaEvento,
    hora: typeof e.horaEvento === 'string' && /^\d{2}:\d{2}$/.test(e.horaEvento) ? e.horaEvento : null,
    titulo: anulado ? `${titulo} (anulado)` : titulo,
    descripcion: descripcionReproductiva(e),
    datos: {
      tipoEvento: e.tipoEvento,
      detalle: e.detalle && typeof e.detalle === 'object' ? { ...e.detalle } : {},
      observaciones: textoSeguro(e.observaciones, 500),
      estadoRegistro: anulado ? 'ANULADO' : 'ACTIVO',
      motivoAnulacion: anulado ? textoSeguro(e.anulacion?.motivo) : null,
      corrigeEventoId: e.corrigeEventoId ?? null,
      registradoEn: e.registradoEn ?? null,
    },
    origen: 'reproduccion_eventos',
    _orden: { instante: e.registradoEn, fuenteId: Number(e.eventoId) },
  };
}

function comparar(a, b) {
  const fa = a.fecha ?? '';
  const fb = b.fecha ?? '';
  if (fa !== fb) return fa < fb ? 1 : -1;
  const ia = instante(a._orden.instante)?.getTime() ?? 0;
  const ib = instante(b._orden.instante)?.getTime() ?? 0;
  if (ia !== ib) return ib - ia;
  const pa = PRIORIDAD[a.tipo];
  const pb = PRIORIDAD[b.tipo];
  if (pa !== pb) return pa - pb;
  return b._orden.fuenteId - a._orden.fuenteId;
}

/**
 * @param {object} p
 * @param {{ animalId, fechaCreacion }} p.animal
 * @param {Array} p.pesajes        pesajes ENRIQUECIDOS (construirHistorialPesajes().pesajes)
 * @param {Array} p.eventosAnimal  filas de agx.animal_eventos { eventoId, tipoEvento, metadata, ocurridoEn }
 * @param {number} [p.limit]
 * @returns {{ eventos: Array, total: number, truncado: boolean }}
 */
export function construirTimelineAnimal({ animal, pesajes = [], eventosAnimal = [], eventosReproductivos = [], limit = TIMELINE_LIMIT_DEFAULT }) {
  const eventos = [];
  const vistos = new Set();
  const agregar = (evento) => {
    if (!evento || vistos.has(evento.id)) return;
    vistos.add(evento.id);
    eventos.push(evento);
  };
  for (const row of eventosAnimal) agregar(eventoAnimal(row));
  for (const p of pesajes) agregar(eventoPesaje(p));
  for (const e of eventosReproductivos) agregar(eventoReproductivo(e));
  // Respaldo de registro SOLO si no existe el evento canónico REGISTRADO.
  if (!eventos.some((e) => e.tipo === TIPOS_TIMELINE.ANIMAL_REGISTRADO) && animal?.fechaCreacion) {
    const creado = animal.fechaCreacion instanceof Date ? animal.fechaCreacion.toISOString() : animal.fechaCreacion;
    agregar(conFecha({
      id: `animal:${animal.animalId}:registro`,
      tipo: TIPOS_TIMELINE.ANIMAL_REGISTRADO,
      titulo: 'Animal registrado',
      descripcion: 'Alta del animal en AgroGenomaX.',
      datos: {},
      origen: 'animales',
      _orden: { instante: creado, fuenteId: 0 },
    }, creado));
  }
  eventos.sort(comparar);
  const total = eventos.length;
  const max = Math.min(Math.max(1, limit ?? TIMELINE_LIMIT_DEFAULT), TIMELINE_LIMIT_MAX);
  return {
    eventos: eventos.slice(0, max).map(({ _orden, ...publico }) => publico),
    total,
    truncado: total > max,
  };
}
