const PAGE = { width: 612, height: 792 };
const MARGIN = 42;
const TOP_MARGIN = 57;
const FOOTER_SAFE_Y = 132;
const FONT = { regular: 'F1', bold: 'F2' };

function decodeMojibakeOnce(text) {
  if ([...text].some((char) => char.charCodeAt(0) > 255)) return text;
  try {
    const encoded = [...text].map((char) => '%' + char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    return decodeURIComponent(encoded);
  } catch {
    return text;
  }
}

function sanitizePdfText(value) {
  let text = String(value ?? '');
  for (let index = 0; index < 3; index += 1) {
    const decoded = decodeMojibakeOnce(text);
    if (decoded === text) break;
    text = decoded;
  }
  return text
    .replace(/[\u2197\u2192\u2198]/g, '')
    .replace(/[\uFFFD]/g, '')
    .trim();
}

function pdfEscape(value) {
  return sanitizePdfText(value)
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function clean(value, fallback = 'NO REGISTRADO') {
  const text = sanitizePdfText(value);
  return value === null || value === undefined || value === '' || text === '—' ? fallback : text;
}

function estimatePdfTextWidth(value, size) {
  const text = sanitizePdfText(value);
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

function reportCode(generatedAt, qr) {
  const seed = `${qr || ''}${generatedAt || ''}`.replace(/\D/g, '');
  return `AGX-INF-${(seed.slice(-6) || '000001').padStart(6, '0')}`;
}

function safeFilePart(value) {
  return String(value || 'Animal')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'Animal';
}

function formatNumber(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
    : 'NO REGISTRADO';
}

function metric(value, suffix = '') {
  return Number.isFinite(value) ? `${formatNumber(value)}${suffix}` : 'NO REGISTRADO';
}

function monthsFromDays(value) {
  return Number.isFinite(value) ? `${formatNumber(value / 30.44)} meses` : '----';
}

function intervalFromDays(value) {
  if (!Number.isFinite(value)) return '----';
  return value === 1 ? '1 día' : `${Math.round(value)} días`;
}

function ageMonths(value) {
  if (typeof value === 'string' && value.trim()) return value;
  return Number.isFinite(value) ? `${formatNumber(value)} meses` : 'NO REGISTRADO';
}

function metricOrDashes(value, suffix = '') {
  return Number.isFinite(value) ? `${formatNumber(value)}${suffix}` : '----';
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDate(value) {
  if (!value) return 'NO REGISTRADO';
  const date = String(value).slice(0, 10);
  const [year, month, day] = date.split('-');
  return year && month && day ? `${day}-${month}-${year}` : date;
}

function money(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value)
    : 'NO REGISTRADO';
}

function latestGdpPair(historial = []) {
  const periods = historial.filter((row) => Number.isFinite(nullableNumber(row.ganancia_diaria_kg)));
  return {
    recent: periods[periods.length - 1] || null,
    previous: periods[periods.length - 2] || null,
  };
}

function decisionAnalysis(resumen, estado, historial, rentabilidad) {
  const { recent, previous } = latestGdpPair(historial);
  const gdpReciente = nullableNumber(recent?.ganancia_diaria_kg);
  const gdpAnterior = nullableNumber(previous?.ganancia_diaria_kg);
  const gdpExcelente = nullableNumber(resumen?.umbralesGDP?.excelente);
  const pesoActual = nullableNumber(resumen?.ultimoPeso);
  const precioKg = nullableNumber(rentabilidad?.precioKg);
  const caidaPorcentual = Number.isFinite(gdpAnterior) && gdpAnterior > 0 && Number.isFinite(gdpReciente)
    ? ((gdpAnterior - gdpReciente) / gdpAnterior) * 100
    : null;
  const pesoProyectadoActual90 = Number.isFinite(pesoActual) && Number.isFinite(gdpReciente)
    ? pesoActual + gdpReciente * 90
    : null;
  const pesoPotencial90 = Number.isFinite(pesoActual) && Number.isFinite(gdpExcelente)
    ? pesoActual + gdpExcelente * 90
    : null;
  const perdidaPotencialKg = Number.isFinite(pesoPotencial90) && Number.isFinite(pesoProyectadoActual90)
    ? Math.max(0, pesoPotencial90 - pesoProyectadoActual90)
    : null;
  const perdidaEconomica = Number.isFinite(perdidaPotencialKg) && Number.isFinite(precioKg)
    ? perdidaPotencialKg * precioKg
    : null;
  const isCritical = estado?.className === 'estado-vencida' || estado?.label === 'Crítico';
  const isExcellent = estado?.className === 'estado-vigente' || estado?.label === 'Excelente';
  const recommendation = isCritical
    ? [
        '1. Evaluar disponibilidad y calidad de forraje.',
        '2. Revisar carga animal por potrero.',
        '3. Verificar plan sanitario y control parasitario.',
        '4. Analizar suplementación estratégica.',
        '5. Programar nuevo pesaje en 30 días.',
        '6. Revisar historial sanitario y productivo del animal.',
      ]
    : isExcellent
      ? ['Mantener manejo actual y continuar seguimiento productivo.']
      : ['Realizar seguimiento y revisar oportunidades de mejora nutricional.'];

  return {
    gdpAnterior,
    gdpReciente,
    caidaPorcentual,
    pesoProyectadoActual90,
    pesoPotencial90,
    perdidaPotencialKg,
    perdidaEconomica,
    recommendation,
    isCritical,
  };
}

function statusColor(className) {
  if (className === 'estado-vigente') return [0.28, 0.62, 0];
  if (className === 'estado-proxima') return [0.9, 0.68, 0];
  if (className === 'estado-vencida') return [1, 0.23, 0.23];
  return [0.42, 0.47, 0.55];
}

function splitText(text, maxChars) {
  const words = clean(text, '--').split(/\s+/);
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
    this.y = PAGE.height - TOP_MARGIN;
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
  }

  addObject(content) {
    this.objects.push(content);
    return this.objects.length;
  }

  command(value) {
    this.current.push(value);
  }

  text(value, x, y, size = 10, font = FONT.regular, color = [0.06, 0.09, 0.12]) {
    this.command(`${color.join(' ')} rg BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfEscape(value)}) Tj ET`);
  }

  centeredText(value, centerX, y, size = 10, font = FONT.regular, color = [0.06, 0.09, 0.12]) {
    const text = sanitizePdfText(value);
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

  centeredWrapped(value, centerX, y, maxChars, size = 8.4, font = FONT.regular, color = [0.06, 0.09, 0.12], leading = 10) {
    const lines = splitText(value, maxChars);
    lines.forEach((line, index) => this.centeredText(line, centerX, y - index * leading, size, font, color));
    return lines.length * leading;
  }

  drawBulletList(items, x, y, maxChars, size = 8.4, color = [0.06, 0.09, 0.12]) {
    let cursor = y;
    items.forEach((item) => {
      const used = this.drawWrapped(item, x, cursor, maxChars, size, FONT.regular, color, 11);
      cursor -= used + 4;
    });
    return y - cursor;
  }

  legacyFooter() {
    this.line(MARGIN, 34, PAGE.width - MARGIN, 34, [0.86, 0.89, 0.93], 0.8);
    this.text('AgroGenomaX - Inteligencia que garantiza rentabilidad y sostenibilidad por metro cuadrado', MARGIN, 20, 7.8, FONT.bold, [0.06, 0.09, 0.12]);
    this.text(`Página ${this.pageNumber} de ${this.totalPages}`, PAGE.width - 96, 20, 8, FONT.regular, [0.32, 0.38, 0.45]);
  }

  legacyHeader(title, generatedAt) {
    this.pageNumber += 1;
    this.y = PAGE.height - TOP_MARGIN;
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

    if (this.qrObjectId && this.qr) {
      const qrSize = 58;
      const qrX = PAGE.width - MARGIN - qrSize;
      const qrY = this.y - qrSize + 6;
      this.rect(qrX - 10, qrY - 28, qrSize + 20, qrSize + 35, [0.0, 0.52, 0.64], [1, 1, 1], 1);
      this.command(`q ${qrSize} 0 0 ${qrSize} ${qrX} ${qrY} cm /ImQr Do Q`);
      this.text('Escanear QR para', qrX - 4, qrY - 11, 5.3, FONT.bold, [0.06, 0.09, 0.12]);
      this.text('validar autenticidad', qrX - 5, qrY - 18, 5.3, FONT.bold, [0.06, 0.09, 0.12]);
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
    this.y = PAGE.height - TOP_MARGIN;
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
    }

    this.line(MARGIN, this.y - 116, PAGE.width - MARGIN, this.y - 116, [0.6, 1, 0], 2.5);
    this.y -= 142;
  }

  ensureSpace(height, title, generatedAt) {
    if (this.y - height < FOOTER_SAFE_Y) this.newPage(title, generatedAt);
  }

  sectionTitle(value, minFollowingContent = 118) {
    this.ensureSpace(30 + minFollowingContent, 'INFORME PRODUCTIVO DE PESAJES', this.generatedAt);
    this.text(value.toUpperCase(), MARGIN, this.y, 10, FONT.bold, [0.0, 0.52, 0.64]);
    this.line(MARGIN, this.y - 5, PAGE.width - MARGIN, this.y - 5, [0.86, 0.89, 0.93], 0.7);
    this.y -= 30;
  }

  field(label, value, x, y, maxChars = 24) {
    this.text(label.toUpperCase(), x, y, 6.5, FONT.bold, [0.32, 0.38, 0.45]);
    this.drawWrapped(clean(value), x, y - 12, maxChars, 8.5, FONT.regular, [0.06, 0.09, 0.12], 10);
  }

  metricCard(label, value, x, y, width, height, className = '') {
    const color = statusColor(className);
    this.rect(x, y - height, width, height, [0.86, 0.89, 0.93], [1, 1, 1]);
    this.filledRect(x, y - height, 4, height, color);
    this.text(label.toUpperCase(), x + 10, y - 15, 6.8, FONT.bold, [0.32, 0.38, 0.45]);
    this.drawWrapped(value, x + 10, y - 34, Math.max(10, Math.floor(width / 6)), 10, FONT.bold, color, 11);
  }

  thresholdCard(label, thresholds, x, y, width, height = 58) {
    const limits = thresholds || { excelente: 0.8, aceptable: 0.5 };
    this.rect(x, y - height, width, height, [0.0, 0.52, 0.64], [0.98, 1, 1], 0.9);
    this.filledRect(x, y - height, 4, height, [0.0, 0.52, 0.64]);
    this.text(label.toUpperCase(), x + 10, y - 13, 6.8, FONT.bold, [0.32, 0.38, 0.45]);
    this.text(`Excelente >= ${formatNumber(limits.excelente)} kg/día`, x + 10, y - 28, 7.4, FONT.bold, [0.38, 0.78, 0]);
    this.text(`Aceptable ${formatNumber(limits.aceptable)} a ${formatNumber(limits.excelente - 0.01)} kg/día`, x + 10, y - 41, 7.4, FONT.bold, [0.9, 0.68, 0]);
    this.text(`Crítico < ${formatNumber(limits.aceptable)} kg/día`, x + 10, y - 54, 7.4, FONT.bold, [1, 0.23, 0.23]);
  }

  metricCardGrid(items, { columns, colStep, width, height, rowStep, title, generatedAt }) {
    for (let index = 0; index < items.length; index += columns) {
      const row = items.slice(index, index + columns);
      this.ensureSpace(height + 8, title, generatedAt);
      row.forEach((item, col) => {
        const x = MARGIN + col * colStep;
        if (item.type === 'threshold') {
          this.thresholdCard(item.label, item.thresholds, x, this.y, width, height);
        } else {
          this.metricCard(item.label, item.value, x, this.y, width, height, item.className);
        }
      });
      this.y -= rowStep;
    }
  }

  statusCard(estado, generatedAt) {
    const color = statusColor(estado.className);
    const descriptionLines = splitText(estado.description, 82);
    const height = Math.max(78, 58 + descriptionLines.length * 12);
    this.ensureSpace(height + 48, 'INFORME PRODUCTIVO DE PESAJES', generatedAt);
    this.sectionTitle('Estado productivo general');
    this.rect(MARGIN, this.y - height, PAGE.width - MARGIN * 2, height, color, [0.98, 0.99, 0.98], 1.2);
    this.filledRect(MARGIN + 17, this.y - 31, 9, 9, color);
    this.text(clean(estado.label).toUpperCase(), MARGIN + 34, this.y - 24, 15, FONT.bold, color);
    this.drawWrapped(clean(estado.description), MARGIN + 34, this.y - 46, 82, 9.2, FONT.regular, [0.06, 0.09, 0.12], 11);
    this.y -= height + 16;
  }

  timeAlertCard(alerta, generatedAt) {
    const height = 48;
    const color = statusColor(alerta?.className);
    this.ensureSpace(height + 18, 'INFORME PRODUCTIVO DE PESAJES', generatedAt);
    this.sectionTitle('Tiempo desde último pesaje');
    this.rect(MARGIN, this.y - height, PAGE.width - MARGIN * 2, height, color, [0.98, 0.99, 0.98], 1.2);
    this.filledRect(MARGIN + 17, this.y - 25, 9, 9, color);
    this.text(clean(alerta?.label).toUpperCase(), MARGIN + 34, this.y - 20, 13, FONT.bold, color);
    this.text(clean(alerta?.message), MARGIN + 34, this.y - 38, 9.2, FONT.regular, [0.06, 0.09, 0.12]);
    this.y -= height + 16;
  }

  drawHistoryCard(row, generatedAt) {
    const categoryLines = splitText(row.categoria, 22);
    const height = Math.max(112, 102 + Math.max(0, categoryLines.length - 1) * 10);
    const color = statusColor(row.estadoClass);
    this.ensureSpace(height + 10, 'INFORME PRODUCTIVO DE PESAJES', generatedAt);
    this.rect(MARGIN, this.y - height, PAGE.width - MARGIN * 2, height, [0.82, 0.87, 0.91], [1, 1, 1]);
    this.filledRect(MARGIN, this.y - height, 5, height, color);

    const x = MARGIN + 16;
    const width = PAGE.width - MARGIN * 2 - 32;
    const top = this.y - 16;
    const labelColor = [0.32, 0.38, 0.45];
    const textColor = [0.06, 0.09, 0.12];
    const row1 = [
      ['FECHA', formatDate(row.fecha), 0.24],
      ['PESO', row.peso, 0.24],
      ['PESO ANTERIOR', row.pesoAnterior, 0.26],
      ['DIFERENCIA', row.diferencia, 0.26],
    ];
    const row2 = [
      ['INTERVALO', row.intervalo, 0.18],
      ['EDAD', row.edad, 0.18],
      ['GDP', row.gdp, 0.18],
      ['ESTADO', row.estado, 0.2],
      ['ETAPA HISTÓRICA', row.categoria, 0.26],
    ];

    const drawRow = (items, y, valueY) => {
      let cursor = x;
      items.forEach(([label, value, ratio]) => {
        const colW = width * ratio;
        const center = cursor + colW / 2;
        this.centeredText(label, center, y, 6.4, FONT.bold, labelColor);
        this.centeredWrapped(value, center, valueY, Math.max(10, Math.floor(colW / 6)), 8.4, FONT.bold, label === 'ESTADO' || label === 'ETAPA HISTÓRICA' ? color : textColor, 10);
        cursor += colW;
      });
    };

    drawRow(row1, top, top - 16);
    this.line(x, top - 31, x + width, top - 31, [0.9, 0.93, 0.95], 0.6);
    drawRow(row2, top - 46, top - 62);
    this.y -= height + 10;
  }

  drawHistoryTable(rows, generatedAt) {
    const columns = [
      ['FECHA', 54],
      ['PESO', 50],
      ['ANTERIOR', 58],
      ['DIF.', 50],
      ['INTERV.', 50],
      ['EDAD', 50],
      ['GDP', 50],
      ['ESTADO', 58],
      ['ETAPA HISTÓRICA', 108],
    ];
    const x = MARGIN;
    const width = PAGE.width - MARGIN * 2;
    const headerHeight = 24;
    const labelColor = [0.32, 0.38, 0.45];
    const textColor = [0.06, 0.09, 0.12];

    const drawHeader = () => {
      this.ensureSpace(headerHeight + 34, 'INFORME PRODUCTIVO DE PESAJES', generatedAt);
      this.rect(x, this.y - headerHeight, width, headerHeight, [0.82, 0.87, 0.91], [0.96, 0.98, 0.99], 0.8);
      let cursor = x;
      columns.forEach(([label, colW]) => {
        this.centeredText(label, cursor + colW / 2, this.y - 15, 6.2, FONT.bold, labelColor);
        cursor += colW;
      });
      this.y -= headerHeight;
    };

    drawHeader();
    rows.forEach((row) => {
      const color = statusColor(row.estadoClass);
      const values = [
        formatDate(row.fecha),
        row.peso,
        row.pesoAnterior,
        row.diferencia,
        row.intervalo,
        row.edad,
        row.gdp,
        row.estado,
        row.categoria,
      ];
      const categoryLines = splitText(row.categoria, 18).length;
      const rowHeight = Math.max(34, 26 + Math.min(3, categoryLines) * 8);
      if (this.y - rowHeight < FOOTER_SAFE_Y) {
        this.newPage('INFORME PRODUCTIVO DE PESAJES', generatedAt);
        drawHeader();
      }
      this.rect(x, this.y - rowHeight, width, rowHeight, [0.86, 0.89, 0.93], [1, 1, 1], 0.7);
      this.filledRect(x, this.y - rowHeight, 4, rowHeight, color);
      let cursor = x;
      columns.forEach(([, colW], index) => {
        const center = cursor + colW / 2;
        const maxChars = index === 8 ? 18 : Math.max(6, Math.floor(colW / 5.2));
        this.centeredWrapped(values[index], center, this.y - 16, maxChars, index >= 7 ? 6.7 : 7.1, FONT.bold, index === 7 || index === 8 ? color : textColor, 8.5);
        cursor += colW;
      });
      this.y -= rowHeight + 5;
    });
  }

  decisionBox(title, lines, className, generatedAt) {
    const color = statusColor(className);
    const maxChars = 86;
    const fontSize = 8.3;
    const leading = 11;
    const itemGap = 4;
    const topPadding = 34;
    const bottomPadding = 18;
    const renderedLines = lines.map((line) => splitText(line, maxChars).length);
    const textHeight = renderedLines.reduce((sum, count) => sum + count * leading, 0);
    const gapsHeight = Math.max(0, lines.length - 1) * itemGap;
    const height = Math.max(78, topPadding + textHeight + gapsHeight + bottomPadding);
    this.ensureSpace(height + 18, 'INFORME PRODUCTIVO DE PESAJES', generatedAt);
    this.rect(MARGIN, this.y - height, PAGE.width - MARGIN * 2, height, color, [0.99, 1, 0.99], 1);
    this.filledRect(MARGIN, this.y - height, 5, height, color);
    this.text(title.toUpperCase(), MARGIN + 14, this.y - 16, 8.6, FONT.bold, color);
    this.drawBulletList(lines, MARGIN + 14, this.y - topPadding, maxChars, fontSize, [0.06, 0.09, 0.12]);
    this.y -= height + 14;
  }

  drawWeightChart(historial, generatedAt) {
    const points = historial
      .map((row) => ({ fecha: row.fecha_pesaje, peso: nullableNumber(row.peso_kg), className: row.estado_productivo_class }))
      .filter((row) => row.fecha && Number.isFinite(row.peso));
    if (points.length < 2) return;

    const height = 132;
    this.ensureSpace(height + 22, 'INFORME PRODUCTIVO DE PESAJES', generatedAt);
    this.sectionTitle('Gráfica de evolución de peso');
    const x = MARGIN;
    const yTop = this.y;
    const width = PAGE.width - MARGIN * 2;
    const chartHeight = 96;
    const yBottom = yTop - chartHeight;
    const weights = points.map((point) => point.peso);
    const min = Math.min(...weights);
    const max = Math.max(...weights);
    const range = max - min || 1;

    this.rect(x, yTop - chartHeight - 14, width, chartHeight + 14, [0.86, 0.89, 0.93], [1, 1, 1]);
    this.line(x + 34, yBottom + 20, x + width - 18, yBottom + 20, [0.7, 0.75, 0.8], 0.8);
    this.line(x + 34, yBottom + 20, x + 34, yTop - 14, [0.7, 0.75, 0.8], 0.8);
    this.text(`${formatNumber(max)} kg`, x + 8, yTop - 18, 6.5, FONT.bold, [0.32, 0.38, 0.45]);
    this.text(`${formatNumber(min)} kg`, x + 8, yBottom + 18, 6.5, FONT.bold, [0.32, 0.38, 0.45]);

    const plotW = width - 58;
    const plotH = chartHeight - 36;
    const mapped = points.map((point, index) => ({
      x: x + 34 + (points.length === 1 ? 0 : (index / (points.length - 1)) * plotW),
      y: yBottom + 20 + ((point.peso - min) / range) * plotH,
      ...point,
    }));

    mapped.forEach((point, index) => {
      if (index > 0) {
        const previous = mapped[index - 1];
        this.line(previous.x, previous.y, point.x, point.y, statusColor(point.className), 1.8);
      }
      this.filledRect(point.x - 2.4, point.y - 2.4, 4.8, 4.8, statusColor(point.className));
    });

    const first = mapped[0];
    const last = mapped[mapped.length - 1];
    this.text(formatDate(first.fecha), first.x - 18, yBottom + 7, 6.5, FONT.bold, [0.32, 0.38, 0.45]);
    this.text(formatDate(last.fecha), Math.min(last.x - 24, PAGE.width - MARGIN - 58), yBottom + 7, 6.5, FONT.bold, [0.32, 0.38, 0.45]);
    this.y -= height + 10;
  }

  drawGdpChart(historial, generatedAt) {
    const points = historial
      .map((row) => ({
        fecha: row.fecha_pesaje,
        gdp: nullableNumber(row.ganancia_diaria_kg),
        className: row.estado_productivo_class,
      }))
      .filter((row) => row.fecha && Number.isFinite(row.gdp));
    if (points.length < 1) return;

    const height = 132;
    this.ensureSpace(height + 22, 'INFORME PRODUCTIVO DE PESAJES', generatedAt);
    this.sectionTitle('Gráfica de ganancia diaria de peso');
    const x = MARGIN;
    const yTop = this.y;
    const width = PAGE.width - MARGIN * 2;
    const chartHeight = 96;
    const yBottom = yTop - chartHeight;
    const values = points.map((point) => point.gdp);
    const min = Math.min(0, ...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    this.rect(x, yTop - chartHeight - 14, width, chartHeight + 14, [0.86, 0.89, 0.93], [1, 1, 1]);
    this.line(x + 34, yBottom + 20, x + width - 18, yBottom + 20, [0.7, 0.75, 0.8], 0.8);
    this.line(x + 34, yBottom + 20, x + 34, yTop - 14, [0.7, 0.75, 0.8], 0.8);
    this.text(`${formatNumber(max)} kg/día`, x + 8, yTop - 18, 6.2, FONT.bold, [0.32, 0.38, 0.45]);
    this.text(`${formatNumber(min)} kg/día`, x + 8, yBottom + 18, 6.2, FONT.bold, [0.32, 0.38, 0.45]);

    const plotW = width - 58;
    const plotH = chartHeight - 36;
    const mapped = points.map((point, index) => ({
      x: x + 34 + (points.length === 1 ? plotW / 2 : (index / (points.length - 1)) * plotW),
      y: yBottom + 20 + ((point.gdp - min) / range) * plotH,
      ...point,
    }));

    mapped.forEach((point, index) => {
      if (index > 0) {
        const previous = mapped[index - 1];
        this.line(previous.x, previous.y, point.x, point.y, statusColor(point.className), 1.8);
      }
      this.filledRect(point.x - 2.4, point.y - 2.4, 4.8, 4.8, statusColor(point.className));
    });

    const first = mapped[0];
    const last = mapped[mapped.length - 1];
    this.text(formatDate(first.fecha), first.x - 18, yBottom + 7, 6.5, FONT.bold, [0.32, 0.38, 0.45]);
    this.text(formatDate(last.fecha), Math.min(last.x - 24, PAGE.width - MARGIN - 58), yBottom + 7, 6.5, FONT.bold, [0.32, 0.38, 0.45]);
    this.y -= height + 10;
  }

  async build(report) {
    const { animal, resumen, estado, historial, proyecciones, rentabilidad, meta, desempeno, generatedAt } = report;
    this.generatedAt = generatedAt;
    const codigoInforme = reportCode(generatedAt, animal.qr);
    const diagnostico = decisionAnalysis(resumen, estado, historial, rentabilidad);
    const authUrl = `https://agrogenomax.pages.dev/qr/${encodeURIComponent(animal.qr || '')}`;
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

    this.header('INFORME PRODUCTIVO DE PESAJES', generatedAt);
    this.sectionTitle('Información del animal');
    [
      ['Nombre', animal.nombre],
      ['QR', animal.qr],
      ['Raza', animal.raza],
      ['Sexo', animal.sexo],
      ['Edad', animal.edad],
      ['Categoría actual', resumen.categoriaProductiva],
    ].forEach(([label, value], index) => this.metricCard(label, value, MARGIN + (index % 3) * 176, this.y - Math.floor(index / 3) * 58, 166, 50));
    this.y -= 122;

    this.sectionTitle('Resumen productivo');
    [
      ['Peso inicial', metric(resumen.primerPeso, ' kg'), 'estado-sin-programacion'],
      ['Peso actual', metric(resumen.ultimoPeso, ' kg'), estado.className],
      ['Ganancia acumulada', metric(resumen.diferencia, ' kg'), resumen.diferencia < 0 ? 'estado-vencida' : 'estado-vigente'],
      ['GDP reciente', metric(resumen.gdpReciente, ' kg/día'), estado.className],
      ['GDP histórico', metric(resumen.gdpHistorico, ' kg/día'), 'estado-sin-programacion'],
      ['Ganancia mensual', metric(resumen.gananciaMensual, ' kg/mes'), estado.className],
      ['Total pesajes', String(resumen.total), 'estado-sin-programacion'],
    ].forEach(([label, value, className], index) => {
      const cardIndex = index >= 5 ? index + 1 : index;
      this.metricCard(label, value, MARGIN + (cardIndex % 3) * 176, this.y - Math.floor(cardIndex / 3) * 66, 166, 56, className);
    });
    this.thresholdCard('Umbral aplicado', resumen.umbralesGDP, MARGIN + 2 * 176, this.y - 66, 166, 56);
    this.y -= 206;
    this.statusCard(estado, generatedAt);
    this.timeAlertCard(resumen.timeAlert, generatedAt);

    this.ensureSpace(96, 'INFORME PRODUCTIVO DE PESAJES', generatedAt);
    this.sectionTitle('Historial de pesajes');
    if (historial.length) {
      const tableRows = historial.map((row) => ({
        fecha: row.fecha_pesaje,
        peso: metric(nullableNumber(row.peso_kg), ' kg'),
        pesoAnterior: metricOrDashes(nullableNumber(row.peso_anterior), ' kg'),
        diferencia: metricOrDashes(nullableNumber(row.diferencia_kg), ' kg'),
        intervalo: intervalFromDays(nullableNumber(row.dias_entre_pesajes)),
        edad: ageMonths(row.edad_texto_en_pesaje || nullableNumber(row.edad_meses_en_pesaje)),
        gdp: metricOrDashes(nullableNumber(row.ganancia_diaria_kg), ' kg/día'),
        estado: row.estado_productivo || 'NO REGISTRADO',
        categoria: row.categoria_evaluada || resumen.categoriaProductiva,
        estadoClass: row.estado_productivo_class || (row.estado_productivo === 'Excelente' ? 'estado-vigente' : row.estado_productivo === 'Aceptable' ? 'estado-proxima' : row.estado_productivo === 'Inicial' ? 'estado-sin-programacion' : 'estado-vencida'),
      }));
      this.drawHistoryTable(tableRows, generatedAt);
      this.ensureSpace(24, 'INFORME PRODUCTIVO DE PESAJES', generatedAt);
      this.text('Nota: las categorías históricas se estiman según la edad del animal en la fecha de cada pesaje.', MARGIN, this.y, 8.5, FONT.bold, [0.32, 0.38, 0.45]);
      this.y -= 20;
    } else {
      this.text('No existen pesajes registrados para este animal.', MARGIN, this.y, 10, FONT.bold, [0.32, 0.38, 0.45]);
      this.y -= 24;
    }
    this.drawWeightChart(historial, generatedAt);
    this.drawGdpChart(historial, generatedAt);

    this.ensureSpace(104, 'INFORME PRODUCTIVO DE PESAJES', generatedAt);
    this.sectionTitle('Análisis productivo');
    this.metricCardGrid([
      { label: 'GDP reciente', value: metric(resumen.gdpReciente, ' kg/día'), className: estado.className },
      { label: 'GDP histórico', value: metric(resumen.gdpHistorico, ' kg/día'), className: resumen.historicalStatusInfo?.className || 'estado-sin-programacion' },
      { type: 'threshold', label: 'Umbral aplicado', thresholds: resumen.umbralesGDP },
      { label: 'Estado actual', value: estado.label, className: estado.className },
      { label: 'Estado histórico', value: resumen.historicalStatusInfo?.label || 'NO REGISTRADO', className: resumen.historicalStatusInfo?.className || 'estado-sin-programacion' },
      { label: 'Tendencia actual', value: desempeno?.tendencia || 'NO REGISTRADO', className: estado.className },
      { label: 'Mejor periodo', value: desempeno?.best ? metric(desempeno.best.ganancia_diaria_kg, ' kg/día') : 'NO REGISTRADO', className: 'estado-vigente' },
      { label: 'Peor periodo', value: desempeno?.worst ? metric(desempeno.worst.ganancia_diaria_kg, ' kg/día') : 'NO REGISTRADO', className: 'estado-vencida' },
      { label: 'Ganancia acumulada', value: metric(resumen.diferencia, ' kg'), className: resumen.diferencia < 0 ? 'estado-vencida' : 'estado-vigente' },
      { label: 'Diferencia último pesaje', value: metric(resumen.lastDifference, ' kg'), className: resumen.lastDifference < 0 ? 'estado-vencida' : estado.className },
      { label: 'Ganancia mensual estimada', value: metric(resumen.gananciaMensual, ' kg/mes'), className: estado.className },
      { label: 'Proyección orientativa 30 días', value: metric(proyecciones.d30, ' kg'), className: estado.className },
      { label: 'Proyección orientativa 60 días', value: metric(proyecciones.d60, ' kg'), className: estado.className },
      { label: 'Proyección orientativa 90 días', value: metric(proyecciones.d90, ' kg'), className: estado.className },
      { label: 'Escenario histórico estimado 90 días', value: metric(proyecciones.escenarios?.[1]?.d90, ' kg'), className: resumen.historicalStatusInfo?.className || 'estado-sin-programacion' },
      { label: 'Escenario óptimo estimado 90 días', value: metric(proyecciones.escenarios?.[2]?.d90, ' kg'), className: 'estado-vigente' },
      { label: 'Fecha estimada 550 kg', value: proyecciones.venta550?.date ? `${formatDate(proyecciones.venta550.date)} (${intervalFromDays(proyecciones.venta550.days)})` : 'NO REGISTRADO', className: proyecciones.venta550 ? estado.className : 'estado-sin-programacion' },
    ], { columns: 3, colStep: 176, width: 166, height: 58, rowStep: 68, title: 'INFORME PRODUCTIVO DE PESAJES', generatedAt });
    this.ensureSpace(24, 'INFORME PRODUCTIVO DE PESAJES', generatedAt);
    this.text('Indicadores calculados con base en los pesajes registrados; las proyecciones son orientativas y no certificadas.', MARGIN, this.y, 8.5, FONT.bold, [0.32, 0.38, 0.45]);
    this.y -= 20;

    this.sectionTitle('Diagnóstico inteligente AgroGenomaX');
    this.decisionBox('Diagnóstico productivo', [
      Number.isFinite(diagnostico.caidaPorcentual)
        ? `El GDP reciente presenta una caída del ${formatNumber(diagnostico.caidaPorcentual)}% frente al periodo anterior.`
        : 'No existe GDP anterior suficiente para calcular caída de eficiencia.',
      diagnostico.isCritical
        ? 'Se identifica pérdida de eficiencia productiva frente al estándar esperado para la categoría actual.'
        : 'El desempeño actual se mantiene dentro del rango técnico evaluado para su categoría.',
    ], estado.className, generatedAt);
    this.decisionBox('Pérdida potencial estimada', [
      `Peso proyectado orientativo 90 días: ${metric(diagnostico.pesoProyectadoActual90, ' kg')}.`,
      `Peso potencial óptimo estimado 90 días: ${metric(diagnostico.pesoPotencial90, ' kg')}.`,
      `Diferencia productiva estimada: ${metric(diagnostico.perdidaPotencialKg, ' kg')}.`,
    ], diagnostico.perdidaPotencialKg > 0 ? 'estado-vencida' : 'estado-vigente', generatedAt);
    this.decisionBox('Pérdida económica potencial', [
      Number.isFinite(diagnostico.perdidaEconomica)
        ? `Con el precio registrado por kg, la pérdida potencial estimada es de ${money(diagnostico.perdidaEconomica)}.`
        : 'Ingrese precio por kg para estimar pérdida económica potencial.',
    ], Number.isFinite(diagnostico.perdidaEconomica) && diagnostico.perdidaEconomica > 0 ? 'estado-vencida' : 'estado-sin-programacion', generatedAt);
    this.decisionBox('Recomendación orientativa AgroGenomaX', diagnostico.recommendation, estado.className, generatedAt);

    this.ensureSpace(150, 'INFORME PRODUCTIVO DE PESAJES', generatedAt);
    this.sectionTitle('Meta productiva estimada');
    if (meta) {
      [
        ['Peso objetivo', metric(meta.pesoObjetivo, ' kg'), meta.achieved ? 'estado-vigente' : 'estado-proxima'],
        ['Kg faltantes', meta.achieved ? 'Meta alcanzada' : metric(meta.kgFaltantes, ' kg'), meta.achieved ? 'estado-vigente' : 'estado-proxima'],
        ['Días estimados orientativos', Number.isFinite(meta.diasEstimados) ? `${Math.ceil(meta.diasEstimados)} días` : 'NO REGISTRADO', 'estado-proxima'],
        ['Fecha estimada orientativa', meta.fechaEstimada || 'NO REGISTRADO', 'estado-proxima'],
      ].forEach(([label, value, className], index) => this.metricCard(label, value, MARGIN + (index % 2) * 264, this.y - Math.floor(index / 2) * 58, 250, 50, className));
      this.y -= 122;
    } else {
      this.text('No se configuró meta productiva.', MARGIN, this.y, 10, FONT.bold, [0.32, 0.38, 0.45]);
      this.y -= 28;
    }

    this.ensureSpace(104, 'INFORME PRODUCTIVO DE PESAJES', generatedAt);
    this.sectionTitle('Indicadores económicos estimados');
    if (rentabilidad) {
      this.metricCardGrid([
        { label: 'Precio por kg registrado para cálculo', value: money(rentabilidad.precioKg), className: 'estado-sin-programacion' },
        { label: 'Valor bruto estimado por ganancia acumulada', value: money(rentabilidad.valorGanancia), className: 'estado-vigente' },
        { label: 'Valor bruto proyectado a 30 días', value: money(rentabilidad.valor30), className: 'estado-proxima' },
        { label: 'Costo diario total', value: money(rentabilidad.totalCostoDiario), className: 'estado-sin-programacion' },
        { label: 'Valor bruto estimado periodo reciente', value: money(rentabilidad.valorBrutoPeriodo), className: 'estado-proxima' },
        { label: 'Margen estimado periodo reciente', value: money(rentabilidad.margenPeriodo), className: rentabilidad.margenPeriodo < 0 ? 'estado-vencida' : 'estado-vigente' },
        { label: 'Costo estimado por kg ganado', value: money(rentabilidad.costoPorKgGanado), className: 'estado-sin-programacion' },
        { label: 'Retorno estimado', value: Number.isFinite(rentabilidad.retornoEstimado) ? `${formatNumber(rentabilidad.retornoEstimado)}x` : 'NO REGISTRADO', className: 'estado-vigente' },
        ...(Number.isFinite(rentabilidad.margen30) ? [{ label: 'Margen estimado 30 días', value: money(rentabilidad.margen30), className: rentabilidad.margen30 < 0 ? 'estado-vencida' : 'estado-vigente' }] : []),
      ], { columns: 2, colStep: 264, width: 250, height: 54, rowStep: 64, title: 'INFORME PRODUCTIVO DE PESAJES', generatedAt });
      this.ensureSpace(24, 'INFORME PRODUCTIVO DE PESAJES', generatedAt);
      this.text('Estimaciones orientativas con base en pesajes registrados; no constituyen valoración comercial certificada ni utilidad neta final.', MARGIN, this.y, 8.5, FONT.bold, [0.32, 0.38, 0.45]);
      this.y -= 20;
    } else {
      this.text('Ingrese precio por kg para estimar rentabilidad.', MARGIN, this.y, 10, FONT.bold, [0.32, 0.38, 0.45]);
      this.y -= 28;
    }

    this.ensureSpace(144, 'INFORME PRODUCTIVO DE PESAJES', generatedAt);
    this.sectionTitle('Trazabilidad del documento');
    this.rect(MARGIN, this.y - 118, PAGE.width - MARGIN * 2, 118, [0.82, 0.87, 0.91], [1, 1, 1]);
    this.field('Código único', codigoInforme, MARGIN + 14, this.y - 20, 28);
    this.field('Documento generado por', 'AgroGenomaX', MARGIN + 198, this.y - 20, 28);
    this.field('Fecha generación', generatedAt, MARGIN + 382, this.y - 20, 30);
    this.field('Animal', animal.nombre, MARGIN + 14, this.y - 56, 28);
    this.field('QR animal', animal.qr, MARGIN + 198, this.y - 56, 26);
    this.field('Responsable técnico', 'NO REGISTRADO', MARGIN + 382, this.y - 56, 26);
    this.field('Estado productivo general', estado.label, MARGIN + 14, this.y - 92, 28);
    this.field('Validación de autenticidad', 'Documento verificable mediante QR.', MARGIN + 198, this.y - 92, 42);
    this.y -= 134;

    this.ensureSpace(210, 'INFORME PRODUCTIVO DE PESAJES', generatedAt);
    this.sectionTitle('Certificación técnica');
    this.rect(MARGIN, this.y - 166, PAGE.width - MARGIN * 2, 166, [0.82, 0.87, 0.91], [1, 1, 1]);
    const labelX = MARGIN + 18;
    const lineX = MARGIN + 190;
    const lineW = PAGE.width - MARGIN - lineX - 18;
    [
      ['Responsable técnico:', this.y - 25],
      ['Profesión:', this.y - 50],
      ['Matrícula o registro profesional:', this.y - 75],
      ['Entidad:', this.y - 100],
      ['Firma:', this.y - 125],
    ].forEach(([label, y]) => {
      this.text(label, labelX, y, 8.6, FONT.bold, [0.32, 0.38, 0.45]);
      this.line(lineX, y - 1, lineX + lineW, y - 1, [0.06, 0.09, 0.12], 1);
    });
    this.drawWrapped('Certifico que la información productiva registrada en este documento corresponde a los registros almacenados en la plataforma AgroGenomaX.', MARGIN + 18, this.y - 148, 92, 8.2, FONT.bold, [0.06, 0.09, 0.12], 10);

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

export async function createProductiveReportPdfBlob(report) {
  const builder = new PdfBuilder();
  return builder.build(report);
}

export function productiveReportFileName(nombreAnimal, codigoQr) {
  return `Informe_Productivo_${safeFilePart(nombreAnimal)}_${safeFilePart(codigoQr)}.pdf`;
}

