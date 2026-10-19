// FASE 15 -- modelo geométrico ÚNICO del arte de fabricación láser de las
// chapetas QR_AGX (dos caras). El SVG maestro, el PDF de referencia y la
// vista previa HTML consumen exactamente esta geometría (nunca
// QRCode.toString).
//
// Superficie útil física medida de la chapeta: 60.0 × 30.7 mm por cara.
//   FRENTE (variable, una por chapeta): SOLO el QR centrado y debajo el
//     código visible. Sin marca, sin web, sin elementos comerciales.
//   REVERSO (común a todo el lote): identidad AgroGenomaX en contornos.
//
// Frente -- sistema de coordenadas: 1 unidad = 1 módulo QR. El QR completo
// (símbolo + quiet zone) mide N = size + 2·margin unidades = QR_EXPORT.sizeMm
// mm, así que los módulos tienen coordenadas enteras y el tamaño físico
// exacto sale de width/height (mm) frente al viewBox (unidades).
// Reverso -- 1 unidad = 1 mm.
//
// Reglas del master: solo formas RELLENAS (fill #000000), sin stroke, sin
// fondo, sin <image>, sin <text> (los textos son contornos de una fuente OFL
// incluida en el repo), sin filtros ni degradados. La zona del QR (QR +
// quiet zone) está reservada: ningún otro elemento la invade.
import fs from 'node:fs';
import QRCode from 'qrcode';
import opentype from 'opentype.js';

// Tamaño elegido: el MAYOR de los candidatos que cabe limpiamente en la
// superficie útil con el código debajo (ver evaluarTamanoQr y el informe de
// FASE 15: 24.5 y 25 mm dejan < 0.8 mm de margen inferior).
export const QR_EXPORT = Object.freeze({ errorCorrectionLevel: 'Q', margin: 4, sizeMm: 24 });
export const QR_TAMANOS_CANDIDATOS_MM = Object.freeze([23, 23.5, 24, 24.5, 25]);

export const CHAPETA_AREA_UTIL_MM = Object.freeze({ ancho: 60, alto: 30.7 });

// Frente (mm). El lienzo nunca supera maxAncho × maxAlto (tolerancia frente
// a los bordes físicos de 60 × 30.7). El código visible usa capMm de altura
// de mayúscula; solo se reduciría si no cabe a lo ancho y NUNCA por debajo
// de capMinimoMm (en ese caso se aborta).
export const FRENTE_LAYOUT = Object.freeze({
  maxAnchoMm: 58,
  maxAltoMm: 30,
  margenSuperiorMinMm: 0.8,
  separacionQrCodigoMm: 0.6,
  margenInferiorMinMm: 0.8,
  margenLateralMinMm: 1,
  codigo: Object.freeze({ capMm: 3, capMinimoMm: 2.5 }),
});

// Reverso (mm): común a todas las chapetas. No existe logo vectorial oficial
// en el repositorio (solo PNG/WEBP/JPEG), así que la identidad es tipográfica.
export const REVERSO_LAYOUT = Object.freeze({
  anchoMm: 58,
  altoMm: 30,
  margenMinMm: 1,
  lineas: Object.freeze([
    Object.freeze({ id: 'marca', texto: 'AgroGenomaX', capMm: 4.4, baselineMm: 8.8 }),
    Object.freeze({ id: 'by-crh', texto: 'by CRH', capMm: 1.9, baselineMm: 13.4 }),
    Object.freeze({ id: 'vertical', texto: 'Ganadería Inteligente', capMm: 3, baselineMm: 19.8 }),
    Object.freeze({ id: 'web', texto: 'www.agrogenomax.com', capMm: 2.4, baselineMm: 25.6 }),
  ]),
});
export const REVERSO_FILENAME = 'agrogenomax-back.svg';

export const FUENTE_ARTE = 'IBM Plex Sans Condensed SemiBold (SIL OFL 1.1)';
const FUENTE_URL = new URL('../../assets/fonts/IBMPlexSansCondensed-SemiBold.woff', import.meta.url);
const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ECC_BITS = Object.freeze({ L: 1, M: 0, Q: 3, H: 2 });
const DECIMALES = 3;

let fuente = null;
function getFuente() {
  if (!fuente) {
    const buf = fs.readFileSync(FUENTE_URL);
    fuente = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
  return fuente;
}

export class FabricacionVerificationError extends Error {
  constructor(detalle) {
    super('La verificación del paquete de fabricación falló; no se generó ningún archivo.');
    this.status = 500;
    this.code = 'EXPORT_VERIFICATION_FAILED';
    // Solo para logs del servidor; nunca contiene tokens.
    this.detalle = detalle;
  }
}

function fallo(detalle) {
  throw new FabricacionVerificationError(detalle);
}

/** Matriz QR con quiet zone (1 = módulo negro) a partir de url_qr. */
export function buildQrMatrix(url) {
  const qr = QRCode.create(url, { errorCorrectionLevel: QR_EXPORT.errorCorrectionLevel });
  if (qr.errorCorrectionLevel.bit !== ECC_BITS[QR_EXPORT.errorCorrectionLevel]) fallo('ECC_INESPERADO');
  const size = qr.modules.size;
  const margin = QR_EXPORT.margin;
  const total = size + 2 * margin;
  const bits = new Uint8Array(total * total);
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (qr.modules.get(r, c)) bits[(r + margin) * total + (c + margin)] = 1;
    }
  }
  return { version: qr.version, ecc: QR_EXPORT.errorCorrectionLevel, size, margin, total, bits };
}

/** Tramos horizontales de módulos negros: [{x, y, w}] en unidades de la matriz con quiet zone. */
export function matrixRuns(matrix) {
  const runs = [];
  const { total, bits } = matrix;
  for (let y = 0; y < total; y += 1) {
    let x = 0;
    while (x < total) {
      if (!bits[y * total + x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < total && bits[y * total + x]) x += 1;
      runs.push({ x: start, y, w: x - start });
    }
  }
  return runs;
}

function runsPathData(runs, ox, oy) {
  return runs.map((r) => `M${ox + r.x} ${oy + r.y}h${r.w}v1h-${r.w}z`).join('');
}

function escalaCap(capMm) {
  const f = getFuente();
  return capMm / (f.tables.os2.sCapHeight / f.unitsPerEm);
}

function anchoTextoMm(texto, capMm) {
  return (getFuente().getAdvanceWidth(texto, 1000) / 1000) * escalaCap(capMm);
}

/** Código visible más ancho posible (AGX-XXXX-XXXX-C con el glifo más ancho). */
export function codigoPeorCaso() {
  const f = getFuente();
  let ancho = '';
  let max = -1;
  for (const ch of ALFABETO_CODIGO) {
    const a = f.getAdvanceWidth(ch, 1000);
    if (a > max) {
      max = a;
      ancho = ch;
    }
  }
  return `AGX-${ancho.repeat(4)}-${ancho.repeat(4)}-${ancho}`;
}

/**
 * Distribución del frente para un QR de `total` módulos y `sizeMm` mm.
 * Devuelve { cabe, motivo?, ...layout } sin lanzar: se usa también para
 * evaluar tamaños candidatos.
 */
export function evaluarTamanoQr(total, sizeMm) {
  const L = FRENTE_LAYOUT;
  const u = total / sizeMm; // unidades (módulos) por mm
  let ancho = Math.floor(L.maxAnchoMm * u + 1e-9);
  if ((ancho - total) % 2 !== 0) ancho -= 1;
  const alto = Math.floor(L.maxAltoMm * u + 1e-9);
  const qrX = (ancho - total) / 2;
  const qrY = Math.ceil(L.margenSuperiorMinMm * u - 1e-9);
  const codigoBaseline = qrY + total + (L.separacionQrCodigoMm + L.codigo.capMm) * u;
  const layout = {
    sizeMm,
    unidadesPorMm: u,
    moduloMm: sizeMm / total,
    ancho,
    alto,
    anchoMm: ancho / u,
    altoMm: alto / u,
    qr: { x: qrX, y: qrY, lado: total },
    codigoBaseline,
    margenes: {
      superiorMm: qrY / u,
      inferiorMm: (alto - codigoBaseline) / u,
      lateralQrMm: qrX / u,
    },
  };
  if (ancho < total + 2 * L.margenLateralMinMm * u) return { cabe: false, motivo: 'ANCHO_INSUFICIENTE', ...layout };
  if (layout.margenes.inferiorMm < L.margenInferiorMinMm - 1e-9) return { cabe: false, motivo: 'MARGEN_INFERIOR_INSUFICIENTE', ...layout };
  return { cabe: true, ...layout };
}

const layoutCache = new Map();
/** Layout del frente con QR_EXPORT.sizeMm; aborta si no cabe en la chapeta. */
export function layoutFrente(total) {
  if (layoutCache.has(total)) return layoutCache.get(total);
  const evaluado = evaluarTamanoQr(total, QR_EXPORT.sizeMm);
  if (!evaluado.cabe) fallo(`FRENTE_NO_CABE_${evaluado.motivo}`);
  const { cabe, ...layout } = evaluado;
  const congelado = Object.freeze({ ...layout, qr: Object.freeze(layout.qr), margenes: Object.freeze(layout.margenes) });
  layoutCache.set(total, congelado);
  return congelado;
}

function texto(texto, capMm, baseline, layout, centroX = layout.ancho / 2) {
  const f = getFuente();
  const size = escalaCap(capMm) * layout.unidadesPorMm;
  const advance = f.getAdvanceWidth(texto, size);
  const path = f.getPath(texto, centroX - advance / 2, baseline, size);
  const bb = path.getBoundingBox();
  return { d: path.toPathData(DECIMALES), capMm, bbox: { x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2 } };
}

/** Altura de mayúscula (mm) del código visible: capMm, reducida solo si no cabe; nunca < capMinimoMm. */
export function capCodigoMm(codigoVisible, layout) {
  const { capMm, capMinimoMm } = FRENTE_LAYOUT.codigo;
  const util = layout.anchoMm - 2 * FRENTE_LAYOUT.margenLateralMinMm;
  const cap = Math.min(capMm, (capMm * util) / anchoTextoMm(codigoVisible, capMm));
  if (cap < capMinimoMm) fallo('CODIGO_VISIBLE_NO_CABE');
  return cap;
}

/** Contornos del código visible centrados bajo el QR (usado al construir y al verificar). */
export function codigoVisiblePath(codigoVisible, layout) {
  return texto(codigoVisible, capCodigoMm(codigoVisible, layout), layout.codigoBaseline, layout);
}

/**
 * Modelo geométrico del FRENTE de una chapeta. Todas las coordenadas en
 * unidades de módulo; mm = unidades / layout.unidadesPorMm.
 */
export function buildChapetaArte({ codigoVisible, url }) {
  const matrix = buildQrMatrix(url);
  const layout = layoutFrente(matrix.total);
  const runs = matrixRuns(matrix);
  return {
    codigoVisible,
    matrix,
    layout,
    runs,
    qrPathData: runsPathData(runs, layout.qr.x, layout.qr.y),
    codigo: codigoVisiblePath(codigoVisible, layout),
  };
}

function fmt(n) {
  return Number(n.toFixed(4)).toString();
}

function svgRaiz(layout) {
  return `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${fmt(layout.anchoMm)}mm" height="${fmt(layout.altoMm)}mm" viewBox="0 0 ${layout.ancho} ${layout.alto}" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges">`;
}

/** SVG maestro del FRENTE (<codigo_visible>-front.svg): QR + código visible. */
export function renderArteSvg(arte) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    svgRaiz(arte.layout),
    `<path id="qr" fill="#000000" d="${arte.qrPathData}"/>`,
    `<path id="codigo-visible" fill="#000000" d="${arte.codigo.d}"/>`,
    '</svg>',
    '',
  ].join('\n');
}

/** Nombre del SVG maestro del frente. */
export function frenteFilename(codigoVisible) {
  return `${codigoVisible}-front.svg`;
}

let reversoCache = null;
/** Modelo geométrico del REVERSO común (unidades = mm). */
export function buildReversoArte() {
  if (reversoCache) return reversoCache;
  const layout = { unidadesPorMm: 1, ancho: REVERSO_LAYOUT.anchoMm, alto: REVERSO_LAYOUT.altoMm, anchoMm: REVERSO_LAYOUT.anchoMm, altoMm: REVERSO_LAYOUT.altoMm };
  const lineas = REVERSO_LAYOUT.lineas.map((l) => ({ id: l.id, texto: l.texto, ...texto(l.texto, l.capMm, l.baselineMm, layout) }));
  reversoCache = Object.freeze({ layout: Object.freeze(layout), lineas: Object.freeze(lineas) });
  return reversoCache;
}

export function renderReversoSvg(reverso = buildReversoArte()) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    svgRaiz(reverso.layout),
    ...reverso.lineas.map((l) => `<path id="${l.id}" fill="#000000" d="${l.d}"/>`),
    '</svg>',
    '',
  ].join('\n');
}

/** SVG solo-QR de QR_EXPORT.sizeMm (vista previa HTML); misma matriz y mismos tramos. */
export function renderQrSvg(url) {
  const matrix = buildQrMatrix(url);
  return `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${QR_EXPORT.sizeMm}mm" height="${QR_EXPORT.sizeMm}mm" viewBox="0 0 ${matrix.total} ${matrix.total}" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges"><path fill="#000000" d="${runsPathData(matrixRuns(matrix), 0, 0)}"/></svg>`;
}

const PROHIBIDO_SVG = /<image|<text|stroke|<filter|filter=|Gradient|<rect|<use|<style|<script|href=|opacity|#fff|white/i;

function atributo(svg, nombre) {
  const m = svg.match(new RegExp(`<svg [^>]*\\b${nombre}="([^"]*)"`));
  return m ? m[1] : null;
}

function pathData(svg, id) {
  const m = svg.match(new RegExp(`<path id="${id}" fill="#000000" d="([^"]*)"/>`));
  return m ? m[1] : null;
}

/** Reconstruye la matriz (con quiet zone) leyendo NUESTRO SVG del frente; null si el path no es canónico. */
export function matrixFromArteSvg(svg, total) {
  const d = pathData(svg, 'qr');
  if (d === null) return null;
  const layout = layoutFrente(total);
  const bits = new Uint8Array(total * total);
  const re = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/gy;
  let consumido = 0;
  let m;
  while ((m = re.exec(d)) !== null) {
    const [x, y, w, w2] = [Number(m[1]) - layout.qr.x, Number(m[2]) - layout.qr.y, Number(m[3]), Number(m[4])];
    if (w !== w2 || w < 1 || x < 0 || y < 0 || x + w > total || y >= total) return null;
    for (let i = 0; i < w; i += 1) {
      if (bits[y * total + x + i]) return null;
      bits[y * total + x + i] = 1;
    }
    consumido = re.lastIndex;
  }
  return consumido === d.length ? bits : null;
}

function cajasSeCruzan(a, b) {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

function dentroDeAreaUtil(svg) {
  const w = Number.parseFloat(atributo(svg, 'width'));
  const h = Number.parseFloat(atributo(svg, 'height'));
  return w > 0 && h > 0 && w <= CHAPETA_AREA_UTIL_MM.ancho && h <= CHAPETA_AREA_UTIL_MM.alto;
}

/**
 * Verificación independiente del SVG del frente ya generado contra url_qr y
 * el código visible. Lanza FabricacionVerificationError ante cualquier
 * diferencia.
 */
export function verificarArteSvg({ svg, url, codigoVisible }) {
  if (PROHIBIDO_SVG.test(svg)) fallo('SVG_CONTIENE_ELEMENTOS_PROHIBIDOS');
  if ((svg.match(/<path /g) || []).length !== 2) fallo('FRENTE_ELEMENTOS_INESPERADOS');
  const esperada = buildQrMatrix(url);
  const layout = layoutFrente(esperada.total);
  if (atributo(svg, 'viewBox') !== `0 0 ${layout.ancho} ${layout.alto}`) fallo('SVG_VIEWBOX');
  if (atributo(svg, 'width') !== `${fmt(layout.anchoMm)}mm` || atributo(svg, 'height') !== `${fmt(layout.altoMm)}mm`) fallo('SVG_TAMANO_FISICO');
  if (!dentroDeAreaUtil(svg)) fallo('FRENTE_EXCEDE_AREA_UTIL');
  if (Math.abs(layout.qr.lado / layout.unidadesPorMm - QR_EXPORT.sizeMm) > 1e-9) fallo('QR_TAMANO_FISICO');
  const reconstruida = matrixFromArteSvg(svg, esperada.total);
  if (!reconstruida) fallo('QR_PATH_NO_CANONICO');
  for (let i = 0; i < esperada.bits.length; i += 1) {
    if (reconstruida[i] !== esperada.bits[i]) fallo('QR_MATRIZ_DISTINTA');
  }
  const codigo = codigoVisiblePath(codigoVisible, layout);
  if (pathData(svg, 'codigo-visible') !== codigo.d) fallo('CODIGO_VISIBLE_GEOMETRIA');
  const zonaQr = { x1: layout.qr.x, y1: layout.qr.y, x2: layout.qr.x + layout.qr.lado, y2: layout.qr.y + layout.qr.lado };
  if (cajasSeCruzan(codigo.bbox, zonaQr)) fallo('TEXTO_INVADE_ZONA_QR');
  if (codigo.bbox.x1 < 0 || codigo.bbox.y1 < 0 || codigo.bbox.x2 > layout.ancho || codigo.bbox.y2 > layout.alto) fallo('TEXTO_FUERA_DEL_LIENZO');
  return { version: esperada.version, ecc: esperada.ecc, moduleCount: esperada.total };
}

/** Verificación del reverso común: solo contornos rellenos, dentro del área útil, idéntico al modelo. */
export function verificarReversoSvg(svg) {
  if (PROHIBIDO_SVG.test(svg)) fallo('REVERSO_CONTIENE_ELEMENTOS_PROHIBIDOS');
  if (svg !== renderReversoSvg()) fallo('REVERSO_DISTINTO_AL_MODELO');
  if (!dentroDeAreaUtil(svg)) fallo('REVERSO_EXCEDE_AREA_UTIL');
  const { layout, lineas } = buildReversoArte();
  const m = REVERSO_LAYOUT.margenMinMm;
  for (const l of lineas) {
    if (l.bbox.x1 < m || l.bbox.y1 < m || l.bbox.x2 > layout.ancho - m || l.bbox.y2 > layout.alto - m) fallo('REVERSO_TEXTO_FUERA_DE_MARGEN');
  }
  return true;
}
