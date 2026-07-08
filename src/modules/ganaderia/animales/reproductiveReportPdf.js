const PAGE = { width: 612, height: 792 };
const MARGIN = 42;
const TOP_MARGIN = 57;
const FOOTER_SAFE_Y = 132;
const FONT = { regular: 'F1', bold: 'F2' };

function sanitize(value) {
  return String(value ?? '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[\u2190-\u21FF]/g, '')
    .replace(/\uFFFD/g, '')
    .trim();
}

function pdfEscape(value) {
  return sanitize(value)
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function clean(value, fallback = 'NO REGISTRADO') {
  const text = sanitize(value);
  return text ? text : fallback;
}

function safeFilePart(value) {
  return String(value || 'Animal')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'Animal';
}

function splitText(value, maxChars = 48) {
  const words = clean(value, '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  words.forEach((word) => {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  });
  if (line) lines.push(line);
  return lines.length ? lines : ['NO REGISTRADO'];
}

function estimateTextWidth(value, size) {
  return Array.from(sanitize(value)).reduce((sum, char) => {
    if (char === ' ') return sum + size * 0.28;
    if ('.,:;|!/\\'.includes(char)) return sum + size * 0.22;
    if ('ilIjtfr'.includes(char)) return sum + size * 0.28;
    if ('mwMW@'.includes(char)) return sum + size * 0.78;
    if (/[A-ZÁÉÍÓÚÑ]/.test(char)) return sum + size * 0.62;
    if (/[0-9]/.test(char)) return sum + size * 0.56;
    return sum + size * 0.5;
  }, 0);
}

function binaryFromBytes(bytes) {
  let binary = '';
  const chunkSize = 8192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return binary;
}

function getImageSize(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = reject;
    image.src = src;
  });
}

async function loadImage(src) {
  try {
    const [response, size] = await Promise.all([fetch(src), getImageSize(src)]);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, ...size };
  } catch {
    return null;
  }
}

async function loadQrCode(data) {
  try {
    const src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&format=jpg&margin=8&data=${encodeURIComponent(data)}`;
    const [response, size] = await Promise.all([fetch(src), getImageSize(src)]);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, ...size };
  } catch {
    return null;
  }
}

function toneColor(tone = 'info') {
  if (tone === 'success') return [0.28, 0.62, 0];
  if (tone === 'warning') return [0.9, 0.68, 0];
  if (tone === 'danger') return [1, 0.23, 0.23];
  return [0.0, 0.52, 0.64];
}

class PdfBuilder {
  constructor() {
    this.objects = [];
    this.pages = [];
    this.current = [];
    this.y = PAGE.height - TOP_MARGIN;
    this.pageNumber = 0;
    this.totalPages = '__TOTAL_PAGES__';
    this.generatedAt = '';
    this.logo = null;
    this.brand = null;
    this.footerBrand = null;
    this.qr = null;
    this.logoObjectId = null;
    this.brandObjectId = null;
    this.footerBrandObjectId = null;
    this.qrObjectId = null;
  }

  addObject(content) {
    this.objects.push(content);
    return this.objects.length;
  }

  command(value) {
    this.current.push(value);
  }

  text(value, x, y, size = 9, font = FONT.regular, color = [0.06, 0.09, 0.12]) {
    this.command(`${color.join(' ')} rg BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfEscape(value)}) Tj ET`);
  }

  centeredText(value, centerX, y, size = 9, font = FONT.regular, color = [0.06, 0.09, 0.12]) {
    this.text(value, centerX - estimateTextWidth(value, size) / 2, y, size, font, color);
  }

  line(x1, y1, x2, y2, color = [0.86, 0.89, 0.93], width = 1) {
    this.command(`${color.join(' ')} RG ${width} w ${x1} ${y1} m ${x2} ${y2} l S`);
  }

  rect(x, y, width, height, stroke = [0.86, 0.89, 0.93], fill = [1, 1, 1], lineWidth = 1) {
    this.command(`${fill.join(' ')} rg ${stroke.join(' ')} RG ${lineWidth} w ${x} ${y} ${width} ${height} re B`);
  }

  filledRect(x, y, width, height, fill = [0.0, 0.52, 0.64]) {
    this.command(`${fill.join(' ')} rg ${x} ${y} ${width} ${height} re f`);
  }

  wrapped(value, x, y, maxChars, size = 8.5, font = FONT.regular, color = [0.06, 0.09, 0.12], leading = 10.5) {
    const lines = splitText(value, maxChars);
    lines.forEach((line, index) => this.text(line, x, y - index * leading, size, font, color));
    return lines.length * leading;
  }

  footer() {
    const footerY = 34;
    this.line(MARGIN, footerY + 32, PAGE.width - MARGIN, footerY + 32, [0.86, 0.89, 0.93], 0.8);
    if (this.footerBrandObjectId && this.footerBrand) {
      const logoW = 92;
      const logoH = (this.footerBrand.height / this.footerBrand.width) * logoW;
      this.command(`q ${logoW} 0 0 ${logoH.toFixed(2)} ${MARGIN} ${(footerY - 10).toFixed(2)} cm /ImFooterBrand Do Q`);
    } else {
      this.text('AgroGenomaX', MARGIN, footerY + 10, 13, FONT.bold);
    }
    const centerX = PAGE.width / 2 + 18;
    this.centeredText('Inteligencia que garantiza rentabilidad y sostenibilidad por metro cuadrado', centerX, footerY + 16, 8, FONT.bold);
    this.centeredText('www.agrogenomax.com', centerX, footerY + 4, 8, FONT.bold);
    this.text(`Página ${this.pageNumber} de ${this.totalPages}`, PAGE.width - 96, footerY + 7, 8, FONT.regular, [0.32, 0.38, 0.45]);
  }

  header() {
    this.pageNumber += 1;
    this.y = PAGE.height - TOP_MARGIN;
    if (this.logoObjectId && this.logo) {
      const logoW = 74;
      const logoH = (this.logo.height / this.logo.width) * logoW;
      this.command(`q ${logoW} 0 0 ${logoH.toFixed(2)} ${MARGIN} ${(this.y - logoH - 12).toFixed(2)} cm /ImLogo Do Q`);
    }
    if (this.brandObjectId && this.brand) {
      const brandW = 225;
      const brandH = (this.brand.height / this.brand.width) * brandW;
      this.command(`q ${brandW} 0 0 ${brandH.toFixed(2)} ${(PAGE.width / 2 - brandW / 2).toFixed(2)} ${(this.y - 40).toFixed(2)} cm /ImBrand Do Q`);
    } else {
      this.centeredText('AgroGenomaX', PAGE.width / 2, this.y - 16, 22, FONT.bold);
    }
    const textX = MARGIN + 95;
    this.text('REPORTE REPRODUCTIVO AGROGENOMAX', textX, this.y - 70, 15, FONT.bold, [0.0, 0.52, 0.64]);
    this.text(`Generado: ${this.generatedAt}`, textX, this.y - 87, 8.2, FONT.regular, [0.32, 0.38, 0.45]);
    this.text('AgroGenomaX BioTech', textX, this.y - 101, 9, FONT.bold, [0.0, 0.52, 0.64]);
    this.wrapped('Sistema Inteligente de Gestión Ganadera, Trazabilidad, Cumplimiento Sanitario y Ambiental', textX, this.y - 114, 66, 7.6, FONT.bold, [0.06, 0.09, 0.12], 8.5);

    if (this.qrObjectId && this.qr) {
      const qrSize = 58;
      const qrX = PAGE.width - MARGIN - qrSize;
      const qrY = this.y - qrSize - 20;
      this.rect(qrX - 10, qrY - 28, qrSize + 20, qrSize + 35, [0.0, 0.52, 0.64], [1, 1, 1], 1);
      this.command(`q ${qrSize} 0 0 ${qrSize} ${qrX} ${qrY} cm /ImQr Do Q`);
      this.centeredText('Escanear QR para', qrX + qrSize / 2, qrY - 13, 6.5, FONT.bold);
      this.centeredText('validar autenticidad', qrX + qrSize / 2, qrY - 22, 6.5, FONT.bold);
    }
    this.line(MARGIN, this.y - 140, PAGE.width - MARGIN, this.y - 140, [0.6, 1, 0], 3);
    this.y -= 165;
  }

  newPage() {
    this.footer();
    this.pages.push(this.current.join('\n'));
    this.current = [];
    this.header();
  }

  ensureSpace(height) {
    if (this.y - height < FOOTER_SAFE_Y) this.newPage();
  }

  sectionTitle(title, nextHeight = 28) {
    this.ensureSpace(nextHeight + 32);
    this.text(title.toUpperCase(), MARGIN, this.y, 12, FONT.bold, [0.0, 0.52, 0.64]);
    this.line(MARGIN, this.y - 8, PAGE.width - MARGIN, this.y - 8, [0.86, 0.89, 0.93], 1);
    this.y -= 24;
  }

  metricGrid(items, columns = 3) {
    const gap = 10;
    const width = (PAGE.width - MARGIN * 2 - gap * (columns - 1)) / columns;
    const heights = items.map((item) => {
      const valueLines = splitText(item.value, columns === 2 ? 42 : 26).length;
      return Math.max(58, 32 + valueLines * 10);
    });
    for (let index = 0; index < items.length; index += columns) {
      const row = items.slice(index, index + columns);
      const rowHeight = Math.max(...heights.slice(index, index + columns));
      this.ensureSpace(rowHeight + 10);
      row.forEach((item, col) => {
        const x = MARGIN + col * (width + gap);
        const y = this.y - rowHeight;
        const color = toneColor(item.tone);
        this.rect(x, y, width, rowHeight, [0.86, 0.89, 0.93], [1, 1, 1], 1);
        this.filledRect(x, y, 4, rowHeight, color);
        this.text(item.label.toUpperCase(), x + 12, this.y - 17, 7.2, FONT.bold, [0.32, 0.38, 0.45]);
        this.wrapped(item.value, x + 12, this.y - 33, columns === 2 ? 42 : 26, 9.2, FONT.bold, color, 10.5);
        if (item.detail) this.wrapped(item.detail, x + 12, y + 13, columns === 2 ? 42 : 26, 7.4, FONT.regular, [0.32, 0.38, 0.45], 8);
      });
      this.y -= rowHeight + 10;
    }
  }

  panel(title, lines, tone = 'info') {
    const bodyLines = lines.flatMap((line) => splitText(line, 92));
    const height = Math.max(62, 34 + bodyLines.length * 10.5);
    this.ensureSpace(height + 12);
    const color = toneColor(tone);
    this.rect(MARGIN, this.y - height, PAGE.width - MARGIN * 2, height, color, [1, 1, 1], 1.2);
    this.filledRect(MARGIN, this.y - height, 5, height, color);
    this.text(title.toUpperCase(), MARGIN + 14, this.y - 18, 10, FONT.bold, color);
    bodyLines.forEach((line, index) => this.text(line, MARGIN + 14, this.y - 34 - index * 10.5, 8.7, FONT.regular));
    this.y -= height + 12;
  }

  eventCard(event) {
    const fields = [
      ['Fecha', event.fecha],
      ['Tipo evento', event.tipo],
      ['Método', event.metodo],
      ['Resultado', event.resultado],
      ['Responsable', event.responsable],
      ['Costo', event.costo],
      ['Observaciones', event.observaciones],
    ];
    const height = 116;
    this.ensureSpace(height + 10);
    this.rect(MARGIN, this.y - height, PAGE.width - MARGIN * 2, height, [0.82, 0.87, 0.91], [1, 1, 1]);
    this.filledRect(MARGIN, this.y - height, 5, height, toneColor(event.tone));
    fields.forEach(([label, value], index) => {
      const col = index % 3;
      const row = Math.floor(index / 3);
      const x = MARGIN + 14 + col * 176;
      const y = this.y - 20 - row * 33;
      this.text(label.toUpperCase(), x, y, 6.8, FONT.bold, [0.32, 0.38, 0.45]);
      this.wrapped(value, x, y - 11, 24, 8.3, FONT.regular, [0.06, 0.09, 0.12], 8.4);
    });
    this.y -= height + 10;
  }

  evidenceCard(item) {
    const height = 64;
    this.ensureSpace(height + 10);
    this.rect(MARGIN, this.y - height, PAGE.width - MARGIN * 2, height, [0.82, 0.87, 0.91], [1, 1, 1]);
    const fields = [
      ['Tipo', item.tipo],
      ['Nombre o referencia', item.nombre],
      ['Fecha', item.fecha],
      ['Observación', item.observacion],
    ];
    fields.forEach(([label, value], index) => {
      const x = MARGIN + 14 + index * 130;
      this.text(label.toUpperCase(), x, this.y - 20, 6.8, FONT.bold, [0.32, 0.38, 0.45]);
      this.wrapped(value, x, this.y - 32, 18, 8.2, FONT.regular, [0.06, 0.09, 0.12], 8.5);
    });
    this.y -= height + 10;
  }

  async build(report) {
    this.generatedAt = report.generatedAt;
    const authUrl = `https://agrogenomax.pages.dev/qr/${encodeURIComponent(report.animal.qr || '')}`;
    const [logo, brand, footerBrand] = await Promise.all([
      loadImage('/agx-report-logo-white.jpeg'),
      loadImage('/agx-pdf-wordmark-color-vivid.jpeg'),
      loadImage('/agx-pdf-footer-logo.jpeg'),
    ]);
    this.logo = logo;
    this.brand = brand;
    this.footerBrand = footerBrand;
    if (this.logo) this.logoObjectId = this.addObject(`<< /Type /XObject /Subtype /Image /Width ${this.logo.width} /Height ${this.logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${this.logo.bytes.length} >>\nstream\n${binaryFromBytes(this.logo.bytes)}\nendstream`);
    if (this.brand) this.brandObjectId = this.addObject(`<< /Type /XObject /Subtype /Image /Width ${this.brand.width} /Height ${this.brand.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${this.brand.bytes.length} >>\nstream\n${binaryFromBytes(this.brand.bytes)}\nendstream`);
    if (this.footerBrand) this.footerBrandObjectId = this.addObject(`<< /Type /XObject /Subtype /Image /Width ${this.footerBrand.width} /Height ${this.footerBrand.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${this.footerBrand.bytes.length} >>\nstream\n${binaryFromBytes(this.footerBrand.bytes)}\nendstream`);
    this.qr = await loadQrCode(authUrl);
    if (this.qr) this.qrObjectId = this.addObject(`<< /Type /XObject /Subtype /Image /Width ${this.qr.width} /Height ${this.qr.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${this.qr.bytes.length} >>\nstream\n${binaryFromBytes(this.qr.bytes)}\nendstream`);

    this.header();
    this.sectionTitle('Datos del animal');
    this.metricGrid([
      { label: 'QR', value: report.animal.qr },
      { label: 'Nombre', value: report.animal.nombre },
      { label: 'Raza', value: report.animal.raza },
      { label: 'Sexo', value: report.animal.sexo },
      { label: 'Edad', value: report.animal.edad },
      { label: 'Categoría', value: report.animal.categoria },
    ]);

    this.sectionTitle('Estado reproductivo');
    this.metricGrid([
      { label: 'Estado actual', value: report.estado.estado, tone: report.estado.tone },
      { label: 'Edad reproductiva', value: report.estado.edadReproductiva, tone: report.estado.tone },
      { label: 'Madurez reproductiva', value: report.estado.madurez, tone: report.estado.madurezTone },
      { label: 'Decisión AGX', value: report.estado.decision, tone: report.estado.tone },
      { label: 'Próximo paso', value: report.estado.proximoPaso },
      { label: 'Rol reproductivo', value: report.estado.rol },
    ]);

    this.sectionTitle(report.animal.sexo === 'Macho' ? 'Indicadores reproductivos macho' : 'Indicadores reproductivos hembra');
    this.metricGrid(report.indicadores);

    if (report.descendencia?.length) {
      this.sectionTitle('Descendencia generada');
      this.metricGrid(report.descendencia, 2);
    }

    this.panel('Análisis integral', report.analisis.map((item) => `${item.label}: ${item.value}`));

    this.sectionTitle('Ranking AGX');
    this.metricGrid([
      { label: 'Índice', value: report.ranking.indice },
      { label: 'Clasificación', value: report.ranking.clasificacion },
      { label: 'Tendencia', value: report.ranking.tendencia },
      { label: 'Base de cálculo', value: report.ranking.explicacion },
    ], 2);

    this.sectionTitle('Historial de eventos reproductivos');
    if (report.eventos.length) report.eventos.forEach((event) => this.eventCard(event));
    else this.panel('Sin eventos reproductivos', ['No se registran eventos reproductivos para este animal.']);

    this.sectionTitle('Evidencias reproductivas');
    if (report.evidencias.length) report.evidencias.forEach((item) => this.evidenceCard(item));
    else this.panel('Sin evidencias reproductivas', ['No hay evidencias reproductivas registradas.']);

    this.panel('Nota técnica', ['Reporte generado con datos registrados en AgroGenomaX. La interpretación final debe ser validada por criterio profesional veterinario.'], 'info');

    this.ensureSpace(140);
    this.sectionTitle('Firma del profesional responsable');
    this.rect(MARGIN, this.y - 112, PAGE.width - MARGIN * 2, 112, [0.82, 0.87, 0.91], [1, 1, 1]);
    this.text('Nombre: ______________________________', MARGIN + 14, this.y - 24, 9, FONT.regular);
    this.text('Matrícula o tarjeta profesional: ______________________________', MARGIN + 14, this.y - 46, 9, FONT.regular);
    this.text('Entidad o registro profesional: ______________________________', MARGIN + 14, this.y - 68, 9, FONT.regular);
    this.text('Firma: ______________________________', MARGIN + 330, this.y - 68, 9, FONT.regular);
    this.y -= 126;

    this.footer();
    this.pages.push(this.current.join('\n'));
    this.totalPages = String(this.pages.length);
    this.pages = this.pages.map((page) => page.replace(/__TOTAL_PAGES__/g, this.totalPages));

    const fontRegular = this.addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontBold = this.addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pageIds = [];
    const pagesRootId = this.objects.length + this.pages.length * 2 + 1;
    this.pages.forEach((content) => {
      const contentId = this.addObject(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      const xObjects = [];
      if (this.logoObjectId) xObjects.push(`/ImLogo ${this.logoObjectId} 0 R`);
      if (this.brandObjectId) xObjects.push(`/ImBrand ${this.brandObjectId} 0 R`);
      if (this.footerBrandObjectId) xObjects.push(`/ImFooterBrand ${this.footerBrandObjectId} 0 R`);
      if (this.qrObjectId) xObjects.push(`/ImQr ${this.qrObjectId} 0 R`);
      const xObject = xObjects.length ? `/XObject << ${xObjects.join(' ')} >>` : '';
      const pageId = this.addObject(`<< /Type /Page /Parent ${pagesRootId} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> ${xObject} >> /Contents ${contentId} 0 R >>`);
      pageIds.push(pageId);
    });
    const pagesId = this.addObject(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
    const catalogId = this.addObject(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

    const parts = ['%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'];
    const offsets = [0];
    this.objects.forEach((object, index) => {
      offsets.push(parts.join('').length);
      parts.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
    });
    const xrefOffset = parts.join('').length;
    parts.push(`xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`);
    offsets.slice(1).forEach((offset) => parts.push(`${String(offset).padStart(10, '0')} 00000 n \n`));
    parts.push(`trailer\n<< /Size ${this.objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
    const bytes = new Uint8Array(parts.join('').split('').map((char) => char.charCodeAt(0) & 0xff));
    return new Blob([bytes], { type: 'application/pdf' });
  }
}

export async function createReproductiveReportPdfBlob(report) {
  const builder = new PdfBuilder();
  return builder.build(report);
}

export function reproductiveReportFileName(nombreAnimal, codigoQr) {
  return `Reporte_Reproductivo_${safeFilePart(nombreAnimal)}_${safeFilePart(codigoQr)}.pdf`;
}
