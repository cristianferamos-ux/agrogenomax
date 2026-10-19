// FASE 15 -- paquete maestro de fabricación láser de un lote QR_AGX (solo
// Super Admin). Contenido del ZIP <codigo_lote>-fabricacion.zip:
//   <codigo_lote>/svg/<codigo_visible>.svg      MASTER de grabado (1 por chapeta)
//   <codigo_lote>/pdf/<codigo_lote>-referencia.pdf  referencia vectorial 1:1
//   <codigo_lote>/manifest.csv                  control y trazabilidad
//   <codigo_lote>/README_PROVEEDOR.txt          instrucciones de fabricación
//   <codigo_lote>/CHECKSUMS.sha256              SHA-256 de todo lo anterior
// Antes de generar NADA se verifica cada chapeta (token ↔ token_hash, matriz
// QR reconstruida desde el SVG ↔ url_qr, nombre y contornos del código
// visible); ante cualquier diferencia se aborta el export completo. El ZIP
// no se almacena: se genera en memoria en cada descarga.
import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import JSZip from 'jszip';
import { hashQrToken, isCodigoNuevoValido, isQrToken } from './qrCodigos.js';
import { qrUrl } from './qrProveedorExport.js';
import {
  FUENTE_ARTE,
  FabricacionVerificationError,
  QR_EXPORT,
  buildChapetaArte,
  renderArteSvg,
  verificarArteSvg,
} from './qrFabricacionGeometria.js';

export const MANIFEST_COLUMNS = Object.freeze([
  'codigo_lote',
  'codigo_visible',
  'url_qr',
  'svg_filename',
  'svg_sha256',
  'qr_version',
  'ecc',
  'module_count',
  'physical_size_mm',
]);

export const PT_POR_MM = 72 / 25.4;

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function fallo(detalle) {
  throw new FabricacionVerificationError(detalle);
}

/** Campo CSV entrecomillado; neutraliza fórmulas (= + - @ tab CR) con un apóstrofo. */
export function csvField(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Verifica y construye el arte de cada chapeta. `chapetas` trae el token ya
 * descifrado con AES-GCM usando codigo_visible como AAD (un token movido de
 * fila no descifra) y el token_hash almacenado.
 */
export function prepararFabricacion({ lote, chapetas }, { cantidadEsperada = lote.cantidad } = {}) {
  if (lote.tipo !== 'QR_AGX') fallo('LOTE_NO_QR_AGX');
  if (!Array.isArray(chapetas) || chapetas.length === 0) fallo('LOTE_SIN_CHAPETAS');
  if (cantidadEsperada !== null && chapetas.length !== cantidadEsperada) fallo('CANTIDAD_DISTINTA');
  let origin;
  try {
    origin = new URL(lote.urlBase).origin;
  } catch {
    fallo('URL_BASE_INVALIDA');
  }
  if (origin !== lote.urlBase || !/^https?:$/.test(new URL(origin).protocol)) fallo('URL_BASE_INVALIDA');

  const vistos = new Set();
  const urls = new Set();
  const items = chapetas.map((chapeta) => {
    const { codigoVisible, token, tokenHash } = chapeta;
    if (!isCodigoNuevoValido(codigoVisible)) fallo('CODIGO_VISIBLE_INVALIDO');
    if (vistos.has(codigoVisible)) fallo('CODIGO_VISIBLE_DUPLICADO');
    vistos.add(codigoVisible);
    if (!isQrToken(token)) fallo('TOKEN_AUSENTE_O_INVALIDO');
    if (typeof tokenHash !== 'string' || hashQrToken(token) !== tokenHash) fallo('TOKEN_HASH_DISTINTO');
    const url = qrUrl(lote.urlBase, token);
    if (urls.has(url)) fallo('URL_QR_DUPLICADA');
    urls.add(url);

    const arte = buildChapetaArte({ codigoVisible, url });
    const svg = renderArteSvg(arte);
    const filename = `${codigoVisible}.svg`;
    if (!/^AGX-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]\.svg$/.test(filename) || svg.includes(token)) fallo('SVG_NOMBRE_O_CONTENIDO');
    const meta = verificarArteSvg({ svg, url, codigoVisible });
    return { codigoVisible, url, arte, svg, filename, svgSha256: sha256Hex(svg), ...meta };
  });
  return { lote, items };
}

export function buildManifestCsv({ lote, items }) {
  const lines = [MANIFEST_COLUMNS.join(',')];
  for (const item of items) {
    lines.push(
      [
        lote.codigoLote,
        item.codigoVisible,
        item.url,
        item.filename,
        item.svgSha256,
        item.version,
        item.ecc,
        item.moduleCount,
        QR_EXPORT.sizeMm,
      ]
        .map(csvField)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function buildReadmeProveedor({ lote, items }) {
  const layout = items[0].arte.layout;
  const lineas = [
    `AgroGenomaX - Paquete de fabricación láser - Lote ${lote.codigoLote}`,
    '',
    'DOCUMENTO CONFIDENCIAL. Uso exclusivo para fabricar este lote.',
    '',
    'CONTENIDO',
    `  svg/<codigo_visible>.svg   ARCHIVO MAESTRO de grabado (${items.length} archivos, uno por chapeta).`,
    `  pdf/${lote.codigoLote}-referencia.pdf   Referencia visual vectorial 1:1 (NO es el maestro).`,
    '  manifest.csv              Control y trazabilidad (NO es el original de fabricación).',
    '  CHECKSUMS.sha256          SHA-256 de cada archivo del paquete.',
    '',
    'GEOMETRÍA',
    `  Lienzo de cada SVG: ${layout.anchoMm} x ${layout.altoMm} mm.`,
    `  QR: ${QR_EXPORT.sizeMm} x ${QR_EXPORT.sizeMm} mm (incluye zona de silencio de ${QR_EXPORT.margin} módulos), corrección ${QR_EXPORT.errorCorrectionLevel}, ${items[0].moduleCount} x ${items[0].moduleCount} módulos.`,
    `  Debajo del QR: código visible de la chapeta convertido a contornos (${FUENTE_ARTE}); no requiere fuentes instaladas. Arriba: marca AGROGENOMAX.`,
    '',
    'REGLAS DE FABRICACIÓN (OBLIGATORIAS)',
    '  1. Importar cada SVG al 100 % (escala 1:1, unidades en mm).',
    '  2. NO redimensionar.',
    '  3. NO invertir colores. Se graban las formas negras; el resto queda sin grabar.',
    '  4. NO suavizar, simplificar ni aplicar antialiasing.',
    '  5. NO convertir el QR a contornos/strokes: grabar únicamente las formas rellenas (relleno / fill).',
    '  6. NO regenerar el QR desde url_qr ni desde ningún otro dato. El SVG es el MASTER.',
    '  7. NO modificar la URL ni añadir parámetros.',
    '  8. Mantener juntos el QR y el código visible DEL MISMO ARCHIVO. No combinar elementos de archivos distintos.',
    '  9. No invadir la zona del QR (30 x 30 mm) con ningún otro elemento.',
    ' 10. Fabricar primero UNA muestra y validarla con AgroGenomaX antes de producir el lote.',
    '',
    'VERIFICACIÓN DE INTEGRIDAD',
    '  Linux/macOS:  sha256sum -c CHECKSUMS.sha256',
    '  Windows:      Get-FileHash -Algorithm SHA256 <archivo>   (comparar con CHECKSUMS.sha256)',
    '  Si algún valor no coincide, NO fabricar y avisar a AgroGenomaX.',
    '',
    'DESPUÉS DE FABRICAR',
    '  Borrar el ZIP, los SVG extraídos, los trabajos/plantillas del software láser y',
    '  cualquier copia o vista previa. Confirmar el borrado por escrito a AgroGenomaX.',
    '  Las chapetas defectuosas se informan por su código visible (no se re-graban por cuenta propia).',
    '',
  ];
  return lineas.join('\r\n');
}

function dibujarRegla10mm(doc, x, y) {
  const largo = 10 * PT_POR_MM;
  doc.rect(x, y, largo, 0.6 * PT_POR_MM).fill('#000000');
  doc.rect(x, y - 1.4 * PT_POR_MM, 0.3 * PT_POR_MM, 2 * PT_POR_MM).fill('#000000');
  doc.rect(x + largo - 0.3 * PT_POR_MM, y - 1.4 * PT_POR_MM, 0.3 * PT_POR_MM, 2 * PT_POR_MM).fill('#000000');
  doc.fillColor('#000000').font('Helvetica').fontSize(7).text('10 mm (regla de control)', x + largo + 4, y - 3, { lineBreak: false });
}

/** Dibuja el arte 1:1 con la MISMA geometría del SVG (tramos QR como rectángulos rellenos). */
export function dibujarArte(doc, arte, xPt, yPt) {
  const escala = PT_POR_MM / arte.layout.unidadesPorMm; // pt por unidad de módulo
  doc.save();
  doc.translate(xPt, yPt);
  doc.scale(escala);
  doc.path(arte.marca.d).fill('#000000');
  for (const run of arte.runs) doc.rect(arte.layout.qr.x + run.x, arte.layout.qr.y + run.y, run.w, 1);
  doc.fill('#000000');
  doc.path(arte.codigo.d).fill('#000000');
  doc.restore();
}

/** PDF vectorial de referencia (pdfkit, sin compresión para que sea auditable). */
export function buildReferenciaPdf({ lote, items }) {
  return new Promise((resolve, reject) => {
    const fecha = lote.creadoAt ? new Date(lote.creadoAt) : new Date(0);
    const doc = new PDFDocument({
      size: 'A4',
      margin: 15 * PT_POR_MM,
      compress: false,
      autoFirstPage: false,
      info: {
        Title: `Lote ${lote.codigoLote} - referencia de fabricación`,
        Author: 'AgroGenomaX',
        Subject: 'Referencia vectorial 1:1. El maestro de grabado son los SVG.',
        CreationDate: fecha,
        ModDate: fecha,
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const layout = items[0].arte.layout;
    const margen = 15 * PT_POR_MM;
    const bloqueW = layout.anchoMm * PT_POR_MM;
    const bloqueH = layout.altoMm * PT_POR_MM;
    const etiquetaH = 9 * PT_POR_MM;
    const gapX = 8 * PT_POR_MM;
    const gapY = 4 * PT_POR_MM;
    const top = margen + 26 * PT_POR_MM;
    const columnas = 3;
    const filas = 3;
    const porPagina = columnas * filas;
    const paginas = Math.ceil(items.length / porPagina);

    for (let p = 0; p < paginas; p += 1) {
      doc.addPage();
      doc.fillColor('#000000').font('Helvetica-Bold').fontSize(12)
        .text(`AgroGenomaX · Lote ${lote.codigoLote} · Referencia de fabricación láser`, margen, margen, { lineBreak: false });
      doc.font('Helvetica').fontSize(8.5)
        .text(`${items.length} chapetas · QR ${QR_EXPORT.errorCorrectionLevel} versión ${items[0].version} · ${items[0].moduleCount} × ${items[0].moduleCount} módulos · ${QR_EXPORT.sizeMm} × ${QR_EXPORT.sizeMm} mm · lienzo ${layout.anchoMm} × ${layout.altoMm} mm · página ${p + 1}/${paginas}`, margen, margen + 6 * PT_POR_MM, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(9)
        .text('Imprimir / visualizar al 100 % — no ajustar a página', margen, margen + 11 * PT_POR_MM, { lineBreak: false });
      doc.font('Helvetica').fontSize(8)
        .text('Este PDF es solo referencia. El MASTER de grabado son los SVG del paquete (svg/<codigo_visible>.svg). No regenerar el QR.', margen, margen + 15.5 * PT_POR_MM, { lineBreak: false });
      dibujarRegla10mm(doc, margen, margen + 22 * PT_POR_MM);

      items.slice(p * porPagina, (p + 1) * porPagina).forEach((item, i) => {
        const x = margen + (i % columnas) * (bloqueW + gapX);
        const y = top + Math.floor(i / columnas) * (bloqueH + etiquetaH + gapY);
        doc.save();
        doc.lineWidth(0.3).dash(2, { space: 2 }).rect(x, y, bloqueW, bloqueH).stroke('#9ca3af');
        doc.undash();
        doc.restore();
        dibujarArte(doc, item.arte, x, y);
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9)
          .text(item.codigoVisible, x, y + bloqueH + 1.5 * PT_POR_MM, { width: bloqueW, align: 'center', lineBreak: false });
        doc.font('Helvetica').fontSize(7)
          .text(`Lote ${lote.codigoLote}`, x, y + bloqueH + 5 * PT_POR_MM, { width: bloqueW, align: 'center', lineBreak: false });
      });
    }
    doc.end();
  });
}

export function buildChecksums(files) {
  return `${Object.keys(files)
    .sort()
    .map((path) => `${sha256Hex(files[path])}  ${path}`)
    .join('\n')}\n`;
}

/** Nombres de archivo del paquete, relativos a la carpeta raíz <codigo_lote>/. */
export function nombresPaquete(lote, items) {
  return [
    'CHECKSUMS.sha256',
    'README_PROVEEDOR.txt',
    'manifest.csv',
    `pdf/${lote.codigoLote}-referencia.pdf`,
    ...items.map((item) => `svg/${item.filename}`),
  ].sort();
}

/** ZIP completo + SHA-256. Todo se verifica antes; nada parcial sale de aquí. */
export async function buildPaqueteFabricacion(data) {
  const preparado = prepararFabricacion(data);
  const { lote, items } = preparado;
  const files = {
    'manifest.csv': Buffer.from(buildManifestCsv(preparado), 'utf8'),
    'README_PROVEEDOR.txt': Buffer.from(buildReadmeProveedor(preparado), 'utf8'),
    [`pdf/${lote.codigoLote}-referencia.pdf`]: await buildReferenciaPdf(preparado),
  };
  for (const item of items) files[`svg/${item.filename}`] = Buffer.from(item.svg, 'utf8');
  files['CHECKSUMS.sha256'] = Buffer.from(buildChecksums(files), 'utf8');

  const zip = new JSZip();
  const fecha = lote.creadoAt ? new Date(lote.creadoAt) : new Date(0);
  const raiz = zip.folder(lote.codigoLote);
  for (const path of Object.keys(files).sort()) raiz.file(path, files[path], { date: fecha });
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  return { filename: `${lote.codigoLote}-fabricacion.zip`, buffer, sha256: sha256Hex(buffer), files };
}

