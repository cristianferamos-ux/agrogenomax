const PAGE = { width: 612, height: 792 };
const MARGIN = 42;
const FOOTER_SAFE_Y = 132;
const FONT = {
  regular: 'F1',
  bold: 'F2',
};

function pdfEscape(value) {
  return String(value ?? '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function clean(value, fallback = '--') {
  const text = value === null || value === undefined || value === '' ? fallback : value;
  return String(text);
}

function auditValue(value) {
  const text = clean(value, 'NO REGISTRADO').trim();
  return text === '--' || /^no registrado$/i.test(text) ? 'NO REGISTRADO' : text;
}

function isMissing(value) {
  return auditValue(value) === 'NO REGISTRADO';
}

function estimatePdfTextWidth(value, size) {
  const text = clean(value, '');
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

function statusColor(status) {
  if (status === 'Vencida') return [1, 0.23, 0.23];
  if (status === 'Próxima a vencer' || status === 'Proxima a vencer') return [0.9, 0.68, 0];
  if (status === 'Vigente') return [0.28, 0.62, 0];
  return [0.42, 0.47, 0.55];
}

function statusMeta(status) {
  if (status === 'Vencida' || status === 'CRÍTICO' || status === 'CRITICO' || status === 'Crítico') {
    return {
      label: 'CRÍTICO',
      marker: '●',
      description: 'Existen vacunas vencidas.',
      color: [1, 0.23, 0.23],
      fill: [1, 0.94, 0.94],
    };
  }

  if (status === 'Próxima a vencer' || status === 'Proxima a vencer' || status === 'ATENCIÓN' || status === 'ATENCION' || status === 'Atención') {
    return {
      label: 'ATENCIÓN',
      marker: '●',
      description: 'Existe al menos una vacuna próxima a vencer.',
      color: [0.9, 0.68, 0],
      fill: [1, 0.98, 0.88],
    };
  }

  if (status === 'Vigente' || status === 'EXCELENTE' || status === 'Excelente') {
    return {
      label: 'EXCELENTE',
      marker: '●',
      description: 'Todas las vacunas vigentes.',
      color: [0.28, 0.62, 0],
      fill: [0.94, 1, 0.88],
    };
  }

  return {
    label: 'SIN PROGRAMACIÓN',
    marker: '●',
    description: 'No hay próximas aplicaciones programadas.',
    color: [0.42, 0.47, 0.55],
    fill: [0.95, 0.96, 0.97],
  };
}

function splitText(text, maxChars) {
  const words = clean(text).split(/\s+/);
  const lines = [];
  let current = '';

  words.forEach((word) => {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  });

  if (current) lines.push(current);
  return lines.length ? lines : ['--'];
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
    this.y = PAGE.height - MARGIN;
    this.pageNumber = 0;
    this.totalPages = '__TOTAL_PAGES__';
    this.logoObjectId = null;
    this.logo = null;
    this.brandObjectId = null;
    this.brand = null;
    this.footerBrandObjectId = null;
    this.footerBrand = null;
    this.qrObjectId = null;
    this.qr = null;
    this.authUrl = '';
  }

  addObject(content) {
    this.objects.push(content);
    return this.objects.length;
  }

  command(value) {
    this.current.push(value);
  }

  text(value, x, y, size = 10, font = FONT.regular, color = [0.06, 0.09, 0.12]) {
    this.command(
      `${color.join(' ')} rg BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfEscape(value)}) Tj ET`,
    );
  }

  centeredText(value, centerX, y, size = 10, font = FONT.regular, color = [0.06, 0.09, 0.12]) {
    const text = clean(value, '');
    const estimatedHalfWidth = estimatePdfTextWidth(text, size) / 2;
    this.text(text, centerX - estimatedHalfWidth, y, size, font, color);
  }

  line(x1, y1, x2, y2, color = [0.6, 1, 0], width = 1) {
    this.command(`${color.join(' ')} RG ${width} w ${x1} ${y1} m ${x2} ${y2} l S`);
  }

  rect(x, y, width, height, stroke = [0.86, 0.89, 0.93], fill = [1, 1, 1], lineWidth = 1) {
    this.command(`${fill.join(' ')} rg ${stroke.join(' ')} RG ${lineWidth} w ${x} ${y} ${width} ${height} re B`);
  }

  filledRect(x, y, width, height, fill = [0.06, 0.09, 0.12]) {
    this.command(`${fill.join(' ')} rg ${x} ${y} ${width} ${height} re f`);
  }

  drawWrapped(value, x, y, maxChars, size = 9, font = FONT.regular, color = [0.06, 0.09, 0.12], leading = 12) {
    const lines = splitText(value, maxChars);
    lines.forEach((line, index) => this.text(line, x, y - index * leading, size, font, color));
    return lines.length * leading;
  }

  legacyFooter() {
    this.line(MARGIN, 34, PAGE.width - MARGIN, 34, [0.86, 0.89, 0.93], 0.8);
    this.text('AgroGenomaX - Inteligencia que garantiza rentabilidad y sostenibilidad por metro cuadrado', MARGIN, 20, 7.8, FONT.bold, [0.06, 0.09, 0.12]);
    this.text(`Página ${this.pageNumber} de ${this.totalPages}`, PAGE.width - 96, 20, 8, FONT.regular, [0.32, 0.38, 0.45]);
  }

  legacyHeader(title, generatedAt) {
    this.pageNumber += 1;
    this.y = PAGE.height - MARGIN;
    if (this.logoObjectId && this.logo) {
      const logoW = 64;
      const logoH = (this.logo.height / this.logo.width) * logoW;
      this.command(`q ${logoW} 0 0 ${logoH.toFixed(2)} ${MARGIN} ${(this.y - logoH + 4).toFixed(2)} cm /ImLogo Do Q`);
      this.text('AgroGenomaX', MARGIN + 88, this.y - 12, 23, FONT.bold, [0.06, 0.09, 0.12]);
    } else {
      this.text('AgroGenomaX', MARGIN, this.y - 10, 24, FONT.bold, [0.06, 0.09, 0.12]);
    }
    this.text(title, MARGIN + 88, this.y - 28, 13, FONT.bold, [0.0, 0.52, 0.64]);
    this.text(`Generado: ${generatedAt}`, MARGIN + 88, this.y - 44, 8, FONT.regular, [0.32, 0.38, 0.45]);
    this.text('AgroGenomaX BioTech', MARGIN + 88, this.y - 58, 8.8, FONT.bold, [0.0, 0.52, 0.64]);
    this.drawWrapped('Sistema Inteligente de Gestión Ganadera, Trazabilidad, Cumplimiento Sanitario y Ambiental', MARGIN + 88, this.y - 70, 70, 7.4, FONT.bold, [0.06, 0.09, 0.12], 9);
    this.drawWrapped('Plataforma de gestión productiva, ambiental y agropecuaria.', MARGIN + 88, this.y - 96, 62, 7.4, FONT.regular, [0.32, 0.38, 0.45], 9);

    if (this.qrObjectId && this.qr) {
      const qrSize = 58;
      const qrX = PAGE.width - MARGIN - qrSize;
      const qrY = this.y - qrSize + 6;
      this.rect(qrX - 10, qrY - 28, qrSize + 20, qrSize + 35, [0.0, 0.52, 0.64], [1, 1, 1], 1);
      this.command(`q ${qrSize} 0 0 ${qrSize} ${qrX} ${qrY} cm /ImQr Do Q`);
      this.text('Escanear QR para', qrX - 4, qrY - 11, 5.3, FONT.bold, [0.06, 0.09, 0.12]);
      this.text('validar autenticidad', qrX - 5, qrY - 18, 5.3, FONT.bold, [0.06, 0.09, 0.12]);
    } else {
      this.drawWrapped('Validación: escanear QR para validar autenticidad', PAGE.width - 166, this.y - 28, 26, 7, FONT.bold, [0.06, 0.09, 0.12], 8);
    }

    this.line(MARGIN, this.y - 116, PAGE.width - MARGIN, this.y - 116, [0.6, 1, 0], 2.5);
    this.y -= 142;
  }

  newPage(title, generatedAt) {
    if (this.current.length) {
      this.footer();
      this.pages.push(this.current.join('\n'));
    }
    this.current = [];
    this.header(title, generatedAt);
  }

  footer() {
    this.line(MARGIN, 48, PAGE.width - MARGIN, 48, [0.86, 0.89, 0.93], 0.8);
    if (this.footerBrandObjectId && this.footerBrand) {
      const brandW = 88;
      const brandH = (this.footerBrand.height / this.footerBrand.width) * brandW;
      this.command(`q ${brandW} 0 0 ${brandH.toFixed(2)} ${MARGIN} 7 cm /ImFooterBrand Do Q`);
      const footerCenterX = (MARGIN + 100 + PAGE.width - 122) / 2;
      this.centeredText('Inteligencia que garantiza rentabilidad y sostenibilidad por metro cuadrado', footerCenterX, 30, 7.3, FONT.bold, [0.06, 0.09, 0.12]);
      this.centeredText('www.agrogenomax.com', footerCenterX, 19, 7.3, FONT.bold, [0.06, 0.09, 0.12]);
    } else {
      this.text('AgroGenomaX by CRH | Ganadería Inteligente', MARGIN, 22, 7.3, FONT.bold, [0.06, 0.09, 0.12]);
    }
    this.text(`Página ${this.pageNumber} de ${this.totalPages}`, PAGE.width - 96, 20, 8, FONT.regular, [0.32, 0.38, 0.45]);
  }

  header(title, generatedAt) {
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
    this.text(title, textX, this.y - 30, 11.5, FONT.bold, [0.0, 0.52, 0.64]);
    this.text(`Generado: ${generatedAt}`, textX, this.y - 44, 7.2, FONT.regular, [0.32, 0.38, 0.45]);
    this.text('AgroGenomaX BioTech', textX, this.y - 57, 7.8, FONT.bold, [0.0, 0.52, 0.64]);
    this.drawWrapped('Sistema Inteligente de Gestión Ganadera, Trazabilidad, Cumplimiento Sanitario y Ambiental', textX, this.y - 69, 70, 6.7, FONT.bold, [0.06, 0.09, 0.12], 8);

    if (this.qrObjectId && this.qr) {
      const qrSize = 58;
      const qrX = PAGE.width - MARGIN - qrSize;
      const qrY = this.y - qrSize + 6;
      this.rect(qrX - 10, qrY - 28, qrSize + 20, qrSize + 35, [0.0, 0.52, 0.64], [1, 1, 1], 1);
      this.command(`q ${qrSize} 0 0 ${qrSize} ${qrX} ${qrY} cm /ImQr Do Q`);
      this.text('Escanear QR para', qrX - 4, qrY - 11, 5.3, FONT.bold, [0.06, 0.09, 0.12]);
      this.text('validar autenticidad', qrX - 5, qrY - 18, 5.3, FONT.bold, [0.06, 0.09, 0.12]);
    } else {
      this.drawWrapped('Validación: escanear QR para validar autenticidad', PAGE.width - 166, this.y - 28, 26, 7, FONT.bold, [0.06, 0.09, 0.12], 8);
    }

    this.line(MARGIN, this.y - 116, PAGE.width - MARGIN, this.y - 116, [0.6, 1, 0], 2.5);
    this.y -= 142;
  }

  ensureSpace(height, title, generatedAt) {
    if (this.y - height < FOOTER_SAFE_Y) this.newPage(title, generatedAt);
  }

  sectionTitle(value, options = {}) {
    this.ensureSpace(22 + (options.minFollowingContent ?? 118), 'HISTORIAL SANITARIO', this.generatedAt);
    const label = options.uppercase === false ? value : value.toUpperCase();
    this.text(label, MARGIN, this.y, 10, FONT.bold, [0.0, 0.52, 0.64]);
    this.line(MARGIN, this.y - 5, PAGE.width - MARGIN, this.y - 5, [0.86, 0.89, 0.93], 0.7);
    this.y -= 22;
  }

  metricCard(label, value, x, y, width, height) {
    this.rect(x, y - height, width, height, [0.86, 0.89, 0.93], [1, 1, 1]);
    this.text(label.toUpperCase(), x + 8, y - 15, 6.8, FONT.bold, [0.32, 0.38, 0.45]);
    this.drawWrapped(value, x + 8, y - 33, Math.max(10, Math.floor(width / 6)), 10, FONT.bold, [0.06, 0.09, 0.12], 11);
  }

  pill(text, x, y, status) {
    const color = statusColor(status);
    this.rect(x, y - 16, 120, 20, color, [0.98, 0.99, 0.98], 1);
    this.text(text, x + 8, y - 10, 8, FONT.bold, color);
  }

  field(label, value, x, y, maxChars = 24) {
    const normalized = auditValue(value);
    const color = isMissing(normalized) ? [0.5, 0.55, 0.62] : [0.06, 0.09, 0.12];
    this.text(label.toUpperCase(), x, y, 6.5, FONT.bold, [0.32, 0.38, 0.45]);
    this.drawWrapped(normalized, x, y - 12, maxChars, 8.5, isMissing(normalized) ? FONT.bold : FONT.regular, color, 10);
  }

  generalStatusCard(status) {
    const meta = statusMeta(status);
    const height = 58;
    this.ensureSpace(height + 18, 'HISTORIAL SANITARIO', this.generatedAt);
    this.sectionTitle('Estado sanitario general');
    this.rect(MARGIN, this.y - height, PAGE.width - MARGIN * 2, height, meta.color, meta.fill, 1.2);
    this.filledRect(MARGIN + 17, this.y - 29, 9, 9, meta.color);
    this.text(meta.label, MARGIN + 34, this.y - 22, 15, FONT.bold, meta.color);
    this.text(meta.description, MARGIN + 34, this.y - 42, 10, FONT.regular, [0.06, 0.09, 0.12]);
    this.y -= height + 16;
  }

  vaccineLayout(vacuna) {
    const rows = [
      [['Fecha de aplicación', vacuna.fechaAplicacion], ['Próxima aplicación', vacuna.proximaAplicacion], ['Cuenta regresiva', vacuna.cuentaRegresiva]],
      [['Laboratorio', vacuna.laboratorio], ['Lote', vacuna.lote], ['Dosis', vacuna.dosis]],
      [['Vacunador', vacuna.vacunador], ['Matrícula profesional', vacuna.matricula], ['Registro profesional', vacuna.registro]],
      [['Aplicado por', vacuna.aplicadoPor], ['Veterinario responsable', vacuna.veterinario], ['Estado sanitario', vacuna.estado]],
    ];
    const rowHeights = rows.map((group) => {
      const maxLines = Math.max(...group.map(([, value]) => splitText(auditValue(value), 24).length));
      return 16 + maxLines * 10;
    });
    const observationLines = splitText(auditValue(vacuna.observaciones), 86).length;
    const detailsHeight = rowHeights.reduce((sum, value) => sum + value, 0);
    return {
      rows,
      rowHeights,
      height: 52 + detailsHeight + 18 + observationLines * 10 + 18,
      meta: statusMeta(vacuna.estado),
    };
  }

  drawVaccineCard(vacuna, generatedAt) {
    const layout = this.vaccineLayout(vacuna);
    this.ensureSpace(layout.height + 8, 'HISTORIAL SANITARIO', generatedAt);
    this.rect(MARGIN, this.y - layout.height, PAGE.width - MARGIN * 2, layout.height, [0.82, 0.87, 0.91], [1, 1, 1]);
    this.filledRect(MARGIN, this.y - layout.height, 5, layout.height, layout.meta.color);
    this.text('FICHA TÉCNICA DE VACUNACIÓN', MARGIN + 14, this.y - 15, 6.5, FONT.bold, [0.32, 0.38, 0.45]);
    this.text(vacuna.vacuna, MARGIN + 14, this.y - 31, 13, FONT.bold, layout.meta.color);
    this.pill(vacuna.estado, PAGE.width - MARGIN - 128, this.y - 10, vacuna.estado);

    const leftX = MARGIN + 12;
    const midX = MARGIN + 198;
    const rightX = MARGIN + 382;
    let rowY = this.y - 58;
    layout.rows.forEach((group, groupIndex) => {
      [leftX, midX, rightX].forEach((x, index) => {
        const [label, value] = group[index];
        this.field(label, value, x, rowY, 24);
      });
      rowY -= layout.rowHeights[groupIndex];
    });
    this.field('Observaciones', vacuna.observaciones, leftX, rowY, 86);
    this.y -= layout.height + 12;
  }

  async build({ animal, resumen, estadoGeneral, vacunaciones, generatedAt }) {
    this.generatedAt = generatedAt;
    this.authUrl = animal.authUrl || `https://agrogenomax.pages.dev/qr/${encodeURIComponent(animal.qr || '')}`;
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
    this.qr = await loadQrCode(this.authUrl);
    if (this.qr) {
      this.qrObjectId = this.addObject(
        `<< /Type /XObject /Subtype /Image /Width ${this.qr.width} /Height ${this.qr.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${this.qr.bytes.length} >>\nstream\n${binaryFromBytes(this.qr.bytes)}\nendstream`,
      );
    }

    this.header('HISTORIAL SANITARIO', generatedAt);
    this.sectionTitle('Información del animal');
    const cardW = 98;
    const cardH = 54;
    const animalCards = [
      ['Nombre', animal.nombre],
      ['QR', animal.qr],
      ['Raza', animal.raza],
      ['Sexo', animal.sexo],
      ['Edad', animal.edad],
      ['Predio', animal.predio],
      ['Potrero', animal.potrero],
    ];
    animalCards.forEach(([label, value], index) => {
      const col = index % 5;
      const row = Math.floor(index / 5);
      this.metricCard(label, value, MARGIN + col * 106, this.y - row * 62, cardW, cardH);
    });
    this.y -= Math.ceil(animalCards.length / 5) * 62 + 10;

    this.ensureSpace(102, 'HISTORIAL SANITARIO', generatedAt);
    this.sectionTitle('Resumen sanitario');
    const summaryCards = [
      ['Total', resumen.total],
      ['Vigentes', resumen.vigentes],
      ['Próximas a vencer', resumen.proximas],
      ['Vencidas', resumen.vencidas],
      ['Cumplimiento', resumen.cumplimiento],
    ];
    summaryCards.forEach(([label, value], index) => {
      const col = index % 3;
      const row = Math.floor(index / 3);
      this.metricCard(label, value, MARGIN + col * 176, this.y - row * 58, 166, 50);
    });
    this.y -= 122;
    this.generalStatusCard(estadoGeneral);

    if (vacunaciones.length) {
      const firstCard = this.vaccineLayout(vacunaciones[0]);
      this.ensureSpace(22 + firstCard.height + 12, 'HISTORIAL SANITARIO', generatedAt);
    } else {
      this.ensureSpace(80, 'HISTORIAL SANITARIO', generatedAt);
    }
    this.sectionTitle('Vacunaciones registradas');
    if (!vacunaciones.length) {
      this.rect(MARGIN, this.y - 42, PAGE.width - MARGIN * 2, 42, [0.72, 0.77, 0.82], [0.98, 0.99, 1]);
      this.text('No se registran vacunaciones para este animal.', MARGIN + 14, this.y - 25, 10, FONT.bold, [0.32, 0.38, 0.45]);
      this.y -= 58;
    }
    vacunaciones.forEach((vacuna) => this.drawVaccineCard(vacuna, generatedAt));

    const [generationDate, generationTime = 'NO REGISTRADO'] = String(generatedAt).split(',').map((part) => part.trim());
    this.ensureSpace(126, 'HISTORIAL SANITARIO', generatedAt);
    this.sectionTitle('Trazabilidad del documento');
    this.rect(MARGIN, this.y - 96, PAGE.width - MARGIN * 2, 96, [0.82, 0.87, 0.91], [1, 1, 1]);
    this.field('Documento generado por', 'AgroGenomaX', MARGIN + 14, this.y - 20, 28);
    this.field('Fecha generación', generationDate, MARGIN + 198, this.y - 20, 26);
    this.field('Hora generación', generationTime, MARGIN + 382, this.y - 20, 22);
    this.field('Animal', animal.nombre, MARGIN + 14, this.y - 54, 28);
    this.field('QR', animal.qr, MARGIN + 198, this.y - 54, 26);
    this.field('Estado sanitario general', statusMeta(estadoGeneral).label, MARGIN + 382, this.y - 54, 22);
    this.text('Documento verificable mediante QR.', MARGIN + 14, this.y - 84, 8.5, FONT.bold, [0.0, 0.52, 0.64]);
    this.y -= 112;

    const responsible = vacunaciones.find((item) => !isMissing(item.vacunador) || !isMissing(item.matricula) || !isMissing(item.registro)) || {};
    const certificate = 'Certifico que la información sanitaria registrada en este documento corresponde a los registros almacenados en la plataforma AgroGenomaX.';
    this.ensureSpace(166, 'HISTORIAL SANITARIO', generatedAt);
    this.sectionTitle('Firma del profesional responsable', { uppercase: false });
    this.rect(MARGIN, this.y - 136, PAGE.width - MARGIN * 2, 136, [0.82, 0.87, 0.91], [1, 1, 1]);
    this.line(MARGIN + 300, this.y - 36, PAGE.width - MARGIN - 14, this.y - 36, [0.06, 0.09, 0.12], 1.5);
    this.text('Firma', MARGIN + 410, this.y - 50, 7.6, FONT.bold, [0.32, 0.38, 0.45]);
    this.field('Nombre', responsible.vacunador, MARGIN + 14, this.y - 24, 32);
    this.field('Matrícula profesional', responsible.matricula, MARGIN + 14, this.y - 50, 32);
    this.field('Entidad o registro profesional', responsible.registro, MARGIN + 14, this.y - 76, 32);
    this.text('Profesional responsable de la vacunación.', MARGIN + 310, this.y - 76, 8.5, FONT.bold, [0.0, 0.52, 0.64]);
    this.drawWrapped(certificate, MARGIN + 14, this.y - 108, 94, 8.2, FONT.bold, [0.06, 0.09, 0.12], 10);
    this.y -= 150;

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
      const pageId = this.addObject(
        `<< /Type /Page /Parent ${pagesRootId} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> ${xObject} >> /Contents ${contentId} 0 R >>`,
      );
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

export async function createSanitaryHistoryPdfBlob(report) {
  const builder = new PdfBuilder();
  return builder.build(report);
}

export function sanitaryHistoryFileName(nombreAnimal, codigoQr) {
  return `Historial_Sanitario_${safeFilePart(nombreAnimal)}_${safeFilePart(codigoQr)}.pdf`;
}
