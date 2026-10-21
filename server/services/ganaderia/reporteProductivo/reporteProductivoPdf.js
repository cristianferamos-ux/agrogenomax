// FASE 1C.2 -- generador PDF del reporte productivo individual (pdfkit).
// Solo DIBUJA el modelo de reporteProductivoModelo.js (todo el texto llega
// ya formateado y apto para WinAnsi). Decisiones:
//   * Tamaño CARTA (612 x 792 pt, estándar en Colombia), márgenes de 48 pt.
//   * Fuentes estándar Helvetica/Helvetica-Bold (sin archivos externos).
//   * Encabezado (logo autorizado + título) y pie (identificación + "Página
//     X de N") en TODAS las páginas: bufferPages + pasada final.
//   * Tablas paginadas con encabezado repetido; ninguna fila se corta.
//   * Gráficas vectoriales propias (sin dependencias): eje X TEMPORAL
//     proporcional a los días reales; línea solo con >= 2 puntos; GMD con
//     referencia en 0. Sin umbrales de interpretación.
//   * Determinístico: CreationDate = instante de generación inyectado.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOGO_PATH = path.resolve(__dirname, '..', '..', '..', 'assets', 'branding', 'agx-report-logo.jpeg');

const PAGE = Object.freeze({ width: 612, height: 792 });
const M = 48;
const CONTENT_W = PAGE.width - 2 * M;
const HEADER_H = 64;
const FOOTER_H = 34;
const TOP = M + HEADER_H;
const BOTTOM = PAGE.height - M - FOOTER_H;

const C = Object.freeze({
  ink: '#111827',
  muted: '#4b5563',
  soft: '#6b7280',
  line: '#d1d5db',
  zebra: '#f3f4f6',
  brand: '#1f5f2c',
  brandSoft: '#e8f3e9',
  serie: '#2f7d32',
  gmd: '#1d4ed8',
  cero: '#9ca3af',
  URGENTE: '#b91c1c',
  ATENCION: '#b45309',
  INFO: '#1d4ed8',
});

const F = Object.freeze({ regular: 'Helvetica', bold: 'Helvetica-Bold' });

function texto(doc, valor, x, y, { size = 9, bold = false, color = C.ink, width, align = 'left', lineGap = 1 } = {}) {
  doc.font(bold ? F.bold : F.regular).fontSize(size).fillColor(color);
  doc.text(valor, x, y, { width, align, lineGap, lineBreak: width !== undefined });
}

function alto(doc, valor, width, { size = 9, bold = false, lineGap = 1 } = {}) {
  doc.font(bold ? F.bold : F.regular).fontSize(size);
  return doc.heightOfString(String(valor), { width, lineGap });
}

/** Cursor de contenido con salto de página controlado. */
function crearCursor(doc) {
  const cursor = {
    y: TOP,
    nuevaPagina() {
      doc.addPage();
      cursor.y = TOP;
    },
    asegurar(h) {
      if (cursor.y + h > BOTTOM) cursor.nuevaPagina();
    },
  };
  return cursor;
}

/** Párrafo con reserva de espacio: nunca provoca un salto automático de pdfkit. */
function parrafo(doc, cursor, valor, { size = 9, bold = false, color = C.ink, despues = 6 } = {}) {
  const h = alto(doc, valor, CONTENT_W, { size, bold });
  cursor.asegurar(h + 2);
  texto(doc, valor, M, cursor.y, { size, bold, color, width: CONTENT_W });
  cursor.y += h + despues;
}

function tituloSeccion(doc, cursor, titulo, { minimoSiguiente = 40 } = {}) {
  cursor.asegurar(22 + minimoSiguiente);
  cursor.y += 6;
  texto(doc, titulo.toUpperCase(), M, cursor.y, { size: 10, bold: true, color: C.brand });
  cursor.y += 14;
  doc.moveTo(M, cursor.y).lineTo(M + CONTENT_W, cursor.y).lineWidth(0.8).strokeColor(C.brand).stroke();
  cursor.y += 8;
}

/** Pares etiqueta/valor en `columnas` columnas. */
function rejilla(doc, cursor, pares, { columnas = 2 } = {}) {
  const gap = 12;
  const colW = (CONTENT_W - gap * (columnas - 1)) / columnas;
  for (let i = 0; i < pares.length; i += columnas) {
    const fila = pares.slice(i, i + columnas);
    const h = Math.max(...fila.map((p) => alto(doc, p.etiqueta, colW - 16, { size: 7.5, bold: true }) + alto(doc, p.valor, colW - 16, { size: 10, bold: true }))) + 14;
    cursor.asegurar(h + 6);
    fila.forEach((p, j) => {
      const x = M + j * (colW + gap);
      doc.roundedRect(x, cursor.y, colW, h, 4).lineWidth(0.6).fillAndStroke('#ffffff', C.line);
      texto(doc, p.etiqueta.toUpperCase(), x + 8, cursor.y + 6, { size: 7.5, bold: true, color: C.soft, width: colW - 16 });
      const hEtiqueta = alto(doc, p.etiqueta.toUpperCase(), colW - 16, { size: 7.5, bold: true });
      texto(doc, p.valor, x + 8, cursor.y + 8 + hEtiqueta, { size: 10, bold: true, color: C.ink, width: colW - 16 });
    });
    cursor.y += h + 6;
  }
}

/** Tabla paginada: encabezado repetido en cada página; las filas no se cortan. */
function tabla(doc, cursor, columnas, filas, anchos, { alinear = [] } = {}) {
  const pad = 4;
  const encabezado = () => {
    const h = Math.max(...columnas.map((c, i) => alto(doc, c, anchos[i] - 2 * pad, { size: 7.5, bold: true }))) + 2 * pad;
    cursor.asegurar(h + 18);
    let x = M;
    doc.rect(M, cursor.y, CONTENT_W, h).fill(C.brandSoft);
    columnas.forEach((c, i) => {
      texto(doc, c, x + pad, cursor.y + pad, { size: 7.5, bold: true, color: C.brand, width: anchos[i] - 2 * pad, align: alinear[i] ?? 'left' });
      x += anchos[i];
    });
    cursor.y += h;
  };
  encabezado();
  filas.forEach((fila, n) => {
    const h = Math.max(...fila.map((v, i) => alto(doc, v, anchos[i] - 2 * pad, { size: 8.5 }))) + 2 * pad;
    if (cursor.y + h > BOTTOM) {
      cursor.nuevaPagina();
      encabezado();
    }
    if (n % 2 === 1) doc.rect(M, cursor.y, CONTENT_W, h).fill(C.zebra);
    let x = M;
    fila.forEach((v, i) => {
      texto(doc, v, x + pad, cursor.y + pad, { size: 8.5, color: C.ink, width: anchos[i] - 2 * pad, align: alinear[i] ?? 'left' });
      x += anchos[i];
    });
    cursor.y += h;
    doc.moveTo(M, cursor.y).lineTo(M + CONTENT_W, cursor.y).lineWidth(0.4).strokeColor(C.line).stroke();
  });
  cursor.y += 8;
}

function numeroEje(valor) {
  return Number(valor).toLocaleString('es-CO', { maximumFractionDigits: 2 });
}

/** Marcas "redondas" para un rango [min, max]. */
function marcas(min, max, cantidad = 5) {
  const rango = max - min || Math.abs(max) || 1;
  const paso0 = rango / (cantidad - 1);
  const mag = 10 ** Math.floor(Math.log10(paso0));
  const paso = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((p) => p >= paso0) ?? 10 * mag;
  const inicio = Math.floor(min / paso) * paso;
  const fin = Math.ceil(max / paso) * paso;
  const out = [];
  for (let v = inicio; v <= fin + paso / 1000; v += paso) out.push(Number(v.toFixed(6)));
  return out;
}

/**
 * Escala del eje X TEMPORAL: posición proporcional a los días calendario
 * reales (no a la posición del pesaje en la lista). Con un único día abre
 * ±3 días para no colapsar el eje.
 */
export function escalaTemporal(dias, x0, x1) {
  let dMin = Math.min(...dias);
  let dMax = Math.max(...dias);
  if (dMin === dMax) { dMin -= 3; dMax += 3; }
  return (dia) => x0 + ((dia - dMin) / (dMax - dMin)) * (x1 - x0);
}

/**
 * Gráfica de dispersión/línea con eje X temporal (días calendario reales).
 * puntos: [{ dia, etiqueta, valor }].
 */
function grafica(doc, cursor, { puntos, conLinea, color, unidad, referenciaCero = false, alto: h = 170 }) {
  cursor.asegurar(h + 12);
  const x0 = M + 46;
  const x1 = M + CONTENT_W - 14;
  const y0 = cursor.y + 8;
  const y1 = cursor.y + h - 26;

  const valores = puntos.map((p) => p.valor).concat(referenciaCero ? [0] : []);
  let vMin = Math.min(...valores);
  let vMax = Math.max(...valores);
  if (vMin === vMax) { vMin -= Math.max(1, Math.abs(vMin) * 0.05); vMax += Math.max(1, Math.abs(vMax) * 0.05); }
  const ticksY = marcas(vMin, vMax);
  vMin = ticksY[0];
  vMax = ticksY.at(-1);

  const X = escalaTemporal(puntos.map((p) => p.dia), x0, x1);
  const Y = (v) => y1 - ((v - vMin) / (vMax - vMin)) * (y1 - y0);

  doc.save();
  // Rejilla horizontal y eje Y.
  ticksY.forEach((v) => {
    doc.moveTo(x0, Y(v)).lineTo(x1, Y(v)).lineWidth(0.4).strokeColor(C.line).stroke();
    texto(doc, `${numeroEje(v)}${unidad}`, M, Y(v) - 4, { size: 7, color: C.soft, width: 42, align: 'right' });
  });
  doc.moveTo(x0, y0).lineTo(x0, y1).lineTo(x1, y1).lineWidth(0.8).strokeColor(C.muted).stroke();
  if (referenciaCero && vMin < 0 && vMax > 0) {
    doc.moveTo(x0, Y(0)).lineTo(x1, Y(0)).lineWidth(0.8).dash(3, { space: 3 }).strokeColor(C.cero).stroke();
    doc.undash();
  }

  // Marcas del eje X en las fechas REALES de los puntos (posición temporal);
  // se omiten las que se solaparían.
  let ultimaX = -Infinity;
  const vistos = new Set();
  [...puntos].sort((a, b) => a.dia - b.dia).forEach((p, i, arr) => {
    if (vistos.has(p.dia)) return;
    vistos.add(p.dia);
    const x = X(p.dia);
    const esUltimo = i === arr.length - 1;
    if (x - ultimaX < 56 && !esUltimo) return;
    if (x - ultimaX < 56 && esUltimo && ultimaX !== -Infinity) return;
    doc.moveTo(x, y1).lineTo(x, y1 + 3).lineWidth(0.6).strokeColor(C.muted).stroke();
    const xEtiqueta = Math.min(Math.max(x - 28, M), M + CONTENT_W - 56); // nunca fuera del área de contenido
    texto(doc, p.etiqueta, xEtiqueta, y1 + 6, { size: 7, color: C.soft, width: 56, align: 'center' });
    ultimaX = x;
  });

  if (conLinea) {
    const orden = [...puntos].sort((a, b) => a.dia - b.dia);
    doc.moveTo(X(orden[0].dia), Y(orden[0].valor));
    orden.slice(1).forEach((p) => doc.lineTo(X(p.dia), Y(p.valor)));
    doc.lineWidth(1.6).strokeColor(color).stroke();
  }
  const radio = puntos.length > 30 ? 1.7 : 2.6;
  puntos.forEach((p) => {
    doc.circle(X(p.dia), Y(p.valor), radio).fill(color);
  });
  doc.restore();
  cursor.y += h;
}

function bloqueAlertas(doc, cursor, alertas) {
  if (!alertas.lista.length) {
    cursor.asegurar(24);
    parrafo(doc, cursor, alertas.vacio, { size: 9.5, color: C.muted, despues: 8 });
  }
  alertas.lista.forEach((a) => {
    const w = CONTENT_W - 22;
    const h = 10 + alto(doc, a.etiqueta, w, { size: 8, bold: true }) + alto(doc, a.mensaje, w, { size: 9.5, bold: true })
      + (a.detalle ? alto(doc, a.detalle, w, { size: 8.5 }) + 2 : 0) + 8;
    cursor.asegurar(h + 6);
    const color = C[a.severidad] ?? C.ink;
    doc.roundedRect(M, cursor.y, CONTENT_W, h, 4).lineWidth(0.6).fillAndStroke('#ffffff', C.line);
    doc.rect(M, cursor.y, 4, h).fill(color);
    let y = cursor.y + 6;
    texto(doc, a.etiqueta, M + 14, y, { size: 8, bold: true, color, width: w });
    y += alto(doc, a.etiqueta, w, { size: 8, bold: true }) + 1;
    texto(doc, a.mensaje, M + 14, y, { size: 9.5, bold: true, color: C.ink, width: w });
    y += alto(doc, a.mensaje, w, { size: 9.5, bold: true }) + 2;
    if (a.detalle) texto(doc, a.detalle, M + 14, y, { size: 8.5, color: C.muted, width: w });
    cursor.y += h + 6;
  });
  cursor.y += 2;
  parrafo(doc, cursor, `Nota: ${alertas.nota}`, { size: 7.5, color: C.soft, despues: 8 });
}

function encabezado(doc, modelo, logo) {
  const y = M;
  if (logo) doc.image(logo, M, y, { width: 40, height: 40 });
  const tx = M + (logo ? 50 : 0);
  texto(doc, modelo.titulo, tx, y + 3, { size: 15, bold: true, color: C.ink, width: 300 });
  texto(doc, modelo.subtitulo, tx, y + 22, { size: 9, color: C.brand, width: 300 });
  texto(doc, modelo.animal.identificacion, M + CONTENT_W - 200, y + 4, { size: 10, bold: true, color: C.ink, width: 200, align: 'right' });
  texto(doc, modelo.generado.texto, M + CONTENT_W - 200, y + 20, { size: 7.5, color: C.soft, width: 200, align: 'right' });
  doc.moveTo(M, y + 48).lineTo(M + CONTENT_W, y + 48).lineWidth(1.2).strokeColor(C.brand).stroke();
}

function pie(doc, modelo, pagina, total) {
  const y = PAGE.height - M - 14;
  doc.moveTo(M, y - 8).lineTo(M + CONTENT_W, y - 8).lineWidth(0.5).strokeColor(C.line).stroke();
  texto(doc, `AgroGenomaX · Ganadería Inteligente · ${modelo.titulo} · ${modelo.animal.identificacion}`, M, y, { size: 7, color: C.soft, width: CONTENT_W - 90 });
  texto(doc, `Página ${pagina} de ${total}`, M + CONTENT_W - 90, y, { size: 7, color: C.soft, width: 90, align: 'right' });
}

/**
 * Genera el PDF (Buffer) del modelo.
 * @param {object} modelo construirReporteProductivo(...)
 * @param {{ ahora?: Date, compress?: boolean, logoPath?: string|null }} [opciones]
 */
export function generarPdfReporteProductivo(modelo, { ahora = new Date(), compress = true, logoPath = LOGO_PATH } = {}) {
  return new Promise((resolve, reject) => {
    let logo = null;
    try {
      logo = logoPath ? fs.readFileSync(logoPath) : null;
    } catch {
      logo = null; // sin logo, el reporte sigue siendo válido
    }
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: TOP, bottom: M + FOOTER_H, left: M, right: M },
      bufferPages: true,
      compress,
      info: {
        Title: `${modelo.titulo} - ${modelo.animal.identificacion}`,
        Author: 'AgroGenomaX',
        Subject: modelo.subtitulo,
        Creator: 'AgroGenomaX Ganadería Inteligente',
        CreationDate: ahora,
        ModDate: ahora,
      },
    });
    const imagenLogo = logo ? doc.openImage(logo) : null;
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      const cursor = crearCursor(doc);

      // 1. Identificación
      tituloSeccion(doc, cursor, 'Identificación');
      rejilla(doc, cursor, modelo.identificacion, { columnas: 3 });

      // 2. Resumen productivo
      tituloSeccion(doc, cursor, 'Resumen productivo');
      rejilla(doc, cursor, modelo.resumen, { columnas: 3 });

      // 3. Historial de pesajes (cronológico ascendente)
      tituloSeccion(doc, cursor, 'Historial de pesajes (orden cronológico)');
      if (modelo.historial.filas.length) {
        tabla(doc, cursor, modelo.historial.columnas, modelo.historial.filas, [60, 52, 56, 64, 36, 62, 186], {
          alinear: ['left', 'right', 'left', 'right', 'right', 'right', 'left'],
        });
      } else {
        parrafo(doc, cursor, modelo.historial.vacio, { size: 9.5, color: C.muted, despues: 8 });
      }

      // 4. Evolución de peso
      tituloSeccion(doc, cursor, 'Evolución de peso', { minimoSiguiente: 180 });
      if (modelo.graficaPeso) {
        grafica(doc, cursor, {
          puntos: modelo.graficaPeso.puntos.map((p) => ({ dia: p.dia, etiqueta: p.etiqueta, valor: p.pesoKg })),
          conLinea: modelo.graficaPeso.conLinea,
          color: C.serie,
          unidad: ' kg',
        });
        if (!modelo.graficaPeso.conLinea) {
          parrafo(doc, cursor, 'Un solo pesaje: no hay tendencia que mostrar.', { size: 8, color: C.soft, despues: 3 });
        }
        parrafo(doc, cursor, 'Eje horizontal proporcional a los días transcurridos entre pesajes.', { size: 7.5, color: C.soft, despues: 8 });
      } else {
        parrafo(doc, cursor, modelo.historial.vacio, { size: 9.5, color: C.muted, despues: 8 });
      }

      // 5. GMD por período
      if (modelo.gmd) {
        tituloSeccion(doc, cursor, 'GMD por período', { minimoSiguiente: 150 });
        grafica(doc, cursor, {
          puntos: modelo.gmd.puntos.map((p) => ({ dia: p.dia, etiqueta: p.etiqueta, valor: p.gmdKgDia })),
          conLinea: modelo.gmd.conLinea,
          color: C.gmd,
          unidad: '',
          referenciaCero: true,
          alto: 140,
        });
        const conNegativos = modelo.gmd.puntos.some((p) => p.gmdKgDia < 0);
        parrafo(doc, cursor, `GMD en kg/día de cada período entre pesajes consecutivos (fecha final del período).${conNegativos ? ' Línea punteada: 0 kg/día.' : ''}`, { size: 7.5, color: C.soft, despues: 6 });
        tabla(doc, cursor, modelo.gmd.columnas, modelo.gmd.filas, [96, 96, 70, 127, 127], { alinear: ['left', 'left', 'right', 'right', 'right'] });
      }

      // 6. Alertas activas (+ nota de umbrales provisionales)
      tituloSeccion(doc, cursor, 'Alertas activas');
      bloqueAlertas(doc, cursor, modelo.alertas);

      // Encabezado y pie en todas las páginas (márgenes a 0 para no paginar).
      const { start, count } = doc.bufferedPageRange();
      for (let i = start; i < start + count; i += 1) {
        doc.switchToPage(i);
        const margenes = doc.page.margins;
        doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };
        encabezado(doc, modelo, imagenLogo);
        pie(doc, modelo, i - start + 1, count);
        doc.page.margins = margenes;
      }
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
