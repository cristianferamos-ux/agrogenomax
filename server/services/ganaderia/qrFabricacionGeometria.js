// FASE 15 -- modelo geométrico ÚNICO del arte de fabricación láser de una
// chapeta QR_AGX. El SVG maestro, el PDF de referencia y la vista previa
// HTML consumen exactamente esta geometría (nunca QRCode.toString).
//
// Sistema de coordenadas: 1 unidad = 1 módulo QR. El QR completo (símbolo +
// quiet zone) mide N = size + 2·margin unidades = QR_EXPORT.sizeMm mm, así
// que las coordenadas de los módulos son enteras y el tamaño físico exacto
// sale de width/height (mm) frente al viewBox (unidades).
//
// Reglas del master: solo formas RELLENAS (fill #000000), sin stroke, sin
// fondo, sin <image>, sin <text> (los textos son contornos de una fuente OFL
// incluida en el repo), sin filtros ni degradados. La zona del QR (QR +
// quiet zone) está reservada: ningún otro elemento la invade.
import fs from 'node:fs';
import QRCode from 'qrcode';
import opentype from 'opentype.js';

export const QR_EXPORT = Object.freeze({ errorCorrectionLevel: 'Q', margin: 4, sizeMm: 30 });

// Distribución del arte (mm). La fuente es proporcional: el código visible
// usa capMm de altura de mayúscula y solo se reduce (nunca por debajo de
// capMinimoMm) si no cabe en el ancho útil del lienzo.
export const ARTE_LAYOUT = Object.freeze({
  anchoMm: 50,
  altoMm: 46,
  margenLateralMm: 1.5,
  qrTopMm: 6,
  marca: Object.freeze({ texto: 'AGROGENOMAX', capMm: 2.2, baselineMm: 4.6 }),
  codigo: Object.freeze({ capMm: 4, capMinimoMm: 3, separacionQrMm: 2 }),
});

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

function fontSizeParaCap(capMm, unidadesPorMm) {
  const f = getFuente();
  return (capMm / (f.tables.os2.sCapHeight / f.unitsPerEm)) * unidadesPorMm;
}

function anchoTextoMm(texto, capMm) {
  const f = getFuente();
  return (f.getAdvanceWidth(texto, 1000) / 1000) * (capMm / (f.tables.os2.sCapHeight / f.unitsPerEm));
}

/** Código visible más ancho posible (AGX-XXXX-XXXX-C con el glifo más ancho) y su ancho a capMm. */
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
  const peor = `AGX-${ancho.repeat(4)}-${ancho.repeat(4)}-${ancho}`;
  return { codigo: peor, anchoMm: anchoTextoMm(peor, ARTE_LAYOUT.codigo.capMm) };
}

const layoutCache = new Map();
/** Lienzo en unidades para un QR de `total` módulos; centra el QR en coordenadas enteras. */
export function layoutLienzo(total) {
  if (layoutCache.has(total)) return layoutCache.get(total);
  const u = total / QR_EXPORT.sizeMm; // unidades por mm
  let ancho = Math.ceil(ARTE_LAYOUT.anchoMm * u);
  if ((ancho - total) % 2 !== 0) ancho += 1;
  const alto = Math.ceil(ARTE_LAYOUT.altoMm * u);
  const qrX = (ancho - total) / 2;
  const qrY = Math.ceil(ARTE_LAYOUT.qrTopMm * u);
  const layout = Object.freeze({
    unidadesPorMm: u,
    moduloMm: QR_EXPORT.sizeMm / total,
    ancho,
    alto,
    anchoMm: ancho / u,
    altoMm: alto / u,
    qr: Object.freeze({ x: qrX, y: qrY, lado: total }),
    marcaBaseline: ARTE_LAYOUT.marca.baselineMm * u,
    codigoBaseline: qrY + total + (ARTE_LAYOUT.codigo.separacionQrMm + ARTE_LAYOUT.codigo.capMm) * u,
  });
  layoutCache.set(total, layout);
  return layout;
}

function textoCentrado(texto, capMm, baseline, layout) {
  const f = getFuente();
  const size = fontSizeParaCap(capMm, layout.unidadesPorMm);
  const advance = f.getAdvanceWidth(texto, size);
  const path = f.getPath(texto, (layout.ancho - advance) / 2, baseline, size);
  const d = path.toPathData(DECIMALES);
  const bb = path.getBoundingBox();
  return { d, bbox: { x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2 } };
}

/** Altura de mayúscula (mm) del código visible: capMm, o menos si no cabe. */
export function capCodigoMm(codigoVisible, layout) {
  const { capMm, capMinimoMm } = ARTE_LAYOUT.codigo;
  const util = layout.anchoMm - 2 * ARTE_LAYOUT.margenLateralMm;
  const cap = Math.min(capMm, (capMm * util) / anchoTextoMm(codigoVisible, capMm));
  if (cap < capMinimoMm) fallo('CODIGO_VISIBLE_NO_CABE');
  return cap;
}

/** Contornos del código visible para un layout (usado al construir y al verificar). */
export function codigoVisiblePath(codigoVisible, layout) {
  return textoCentrado(codigoVisible, capCodigoMm(codigoVisible, layout), layout.codigoBaseline, layout);
}

/**
 * Modelo geométrico completo de una chapeta. Todas las coordenadas en
 * unidades de módulo; mm = unidades / layout.unidadesPorMm.
 */
export function buildChapetaArte({ codigoVisible, url }) {
  const matrix = buildQrMatrix(url);
  const layout = layoutLienzo(matrix.total);
  const runs = matrixRuns(matrix);
  const marca = textoCentrado(ARTE_LAYOUT.marca.texto, ARTE_LAYOUT.marca.capMm, layout.marcaBaseline, layout);
  const codigo = codigoVisiblePath(codigoVisible, layout);
  return {
    codigoVisible,
    matrix,
    layout,
    runs,
    qrPathData: runsPathData(runs, layout.qr.x, layout.qr.y),
    marca,
    codigo,
  };
}

function fmt(n) {
  return Number(n.toFixed(4)).toString();
}

/** SVG maestro (arte completo) de una chapeta. */
export function renderArteSvg(arte) {
  const { layout } = arte;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${fmt(layout.anchoMm)}mm" height="${fmt(layout.altoMm)}mm" viewBox="0 0 ${layout.ancho} ${layout.alto}" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges">`,
    `<path id="marca" fill="#000000" d="${arte.marca.d}"/>`,
    `<path id="qr" fill="#000000" d="${arte.qrPathData}"/>`,
    `<path id="codigo-visible" fill="#000000" d="${arte.codigo.d}"/>`,
    '</svg>',
    '',
  ].join('\n');
}

/** SVG solo-QR de 30 × 30 mm (vista previa HTML); misma matriz y mismos tramos. */
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

/** Reconstruye la matriz (con quiet zone) leyendo NUESTRO SVG; null si el path no es canónico. */
export function matrixFromArteSvg(svg, total) {
  const d = pathData(svg, 'qr');
  if (d === null) return null;
  const layout = layoutLienzo(total);
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

/**
 * Verificación independiente del SVG ya generado contra url_qr y el código
 * visible. Lanza FabricacionVerificationError ante cualquier diferencia.
 */
export function verificarArteSvg({ svg, url, codigoVisible }) {
  if (PROHIBIDO_SVG.test(svg)) fallo('SVG_CONTIENE_ELEMENTOS_PROHIBIDOS');
  const esperada = buildQrMatrix(url);
  const layout = layoutLienzo(esperada.total);
  if (atributo(svg, 'viewBox') !== `0 0 ${layout.ancho} ${layout.alto}`) fallo('SVG_VIEWBOX');
  if (atributo(svg, 'width') !== `${fmt(layout.anchoMm)}mm` || atributo(svg, 'height') !== `${fmt(layout.altoMm)}mm`) fallo('SVG_TAMANO_FISICO');
  if (Math.abs(layout.qr.lado / layout.unidadesPorMm - QR_EXPORT.sizeMm) > 1e-9) fallo('QR_TAMANO_FISICO');
  const reconstruida = matrixFromArteSvg(svg, esperada.total);
  if (!reconstruida) fallo('QR_PATH_NO_CANONICO');
  for (let i = 0; i < esperada.bits.length; i += 1) {
    if (reconstruida[i] !== esperada.bits[i]) fallo('QR_MATRIZ_DISTINTA');
  }
  const codigo = codigoVisiblePath(codigoVisible, layout);
  if (pathData(svg, 'codigo-visible') !== codigo.d) fallo('CODIGO_VISIBLE_GEOMETRIA');
  const zonaQr = { x1: layout.qr.x, y1: layout.qr.y, x2: layout.qr.x + layout.qr.lado, y2: layout.qr.y + layout.qr.lado };
  const marca = textoCentrado(ARTE_LAYOUT.marca.texto, ARTE_LAYOUT.marca.capMm, layout.marcaBaseline, layout);
  if (pathData(svg, 'marca') !== marca.d) fallo('MARCA_GEOMETRIA');
  for (const caja of [codigo.bbox, marca.bbox]) {
    if (cajasSeCruzan(caja, zonaQr)) fallo('TEXTO_INVADE_ZONA_QR');
    if (caja.x1 < 0 || caja.y1 < 0 || caja.x2 > layout.ancho || caja.y2 > layout.alto) fallo('TEXTO_FUERA_DEL_LIENZO');
  }
  return { version: esperada.version, ecc: esperada.ecc, moduleCount: esperada.total };
}
