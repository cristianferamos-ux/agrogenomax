const PAGE = { width: 612, height: 792 };
const MARGIN = 42;
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

function estimatePdfTextWidth(value, size) {
  const text = sanitize(value);
  const units = Array.from(text).reduce((sum, char) => {
    if (char === ' ') return sum + 0.28;
    if ('.,:;|!/\\'.includes(char)) return sum + 0.22;
    if ('ilIjtfr'.includes(char)) return sum + 0.28;
    if ('mwMW@'.includes(char)) return sum + 0.78;
    if (/[A-ZÁÉÍÓÚÑ]/.test(char)) return sum + 0.62;
    if (/[0-9]/.test(char)) return sum + 0.56;
    return sum + 0.5;
  }, 0);
  return units * size;
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

function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'NO REGISTRADO';
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(number);
}

function formatMetric(value, suffix = '') {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'NO REGISTRADO';
  return `${new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number)}${suffix}`;
}

function statusColor(className = '') {
  if (className.includes('estado-vencida')) return [1, 0.23, 0.23];
  if (className.includes('estado-proxima')) return [0.9, 0.68, 0];
  if (className.includes('estado-vigente')) return [0.28, 0.62, 0];
  return [0.0, 0.52, 0.64];
}

function binaryFromBytes(bytes) {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
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

async function loadLogo() {
  try {
    const src = '/agx-report-logo-white.jpeg';
    const [response, size] = await Promise.all([fetch(src), getImageSize(src)]);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, ...size };
  } catch {
    return null;
  }
}

async function loadBrandWordmark() {
  try {
    const src = '/agx-pdf-wordmark-color-vivid.jpeg';
    const [response, size] = await Promise.all([fetch(src), getImageSize(src)]);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, ...size };
  } catch {
    return null;
  }
}

async function loadFooterWordmark() {
  try {
    const src = '/agx-pdf-footer-logo.jpeg';
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

class PdfBuilder {
  constructor() {
    this.objects = [];
    this.pages = [];
    this.current = [];
    this.pageNumber = 0;
    this.totalPages = '__TOTAL_PAGES__';
    this.y = PAGE.height - MARGIN;
    this.generatedAt = '';
    this.logoObjectId = null;
    this.logo = null;
    this.brandObjectId = null;
    this.brand = null;
    this.footerBrandObjectId = null;
    this.footerBrand = null;
    this.qrObjectId = null;
    this.qr = null;
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
    const text = sanitize(value);
    const estimatedHalfWidth = estimatePdfTextWidth(text, size) / 2;
    this.text(text, centerX - estimatedHalfWidth, y, size, font, color);
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

  legacyFooter() {
    this.line(MARGIN, 34, PAGE.width - MARGIN, 34, [0.86, 0.89, 0.93], 0.8);
    this.text('AgroGenomaX - Inteligencia que garantiza rentabilidad y sostenibilidad por metro cuadrado', MARGIN, 20, 7.5, FONT.bold);
    this.text(`Página ${this.pageNumber} de ${this.totalPages}`, PAGE.width - 96, 20, 8, FONT.regular, [0.32, 0.38, 0.45]);
  }

  legacyHeader() {
    this.pageNumber += 1;
    this.y = PAGE.height - MARGIN;
    if (this.logoObjectId && this.logo) {
      const logoW = 64;
      const logoH = (this.logo.height / this.logo.width) * logoW;
      this.command(`q ${logoW} 0 0 ${logoH.toFixed(2)} ${MARGIN} ${(this.y - logoH + 4).toFixed(2)} cm /ImLogo Do Q`);
      this.text('AgroGenomaX', MARGIN + 88, this.y - 12, 23, FONT.bold);
    } else {
      this.text('AgroGenomaX', MARGIN, this.y - 8, 24, FONT.bold);
    }
    const textX = this.logoObjectId ? MARGIN + 88 : MARGIN;
    this.text('HISTORIA CLÍNICA ANIMAL', textX, this.y - 28, 13, FONT.bold, [0.0, 0.52, 0.64]);
    this.text(`Generado: ${this.generatedAt}`, textX, this.y - 44, 8, FONT.regular, [0.32, 0.38, 0.45]);
    this.text('AgroGenomaX BioTech', textX, this.y - 58, 8.8, FONT.bold, [0.0, 0.52, 0.64]);
    this.wrapped('Sistema Inteligente de Gestión Ganadera, Trazabilidad, Cumplimiento Sanitario y Ambiental', textX, this.y - 70, 70, 7.4, FONT.bold, [0.06, 0.09, 0.12], 8);

    if (this.qrObjectId && this.qr) {
      const qrSize = 58;
      const qrX = PAGE.width - MARGIN - qrSize;
      const qrY = this.y - qrSize + 6;
      this.rect(qrX - 10, qrY - 28, qrSize + 20, qrSize + 35, [0.0, 0.52, 0.64], [1, 1, 1], 1);
      this.command(`q ${qrSize} 0 0 ${qrSize} ${qrX} ${qrY} cm /ImQr Do Q`);
      this.text('Escanear QR para', qrX - 4, qrY - 11, 5.3, FONT.bold);
      this.text('validar autenticidad', qrX - 5, qrY - 18, 5.3, FONT.bold);
    } else {
      this.rect(PAGE.width - MARGIN - 92, this.y - 74, 92, 58, [0.0, 0.52, 0.64], [1, 1, 1]);
      this.text('QR animal', PAGE.width - MARGIN - 76, this.y - 38, 8.5, FONT.bold, [0.0, 0.52, 0.64]);
    }
    this.line(MARGIN, this.y - 98, PAGE.width - MARGIN, this.y - 98, [0.6, 1, 0], 2.5);
    this.y -= 124;
  }

  newPage() {
    if (this.current.length) {
      this.footer();
      this.pages.push(this.current.join('\n'));
    }
    this.current = [];
    this.header();
  }

  footer() {
    this.line(MARGIN, 48, PAGE.width - MARGIN, 48, [0.86, 0.89, 0.93], 0.8);
    if (this.footerBrandObjectId && this.footerBrand) {
      const brandW = 88;
      const brandH = (this.footerBrand.height / this.footerBrand.width) * brandW;
      this.command(`q ${brandW} 0 0 ${brandH.toFixed(2)} ${MARGIN} 7 cm /ImFooterBrand Do Q`);
      const footerCenterX = (MARGIN + 100 + PAGE.width - 122) / 2;
      this.centeredText('Inteligencia que garantiza rentabilidad y sostenibilidad por metro cuadrado', footerCenterX, 30, 7.2, FONT.bold, [0.06, 0.09, 0.12]);
      this.centeredText('www.agrogenomax.com', footerCenterX, 19, 7.2, FONT.bold, [0.06, 0.09, 0.12]);
    } else {
      this.text('AgroGenomaX by CRH | Ganadería Inteligente', MARGIN, 22, 7.2, FONT.bold);
    }
    this.text(`Página ${this.pageNumber} de ${this.totalPages}`, PAGE.width - 96, 20, 8, FONT.regular, [0.32, 0.38, 0.45]);
  }

  output() {
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

  header() {
    this.pageNumber += 1;
    this.y = PAGE.height - MARGIN;
    const textX = this.logoObjectId && this.logo ? MARGIN + 88 : MARGIN;
    if (this.logoObjectId && this.logo) {
      const logoW = 72;
      const logoH = (this.logo.height / this.logo.width) * logoW;
      this.command(`q ${logoW} 0 0 ${logoH.toFixed(2)} ${MARGIN} ${(this.y - logoH + 4).toFixed(2)} cm /ImLogo Do Q`);
    }
    if (this.brandObjectId && this.brand) {
      const brandW = 236;
      const brandH = (this.brand.height / this.brand.width) * brandW;
      const brandX = (PAGE.width - brandW) / 2;
      this.command(`q ${brandW} 0 0 ${brandH.toFixed(2)} ${brandX.toFixed(2)} ${(this.y - 20).toFixed(2)} cm /ImBrand Do Q`);
    }
    this.text('HISTORIA CLÍNICA ANIMAL', textX, this.y - 30, 11.5, FONT.bold, [0.0, 0.52, 0.64]);
    this.text(`Generado: ${this.generatedAt}`, textX, this.y - 44, 7.2, FONT.regular, [0.32, 0.38, 0.45]);
    this.text('AgroGenomaX BioTech', textX, this.y - 57, 7.8, FONT.bold, [0.0, 0.52, 0.64]);
    this.wrapped('Sistema Inteligente de Gestión Ganadera, Trazabilidad, Cumplimiento Sanitario y Ambiental', textX, this.y - 69, 70, 6.7, FONT.bold, [0.06, 0.09, 0.12], 8);

    if (this.qrObjectId && this.qr) {
      const qrSize = 58;
      const qrX = PAGE.width - MARGIN - qrSize;
      const qrY = this.y - qrSize + 6;
      this.rect(qrX - 10, qrY - 28, qrSize + 20, qrSize + 35, [0.0, 0.52, 0.64], [1, 1, 1], 1);
      this.command(`q ${qrSize} 0 0 ${qrSize} ${qrX} ${qrY} cm /ImQr Do Q`);
      this.text('Escanear QR para', qrX - 4, qrY - 11, 5.3, FONT.bold);
      this.text('validar autenticidad', qrX - 5, qrY - 18, 5.3, FONT.bold);
    } else {
      this.rect(PAGE.width - MARGIN - 92, this.y - 74, 92, 58, [0.0, 0.52, 0.64], [1, 1, 1]);
      this.text('QR animal', PAGE.width - MARGIN - 76, this.y - 38, 8.5, FONT.bold, [0.0, 0.52, 0.64]);
    }
    this.line(MARGIN, this.y - 98, PAGE.width - MARGIN, this.y - 98, [0.6, 1, 0], 2.5);
    this.y -= 124;
  }

  ensureSpace(height) {
    if (this.y - height < FOOTER_SAFE_Y) this.newPage();
  }

  sectionTitle(value, minFollowingContent = 118) {
    this.ensureSpace(22 + minFollowingContent);
    this.text(value.toUpperCase(), MARGIN, this.y, 10, FONT.bold, [0.0, 0.52, 0.64]);
    this.line(MARGIN, this.y - 5, PAGE.width - MARGIN, this.y - 5, [0.86, 0.89, 0.93], 0.8);
    this.y -= 22;
  }

  metricGrid(items, columns = 3) {
    const gap = 10;
    const width = (PAGE.width - MARGIN * 2 - gap * (columns - 1)) / columns;
    const height = 58;
    items.forEach((item, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      const x = MARGIN + col * (width + gap);
      const y = this.y - row * (height + gap);
      const color = statusColor(item.className);
      this.rect(x, y - height, width, height, [0.86, 0.89, 0.93], [1, 1, 1]);
      this.filledRect(x, y - height, 4, height, color);
      this.text(item.label.toUpperCase(), x + 10, y - 16, 6.7, FONT.bold, [0.32, 0.38, 0.45]);
      this.wrapped(item.value, x + 10, y - 34, Math.max(14, Math.floor(width / 6)), 9.5, FONT.bold, color, 10.5);
    });
    this.y -= Math.ceil(items.length / columns) * (height + gap) + 8;
  }

  panel(title, lines, className = '') {
    const textLines = lines.flatMap((line) => splitText(line, 92));
    const height = 38 + textLines.length * 11;
    this.ensureSpace(height + 10);
    const color = statusColor(className);
    this.rect(MARGIN, this.y - height, PAGE.width - MARGIN * 2, height, color, [1, 1, 1], 1);
    this.filledRect(MARGIN, this.y - height, 5, height, color);
    this.text(title.toUpperCase(), MARGIN + 14, this.y - 17, 10, FONT.bold, color);
    let y = this.y - 36;
    lines.forEach((line) => {
      y -= this.wrapped(line, MARGIN + 14, y, 92, 8.8, FONT.regular, [0.06, 0.09, 0.12], 11);
    });
    this.y -= height + 12;
  }

  treatmentCard(row) {
    const fields = [
      ['Código evento', row.codigo],
      ['Fecha', row.fecha],
      ['Diagnóstico', row.diagnostico],
      ['Medicamento', row.medicamento],
      ['Principio activo', row.principioActivo],
      ['Dosis', row.dosis],
      ['Duración', row.duracion],
      ['Retiro carne', row.retiroCarne],
      ['Retiro leche', row.retiroLeche],
      ['Costo total', row.costoTotal],
      ['Responsable', row.responsable],
      ['Estado', row.estado],
    ];
    const height = 142;
    this.ensureSpace(height + 10);
    const color = statusColor(row.className);
    this.rect(MARGIN, this.y - height, PAGE.width - MARGIN * 2, height, [0.82, 0.87, 0.91], [1, 1, 1]);
    this.filledRect(MARGIN, this.y - height, 5, height, color);
    this.text(clean(row.diagnostico, 'SIN DIAGNÓSTICO'), MARGIN + 14, this.y - 18, 12, FONT.bold, color);
    fields.forEach(([label, value], index) => {
      const col = index % 3;
      const rowIndex = Math.floor(index / 3);
      const x = MARGIN + 14 + col * 176;
      const y = this.y - 42 - rowIndex * 25;
      this.text(label.toUpperCase(), x, y, 6.5, FONT.bold, [0.32, 0.38, 0.45]);
      this.wrapped(value, x, y - 11, 24, 8.2, FONT.regular, [0.06, 0.09, 0.12], 8);
    });
    this.y -= height + 12;
  }

  evidenceCard(item) {
    const height = 78;
    this.ensureSpace(height + 8);
    this.rect(MARGIN, this.y - height, PAGE.width - MARGIN * 2, height, [0.82, 0.87, 0.91], [1, 1, 1]);
    const fields = [
      ['Archivo', item.nombre],
      ['Tipo', item.tipo],
      ['Fecha captura', item.fecha],
      ['Georreferencia', item.georreferencia],
      ['Observación', item.observacion],
    ];
    fields.forEach(([label, value], index) => {
      const col = index % 3;
      const row = Math.floor(index / 3);
      const x = MARGIN + 14 + col * 176;
      const y = this.y - 20 - row * 27;
      this.text(label.toUpperCase(), x, y, 6.5, FONT.bold, [0.32, 0.38, 0.45]);
      this.wrapped(value, x, y - 11, 24, 8.2, FONT.regular, [0.06, 0.09, 0.12], 8);
    });
    this.y -= height + 10;
  }

  async build(report) {
    this.generatedAt = report.generatedAt;
    const authUrl = report.animal.authUrl || `https://agrogenomax.pages.dev/qr/${encodeURIComponent(report.animal.qr || '')}`;
    const [logo, brand, footerBrand] = await Promise.all([loadLogo(), loadBrandWordmark(), loadFooterWordmark()]);
    this.logo = logo;
    this.brand = brand;
    this.footerBrand = footerBrand;
    if (this.logo) {
      this.logoObjectId = this.addObject(
        `<< /Type /XObject /Subtype /Image /Width ${this.logo.width} /Height ${this.logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${this.logo.bytes.length} >>\nstream\n${binaryFromBytes(this.logo.bytes)}\nendstream`,
      );
    }
    if (this.brand) {
      this.brandObjectId = this.addObject(
        `<< /Type /XObject /Subtype /Image /Width ${this.brand.width} /Height ${this.brand.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${this.brand.bytes.length} >>\nstream\n${binaryFromBytes(this.brand.bytes)}\nendstream`,
      );
    }
    if (this.footerBrand) {
      this.footerBrandObjectId = this.addObject(
        `<< /Type /XObject /Subtype /Image /Width ${this.footerBrand.width} /Height ${this.footerBrand.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${this.footerBrand.bytes.length} >>\nstream\n${binaryFromBytes(this.footerBrand.bytes)}\nendstream`,
      );
    }
    this.qr = await loadQrCode(authUrl);
    if (this.qr) {
      this.qrObjectId = this.addObject(
        `<< /Type /XObject /Subtype /Image /Width ${this.qr.width} /Height ${this.qr.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${this.qr.bytes.length} >>\nstream\n${binaryFromBytes(this.qr.bytes)}\nendstream`,
      );
    }
    this.header();

    this.sectionTitle('Información del animal');
    this.metricGrid([
      { label: 'Animal', value: report.animal.nombre },
      { label: 'QR', value: report.animal.qr },
      { label: 'Raza', value: report.animal.raza },
      { label: 'Sexo', value: report.animal.sexo },
      { label: 'Edad', value: report.animal.edad },
      { label: 'Categoría', value: report.animal.categoria },
    ]);

    this.sectionTitle('Resumen sanitario');
    this.metricGrid([
      { label: 'Estado clínico', value: report.resumen.estado, className: report.resumen.estadoClass },
      { label: 'Eventos sanitarios', value: report.resumen.total },
      { label: 'Costo sanitario', value: report.resumen.costo },
      { label: 'Riesgo', value: report.resumen.riesgo, className: report.resumen.riesgoClass },
      { label: 'Índice sanitario', value: report.resumen.indice, className: report.score.className },
      { label: 'Tendencia', value: report.trend.label, className: report.trend.className },
    ]);

    this.panel('Análisis clínico AgroGenomaX', [
      report.clinical.title,
      report.clinical.text,
      'Análisis generado con datos registrados en AgroGenomaX. La validación clínica final debe realizarse bajo criterio profesional veterinario.',
    ], report.clinical.className);

    const hasTreatments = report.tratamientos.length > 0;

    this.sectionTitle('Historial clínico');
    if (hasTreatments) report.tratamientos.forEach((row) => this.treatmentCard(row));
    else this.panel('Sin tratamientos registrados', ['No se registran tratamientos clínicos para este animal.']);

    if (!hasTreatments) {
      this.panel('Información clínica no registrada', [
        'No hay diagnósticos clínicos registrados.',
        'No hay medicamentos, costos, retiros sanitarios ni evidencias clínicas registradas.',
        'Este PDF conserva la ficha real del animal y deja vacías las secciones sin soporte en la API.',
      ], 'estado-sin-programacion');

      this.sectionTitle('Evidencias clínicas');
      this.panel('Sin evidencias clínicas', ['No hay evidencias clínicas registradas.']);

      this.panel('Impacto reproductivo', ['Sin información clínica registrada para evaluar impacto reproductivo.'], 'estado-sin-programacion');

      this.ensureSpace(150);
      this.sectionTitle('Certificación técnica');
      this.rect(MARGIN, this.y - 118, PAGE.width - MARGIN * 2, 118, [0.82, 0.87, 0.91], [1, 1, 1]);
      this.wrapped('Certifico que la información clínica registrada en este documento corresponde a los registros almacenados en la plataforma AgroGenomaX.', MARGIN + 14, this.y - 32, 96, 8, FONT.bold, [0.06, 0.09, 0.12], 10);

      this.footer();
      this.pages.push(this.current.join('\n'));
      this.totalPages = String(this.pages.length);
      this.pages = this.pages.map((page) => page.replace(/__TOTAL_PAGES__/g, this.totalPages));
      return this.output();
    }

    this.panel('Restricción comercial temporal', report.retiro.lines, report.retiro.className);

    this.sectionTitle('Impacto productivo y económico');
    this.metricGrid([
      { label: 'GDP previo', value: report.impact.gdpBefore },
      { label: 'GDP posterior', value: report.impact.gdpAfter },
      { label: 'Variación', value: report.impact.variation, className: report.impact.className },
      { label: 'Costo sanitario', value: report.economia.costo },
      { label: 'Valor recuperado', value: report.economia.valorRecuperado, className: report.economia.resultClass },
      { label: 'Resultado económico', value: report.economia.resultado, className: report.economia.resultClass },
    ]);
    this.panel('Decisión recomendada AgroGenomaX', [report.decision.title, ...report.decision.items], report.decision.className);

    this.sectionTitle('Score y predicción sanitaria');
    this.metricGrid([
      { label: 'Clasificación', value: report.score.label, className: report.score.className },
      { label: 'Recomendación', value: report.score.recommendation, className: report.score.className },
      { label: 'Reincidencia', value: report.recurrence.state, className: report.recurrence.className },
      { label: 'Índice recuperación', value: report.prediction.recovery, className: report.prediction.className },
      { label: 'Riesgo recaída', value: report.prediction.relapse, className: report.prediction.className },
      { label: 'Próximo control', value: report.prediction.reviewDate },
    ]);
    this.panel('Nota del índice sanitario', ['Este índice es una estimación interna de AgroGenomaX basada en tratamientos, reincidencia, retiro sanitario, evolución productiva y estado clínico.']);

    this.sectionTitle('Timeline clínico');
    report.timeline.forEach((event) => this.panel(event.codigo || event.fecha, [
      `Fecha: ${event.fecha}`,
      `Evento: ${event.descripcion}`,
      `Estado: ${event.estado || event.tipo}`,
      `Resultado: ${event.resultado}`,
      `Costo: ${event.costo}`,
    ], event.className));

    this.sectionTitle('Evidencias clínicas');
    if (report.evidencias.length) report.evidencias.forEach((item) => this.evidenceCard(item));
    else this.panel('Sin evidencias clínicas', ['No hay evidencias clínicas registradas.']);

    this.panel('Impacto reproductivo', report.reproductive.lines, report.reproductive.className);

    this.ensureSpace(150);
    this.sectionTitle('Certificación técnica');
    this.rect(MARGIN, this.y - 118, PAGE.width - MARGIN * 2, 118, [0.82, 0.87, 0.91], [1, 1, 1]);
    this.text('Responsable técnico: ______________________________', MARGIN + 14, this.y - 22, 9, FONT.regular);
    this.text('Profesión: ______________________________', MARGIN + 14, this.y - 42, 9, FONT.regular);
    this.text('Matrícula o registro profesional: ______________________________', MARGIN + 14, this.y - 62, 9, FONT.regular);
    this.text('Entidad: ______________________________', MARGIN + 14, this.y - 82, 9, FONT.regular);
    this.text('Firma: ______________________________', MARGIN + 330, this.y - 82, 9, FONT.regular);
    this.wrapped('Certifico que la información clínica registrada en este documento corresponde a los registros almacenados en la plataforma AgroGenomaX.', MARGIN + 14, this.y - 104, 96, 8, FONT.bold, [0.06, 0.09, 0.12], 10);

    this.footer();
    this.pages.push(this.current.join('\n'));
    return this.output();
  }
}

export async function createClinicalHistoryPdfBlob(report) {
  const builder = new PdfBuilder();
  return builder.build(report);
}

export function clinicalHistoryFileName(nombreAnimal, codigoQr) {
  return `Historia_Clinica_${safeFilePart(nombreAnimal)}_${safeFilePart(codigoQr)}.pdf`;
}
