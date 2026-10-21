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
//   QR_DESASIGNADO      agx.animal_eventos QR_REVOCADO (revocada/dañada/anulación).
//   QR_REEMPLAZADO      agx.animal_eventos QR_REEMPLAZADO.
//   agx.qr_chapeta_eventos registra los MISMOS hechos QR desde la chapeta
//   (ASOCIADA_ANIMAL, REVOCADA, ...) y ASIGNADA_ORGANIZACION no es un hecho
//   del animal: se EXCLUYE por diseño (deduplicación).
//
// Nunca se expone: intentHash, qrId interno, tokens QR, actor, SQL ni el
// JSON crudo de metadata.
//
// Orden (DESCENDENTE, determinístico):
//   1. fecha efectiva (pesaje: su fecha calendario; resto: fecha de negocio
//      America/Bogota del instante) DESC;
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
});

// Menor = aparece antes (más reciente) ante empate de fecha e instante.
const PRIORIDAD = Object.freeze({
  ANIMAL_ANULADO: 0,
  QR_DESASIGNADO: 1,
  QR_REEMPLAZADO: 2,
  QR_ASIGNADO: 3,
  ANIMAL_CORREGIDO: 4,
  PESAJE_REGISTRADO: 5,
  ANIMAL_REGISTRADO: 6,
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
      const causa = meta.causa === 'ANIMAL_ANULADO' ? 'ANIMAL_ANULADO' : meta.causa === 'DANADO' ? 'DANADO' : 'REVOCADO';
      const accion = { ANIMAL_ANULADO: 'revocada por anulación del animal', DANADO: 'marcada como dañada', REVOCADO: 'revocada' }[causa];
      const motivo = causa === 'ANIMAL_ANULADO' ? null : textoSeguro(meta.motivo);
      return conFecha({
        ...base,
        tipo: TIPOS_TIMELINE.QR_DESASIGNADO,
        titulo: 'Chapeta QR dada de baja',
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
export function construirTimelineAnimal({ animal, pesajes = [], eventosAnimal = [], limit = TIMELINE_LIMIT_DEFAULT }) {
  const eventos = [];
  const vistos = new Set();
  const agregar = (evento) => {
    if (!evento || vistos.has(evento.id)) return;
    vistos.add(evento.id);
    eventos.push(evento);
  };
  for (const row of eventosAnimal) agregar(eventoAnimal(row));
  for (const p of pesajes) agregar(eventoPesaje(p));
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
