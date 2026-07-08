import { formatDateTimeDisplay } from '../utils/dateFormat.js';

const PAGE = { width: 612, height: 792 };
const MARGIN = 42;
const FONT = { regular: 'F1', bold: 'F2' };

function clean(value, fallback = '--') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function safeFilePart(value) {
  return clean(value, 'Animal')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'Animal';
}

function pdfEscape(value) {
  return clean(value, '')
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function splitText(value, maxChars = 72) {
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
  return lines.length ? lines : ['--'];
}

function binaryFromBytes(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.slice(index, index + 8192));
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
    return { bytes: new Uint8Array(await response.arrayBuffer()), ...size };
  } catch {
    return null;
  }
}

class GeneticPdf {
  constructor() {
    this.objects = [];
    this.pages = [];
    this.current = [];
    this.y = PAGE.height - 58;
    this.pageNumber = 0;
  }

  addObject(content) {
    this.objects.push(content);
    return this.objects.length;
  }

  cmd(command) {
    this.current.push(command);
  }

  text(value, x, y, size = 9, font = FONT.regular, color = [0.05, 0.08, 0.12]) {
    this.cmd(`BT /${font} ${size} Tf ${color.join(' ')} rg ${x} ${y} Td (${pdfEscape(value)}) Tj ET`);
  }

  rect(x, y, width, height, stroke = [0.82, 0.87, 0.91], fill = [1, 1, 1]) {
    this.cmd(`q ${fill.join(' ')} rg ${stroke.join(' ')} RG 1 w ${x} ${y} ${width} ${height} re B Q`);
  }

  line(x1, y1, x2, y2, color = [0.55, 1, 0], width = 2) {
    this.cmd(`q ${color.join(' ')} RG ${width} w ${x1} ${y1} m ${x2} ${y2} l S Q`);
  }

  image(objectId, x, y, width, height) {
    if (!objectId) return;
    this.cmd(`q ${width} 0 0 ${height} ${x} ${y} cm /Im${objectId} Do Q`);
  }

  ensureSpace(height) {
    if (this.y - height < 108) this.addPage();
  }

  addPage() {
    this.footer();
    this.pages.push(this.current.join('\n'));
    this.current = [];
    this.y = PAGE.height - 58;
    this.header();
  }

  header() {
    this.pageNumber += 1;
    this.image(this.symbolObjectId, MARGIN, PAGE.height - 150, 82, 82);
    this.image(this.brandObjectId, 214, PAGE.height - 108, 185, 72);
    this.text('REPORTE GENÉTICO AGROGENOMAX', 148, PAGE.height - 142, 15, FONT.bold, [0, 0.52, 0.64]);
    this.text(`Generado: ${this.generatedAt}`, 148, PAGE.height - 160, 8.5, FONT.regular, [0.42, 0.49, 0.57]);
    this.text('Sistema Inteligente de Gestión Ganadera, Trazabilidad, Cumplimiento Sanitario y Ambiental', 148, PAGE.height - 178, 8.5, FONT.bold);
    this.line(MARGIN, PAGE.height - 202, PAGE.width - MARGIN, PAGE.height - 202, [0.55, 1, 0], 2.8);
    this.y = PAGE.height - 230;
  }

  footer() {
    this.line(MARGIN, 82, PAGE.width - MARGIN, 82, [0.86, 0.89, 0.93], 1);
    this.image(this.footerObjectId, MARGIN, 25, 98, 52);
    this.text('Inteligencia que garantiza rentabilidad y sostenibilidad por metro cuadrado', 178, 54, 8.2, FONT.bold);
    this.text('www.agrogenomax.com', 252, 39, 8.2, FONT.bold);
    this.text(`Página ${this.pageNumber} de __TOTAL_PAGES__`, PAGE.width - 132, 48, 9, FONT.regular, [0.42, 0.49, 0.57]);
  }

  sectionTitle(title) {
    this.ensureSpace(42);
    this.text(title, MARGIN, this.y, 12, FONT.bold, [0, 0.52, 0.64]);
    this.line(MARGIN, this.y - 8, PAGE.width - MARGIN, this.y - 8, [0.86, 0.89, 0.93], 1);
    this.y -= 28;
  }

  cards(items, columns = 3) {
    const gap = 10;
    const width = (PAGE.width - MARGIN * 2 - gap * (columns - 1)) / columns;
    const height = 62;
    items.forEach((item, index) => {
      if (index % columns === 0) this.ensureSpace(height + 12);
      const col = index % columns;
      const x = MARGIN + col * (width + gap);
      const y = this.y - height;
      this.rect(x, y, width, height);
      this.text(item.label.toUpperCase(), x + 10, y + height - 18, 6.8, FONT.bold, [0.32, 0.38, 0.45]);
      splitText(item.value, columns === 2 ? 44 : 26).slice(0, 3).forEach((line, lineIndex) => {
        this.text(line, x + 10, y + height - 34 - lineIndex * 10, 9, FONT.bold, item.color || [0.05, 0.08, 0.12]);
      });
      if (col === columns - 1 || index === items.length - 1) this.y -= height + 12;
    });
  }

  panel(title, lines) {
    const body = lines.flatMap((line) => splitText(line, 96));
    const height = Math.max(70, 32 + body.length * 11);
    this.ensureSpace(height + 12);
    this.rect(MARGIN, this.y - height, PAGE.width - MARGIN * 2, height, [0.0, 0.52, 0.64]);
    this.text(title.toUpperCase(), MARGIN + 12, this.y - 18, 9.5, FONT.bold, [0, 0.52, 0.64]);
    body.forEach((line, index) => this.text(line, MARGIN + 12, this.y - 36 - index * 11, 8.6));
    this.y -= height + 12;
  }

  async build(report) {
    this.generatedAt = formatDateTimeDisplay(report.generatedAt || new Date());
    const [symbol, brand, footer] = await Promise.all([
      loadImage('/agx-report-logo-white.jpeg'),
      loadImage('/agx-pdf-wordmark-color-vivid.jpeg'),
      loadImage('/agx-pdf-footer-logo.jpeg'),
    ]);
    if (symbol) this.symbolObjectId = this.addImage(symbol);
    if (brand) this.brandObjectId = this.addImage(brand);
    if (footer) this.footerObjectId = this.addImage(footer);

    this.header();
    this.sectionTitle('Información del animal');
    this.cards(report.animal, 3);
    this.sectionTitle('Composición racial');
    this.cards(report.razas, 3);
    if (report.advancedNotice) {
      this.sectionTitle('Información genética avanzada');
      this.panel('Estado del registro', [report.advancedNotice]);
    }
    if (report.genealogia?.length) {
      this.sectionTitle('Genealogía');
      this.cards(report.genealogia, 2);
    }
    if (report.merito?.length) {
      this.sectionTitle('Evaluación genética registrada');
      this.cards(report.merito, 3);
    }
    if (report.inventario?.length) {
      this.sectionTitle('Inventario reproductivo registrado');
      this.cards(report.inventario, 3);
    }
    if (report.arbol?.length) {
      this.sectionTitle('Árbol genealógico');
      this.panel('Línea genética visual', report.arbol);
    }
    if (report.descendencia?.length) {
      this.sectionTitle('Descendencia registrada');
      this.cards(report.descendencia, 2);
    }
    if (report.decision?.length) this.panel('Decisión registrada', report.decision);

    this.footer();
    this.pages.push(this.current.join('\n'));
    const totalPages = String(this.pages.length);
    this.pages = this.pages.map((page) => page.replace(/__TOTAL_PAGES__/g, totalPages));

    const fontRegular = this.addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontBold = this.addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pageObjects = this.pages.map((content) => {
      const contentId = this.addObject(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      return this.addObject(`<< /Type /Page /Parent __PAGES__ /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> /XObject << ${this.imageResourceNames()} >> >> /Contents ${contentId} 0 R >>`);
    });
    const pagesId = this.addObject(`<< /Type /Pages /Kids [${pageObjects.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjects.length} >>`);
    this.objects = this.objects.map((object) => object.replace(/__PAGES__/g, `${pagesId} 0 R`));
    const catalogId = this.addObject(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    return this.serialize(catalogId);
  }

  addImage(image) {
    return this.addObject(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n${binaryFromBytes(image.bytes)}\nendstream`);
  }

  imageResourceNames() {
    return [this.symbolObjectId, this.brandObjectId, this.footerObjectId].filter(Boolean).map((id) => `/Im${id} ${id} 0 R`).join(' ');
  }

  serialize(catalogId) {
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    this.objects.forEach((object, index) => {
      offsets.push(pdf.length);
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`;
    offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
    pdf += `trailer\n<< /Size ${this.objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const bytes = new Uint8Array(pdf.length);
    for (let index = 0; index < pdf.length; index += 1) bytes[index] = pdf.charCodeAt(index) & 0xff;
    return new Blob([bytes], { type: 'application/pdf' });
  }
}

export async function createGeneticReportPdfBlob(report) {
  return new GeneticPdf().build(report);
}

export function geneticReportFileName(animalName, qrCode) {
  return `Reporte_Genetico_${safeFilePart(animalName)}_${safeFilePart(qrCode)}.pdf`;
}
