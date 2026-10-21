// FASE 1C.2 -- MODELO del reporte productivo individual (PURO: sin pdfkit,
// sin base de datos, sin leer el reloj salvo el `ahora` inyectado).
// Recibe el animal Business (serializeAnimal) y el historial derivado de
// pesajes (construirHistorialPesajes, motor canónico) y produce todo el
// contenido ya formateado que el generador PDF solo dibuja. Así el contenido
// se prueba sin depender de bytes PDF.
//
// Reglas:
//   * Solo datos Business activos y derivados ya validados; nunca legacy ni
//     Demo; nunca campos inexistentes. La identificación solo incluye los
//     campos que el animal tiene.
//   * null -> "Sin dato". El primer pesaje es "Primer peso registrado",
//     NUNCA "peso al nacimiento".
//   * Fechas de NEGOCIO (America/Bogota): sello de generación y fecha de
//     referencia de las alertas (resolveFechaHoyNegocio/FechaHoraNegocio).
//   * Alertas: las MISMAS reglas que la UI (engine/alertasPesajes.js, copia
//     byte a byte de shared/). Sin umbrales productivos de GMD.
//   * Texto apto para las fuentes estándar del PDF (WinAnsi): el signo menos
//     es "-" y cualquier carácter fuera de WinAnsi se sustituye.
import { construirAlertasPesajes } from '../engine/alertasPesajes.js';
import { numeroDeDia } from '../engine/fechas.js';
import { resolveFechaHoraNegocio, resolveFechaHoyNegocio } from '../motorDescansoAuto/businessTimezone.js';

export const SIN_DATO = 'Sin dato';
export const TITULO_REPORTE = 'Reporte productivo individual';
export const SUBTITULO_REPORTE = 'AgroGenomaX — Ganadería Inteligente';
export const NOTA_UMBRALES = 'Los umbrales de antigüedad del pesaje son parámetros operativos provisionales y no constituyen recomendación veterinaria.';
export const SIN_ALERTAS = 'No hay alertas de pesaje activas.';
export const ALERTAS_ANULADO = 'El animal está anulado: no se evalúan alertas de pesaje.';
export const SIN_PESAJES = 'No hay pesajes registrados.';

const SEXOS = Object.freeze({ HEMBRA: 'Hembra', MACHO: 'Macho' });
const ESTADOS = Object.freeze({ ACTIVO: 'Activo', ANULADO: 'Anulado' });
const METODOS = Object.freeze({ BASCULA: 'Báscula', ESTIMADO: 'Estimado' });
const SEVERIDADES = Object.freeze({ URGENTE: 'URGENTE', ATENCION: 'ATENCIÓN', INFO: 'INFO' });

// Caracteres representables en WinAnsi (Windows-1252) además de Latin-1.
const WINANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

/** Texto seguro para las fuentes estándar del PDF (WinAnsi), en una línea. */
export function textoPdf(valor) {
  const texto = String(valor ?? '').normalize('NFC').replace(/−/g, '-').replace(/\s+/g, ' ').trim();
  let out = '';
  for (const ch of texto) {
    const cp = ch.codePointAt(0);
    out += (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WINANSI_EXTRA.has(ch) ? ch : '?';
  }
  return out;
}

function numero(valor, maxDecimales) {
  return Number(valor).toLocaleString('es-CO', { maximumFractionDigits: maxDecimales });
}

function finito(valor) {
  return typeof valor === 'number' && Number.isFinite(valor);
}

export function formatKg(valor) {
  return finito(valor) ? `${numero(valor, 1)} kg` : SIN_DATO;
}

/** Signo explícito ASCII (+/-): no depende del color. */
export function formatDiferenciaKg(valor) {
  if (!finito(valor)) return SIN_DATO;
  if (valor === 0) return '0 kg';
  return `${valor > 0 ? '+' : '-'}${numero(Math.abs(valor), 1)} kg`;
}

export function formatGmd(valor) {
  if (!finito(valor)) return SIN_DATO;
  if (valor === 0) return '0 kg/día';
  return `${valor > 0 ? '+' : '-'}${numero(Math.abs(valor), 2)} kg/día`;
}

export function formatDias(valor) {
  if (!finito(valor)) return SIN_DATO;
  return valor === 1 ? '1 día' : `${valor} días`;
}

export function formatFecha(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return SIN_DATO;
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function celdaNumero(valor, maxDecimales, { signo = false } = {}) {
  if (!finito(valor)) return '—';
  if (!signo || valor === 0) return numero(valor, maxDecimales);
  return `${valor > 0 ? '+' : '-'}${numero(Math.abs(valor), maxDecimales)}`;
}

function formatRaza(animal) {
  if (animal.razaTipo === 'PURA') return animal.razaPrincipalNombre || animal.razaOtroNombre || null;
  if (animal.razaTipo === 'CRUCE') {
    const detalle = animal.cruceDescripcion || animal.razaPrincipalNombre;
    return detalle ? `Cruce: ${detalle}` : 'Cruce';
  }
  return 'No conocida';
}

/** Fecha calendario de negocio de un timestamp (Date o ISO); null si inválido. */
function fechaNegocioDe(valor) {
  if (!valor) return null;
  const instante = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(instante.getTime()) ? null : resolveFechaHoyNegocio(instante);
}

export function identificacionAnimal(animal) {
  if (animal.numeroVisual && animal.nombre) return `${animal.numeroVisual} · ${animal.nombre}`;
  return animal.numeroVisual || animal.nombre || `Animal ${animal.animalId}`;
}

function construirIdentificacion(animal) {
  const filas = [];
  const agregar = (etiqueta, valor) => {
    if (valor !== null && valor !== undefined && String(valor).trim() !== '') filas.push({ etiqueta, valor: textoPdf(valor) });
  };
  agregar('Número de identificación', animal.numeroVisual);
  agregar('Nombre', animal.nombre);
  agregar('Sexo', SEXOS[animal.sexo] ?? animal.sexo);
  agregar('Estado', ESTADOS[animal.estado] ?? animal.estado);
  if (animal.estado === 'ANULADO') agregar('Motivo de anulación', animal.estadoMotivo);
  agregar('Categoría productiva', animal.categoriaProductivaNombre);
  agregar('Raza', formatRaza(animal));
  agregar('Predio', animal.predioNombre);
  const registro = fechaNegocioDe(animal.fechaCreacion);
  if (registro) agregar('Fecha de registro', formatFecha(registro));
  return filas;
}

function construirResumen(resumen, pesajes) {
  const r = resumen ?? {};
  const acumulada = r.gananciaAcumulada ?? null;
  // Con un solo pesaje no hay ganancia acumulada, pero el primer peso
  // registrado sí existe (es ese pesaje).
  const primero = pesajes[0] ?? null;
  const ultimo = finito(r.ultimoPesoKg) && r.metodoUltimoPeso
    ? `${formatKg(r.ultimoPesoKg)} (${(METODOS[r.metodoUltimoPeso] ?? r.metodoUltimoPeso).toLowerCase()})`
    : formatKg(r.ultimoPesoKg);
  return [
    { etiqueta: 'Pesajes registrados', valor: String(r.totalPesajes ?? 0) },
    { etiqueta: 'Último peso', valor: ultimo },
    { etiqueta: 'Fecha del último peso', valor: formatFecha(r.fechaUltimoPeso) },
    { etiqueta: 'Peso anterior', valor: formatKg(r.pesoAnteriorKg) },
    { etiqueta: 'Diferencia', valor: formatDiferenciaKg(r.diferenciaKg) },
    { etiqueta: 'Días entre los últimos pesajes', valor: formatDias(r.diasDesdeAnterior) },
    { etiqueta: 'GMD (ganancia media diaria)', valor: formatGmd(r.gmdKgDia) },
    {
      etiqueta: 'Primer peso registrado',
      valor: acumulada
        ? `${formatKg(acumulada.primerPesoRegistradoKg)} (${formatFecha(acumulada.fechaPrimerPesoRegistrado)})`
        : primero ? `${formatKg(primero.pesoKg)} (${formatFecha(primero.fecha)})` : SIN_DATO,
    },
    {
      etiqueta: 'Ganancia acumulada',
      valor: acumulada ? `${formatDiferenciaKg(acumulada.gananciaKg)} en ${formatDias(acumulada.dias)}` : SIN_DATO,
    },
  ];
}

export const COLUMNAS_HISTORIAL = Object.freeze([
  'Fecha', 'Peso (kg)', 'Método', 'Diferencia (kg)', 'Días', 'GMD (kg/día)', 'Observaciones',
]);

function construirHistorial(pesajes) {
  // Orden cronológico ASCENDENTE (lectura productiva), igual que la API.
  return pesajes.map((p) => [
    formatFecha(p.fecha),
    celdaNumero(p.pesoKg, 1),
    METODOS[p.metodo] ?? textoPdf(p.metodo),
    celdaNumero(p.diferenciaKg, 1, { signo: true }),
    finito(p.diasDesdeAnterior) ? String(p.diasDesdeAnterior) : '—',
    celdaNumero(p.gmdKgDia, 2, { signo: true }),
    p.observaciones ? textoPdf(p.observaciones) : '—',
  ]);
}

function construirGraficaPeso(pesajes) {
  const puntos = pesajes
    .map((p) => ({ dia: numeroDeDia(p.fecha), fecha: p.fecha, etiqueta: formatFecha(p.fecha), pesoKg: p.pesoKg }))
    .filter((p) => p.dia !== null && finito(p.pesoKg));
  return puntos.length ? { puntos, conLinea: puntos.length >= 2 } : null;
}

function construirGmd(pesajes) {
  const periodos = [];
  pesajes.forEach((p, i) => {
    if (i === 0 || !finito(p.gmdKgDia)) return;
    const anterior = pesajes[i - 1];
    periodos.push({
      dia: numeroDeDia(p.fecha),
      desde: anterior.fecha,
      hasta: p.fecha,
      dias: p.diasDesdeAnterior,
      diferenciaKg: p.diferenciaKg,
      gmdKgDia: p.gmdKgDia,
    });
  });
  if (!periodos.length) return null;
  return {
    puntos: periodos.map((x) => ({ dia: x.dia, fecha: x.hasta, etiqueta: formatFecha(x.hasta), gmdKgDia: x.gmdKgDia })),
    conLinea: periodos.length >= 2,
    columnas: ['Desde', 'Hasta', 'Días', 'Diferencia (kg)', 'GMD (kg/día)'],
    filas: periodos.map((x) => [
      formatFecha(x.desde), formatFecha(x.hasta), String(x.dias),
      celdaNumero(x.diferenciaKg, 1, { signo: true }), celdaNumero(x.gmdKgDia, 2, { signo: true }),
    ]),
  };
}

function detalleAlerta(alerta) {
  const d = alerta.datos ?? {};
  if (alerta.codigo === 'PESAJE_ATRASADO') {
    return `Último pesaje: ${formatFecha(d.fechaUltimoPesaje)}. Fecha de referencia: ${formatFecha(d.fechaReferencia)}.`;
  }
  if (alerta.codigo === 'PERDIDA_DE_PESO') {
    const pesos = finito(d.ultimoPesoKg) ? `De ${formatKg(d.pesoAnteriorKg)} a ${formatKg(d.ultimoPesoKg)}` : `Desde ${formatKg(d.pesoAnteriorKg)}`;
    return `${pesos} en ${formatDias(d.diasDesdeAnterior)}; GMD ${formatGmd(d.gmdKgDia)}.`;
  }
  return null;
}

function construirAlertas(animal, historial, fechaReferencia) {
  if (animal.estado !== 'ACTIVO') return { lista: [], vacio: ALERTAS_ANULADO };
  const lista = construirAlertasPesajes({ pesajes: historial.pesajes, resumen: historial.resumen, fechaReferencia })
    .map((a) => ({
      codigo: a.codigo,
      severidad: a.severidad,
      etiqueta: SEVERIDADES[a.severidad],
      mensaje: textoPdf(a.mensaje),
      detalle: detalleAlerta(a),
    }));
  return { lista, vacio: lista.length ? null : SIN_ALERTAS };
}

/** Parte segura de nombre de archivo (ASCII, sin espacios ni separadores). */
export function parteArchivo(valor, maximo = 40) {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maximo)
    .replace(/-$/, '');
}

export function nombreArchivoReporte(animal, fecha) {
  const codigo = parteArchivo(animal.numeroVisual) || parteArchivo(animal.nombre) || `animal-${parteArchivo(animal.animalId)}`;
  return `AgroGenomaX_Reporte_Productivo_${codigo}_${fecha}.pdf`;
}

/**
 * Contenido completo del reporte.
 * @param {{ animal: object, historial: { resumen, pesajes }, ahora?: Date }} p
 */
export function construirReporteProductivo({ animal, historial, ahora = new Date() }) {
  if (!animal || !historial) throw new TypeError('construirReporteProductivo requiere animal e historial.');
  const generado = resolveFechaHoraNegocio(ahora);
  const pesajes = Array.isArray(historial.pesajes) ? historial.pesajes : [];
  const alertas = construirAlertas(animal, { ...historial, pesajes }, generado.fecha);
  return {
    titulo: TITULO_REPORTE,
    subtitulo: SUBTITULO_REPORTE,
    generado: {
      ...generado,
      texto: `Generado el ${formatFecha(generado.fecha)} a las ${generado.hora} (hora de Colombia)`,
    },
    animal: {
      animalId: String(animal.animalId),
      identificacion: textoPdf(identificacionAnimal(animal)),
      anulado: animal.estado === 'ANULADO',
    },
    identificacion: construirIdentificacion(animal),
    resumen: construirResumen(historial.resumen, pesajes),
    historial: { orden: 'ASCENDENTE', columnas: [...COLUMNAS_HISTORIAL], filas: construirHistorial(pesajes), vacio: SIN_PESAJES },
    graficaPeso: construirGraficaPeso(pesajes),
    gmd: construirGmd(pesajes),
    alertas: { lista: alertas.lista, vacio: alertas.vacio, nota: NOTA_UMBRALES },
    nombreArchivo: nombreArchivoReporte(animal, generado.fecha),
  };
}
