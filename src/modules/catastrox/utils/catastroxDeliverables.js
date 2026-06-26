const textEncoder = new TextEncoder();

import { buildDisplayRingFromOriginalRing } from './CartographicPresentationEngine.js';
import { buildReferenceRows, buildReferenceSegments } from './DistanceEngine.js';
import { buildDistanceLabelPlacements } from './LabelPlacementEngine.js';
import {
  applyFitTransform,
  buildVisiblePointProjection,
  computeMapState,
  createFitTransform,
  projectPointToViewport,
  projectRingToViewport,
} from './ProjectionEngine.js';
import { reducePointsForVisualClarity, selectVisibleReferencePoints } from './VisibleReferencePointEngine.js';
import {
  cumulativeDistances,
  getPointBounds,
  getRingBounds,
  haversineMeters,
  normalizeRing,
  perpendicularDistanceMeters,
  projectRingToLocalMeters,
  ringCentroid,
  ringDistanceForward,
  simplifyRingIndices,
  turnDegrees,
} from './GeometryCore.js';

const TILE_SIZE = 256;
const IMAGERY_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const LABELS_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

const PAGE = { width: 792, height: 612, scale: 2 };

const SATELLITE_LAYOUT = {
  page: { x: 0, y: 0, width: PAGE.width, height: PAGE.height },
  header: { x: 22, y: 20, width: 748, height: 84 },
  mapArea: { x: 24, y: 112, width: 446, height: 394 },
  rightPanel: { x: 484, y: 112, width: 284, height: 394 },
  bottomPanel: { x: 24, y: 516, width: 744, height: 52 },
  footer: { x: 24, y: 580, width: 744, height: 16 },
};

const TECHNICAL_LAYOUT = {
  page: { x: 0, y: 0, width: PAGE.width, height: PAGE.height },
  header: { x: 22, y: 20, width: 748, height: 84 },
  mapArea: { x: 24, y: 108, width: 546, height: 450 },
  rightPanel: { x: 584, y: 108, width: 184, height: 450 },
  bottomPanel: { x: 24, y: 566, width: 744, height: 24 },
  footer: { x: 24, y: 592, width: 744, height: 10 },
};

const TABLE_LAYOUT = {
  page: { x: 0, y: 0, width: PAGE.width, height: PAGE.height },
  header: { x: 22, y: 20, width: 748, height: 84 },
  mapArea: { x: 24, y: 116, width: 744, height: 420 },
  bottomPanel: { x: 24, y: 548, width: 744, height: 30 },
  footer: { x: 24, y: 582, width: 744, height: 14 },
};

const CUSTOM_PDF_FONT_FAMILY = 'CatastroXArial';
const PDF_FONT_FALLBACK_STACK = 'Arial, sans-serif';
const PDF_FONT_DEFINITIONS = [
  { family: CUSTOM_PDF_FONT_FAMILY, url: '/fonts/catastrox/arial.ttf', weight: '400' },
  { family: CUSTOM_PDF_FONT_FAMILY, url: '/fonts/catastrox/arialbd.ttf', weight: '700' },
];

let fontLoadPromise = null;
let activePdfFontStack = `"${CUSTOM_PDF_FONT_FAMILY}", ${PDF_FONT_FALLBACK_STACK}`;
let pdfFontFallbackWarningIssued = false;

function cleanText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const next = String(value).trim();
  return next || fallback;
}

function formatNumber(value, decimals = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 'Sin dato';
  return parsed.toLocaleString('es-CO', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fileSafeCode(predio) {
  return cleanText(predio.codigoPredial || predio.codigo || predio.id || 'predio').replace(/[^\w.-]+/g, '_');
}

function predioName(predio) {
  return cleanText(predio.nombrePredio) || `Predio ${fileSafeCode(predio)}`;
}

function geometryToGeoJson(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Feature') return geometry.geometry;
  return geometry;
}

function firstRing(geometry) {
  const geo = geometryToGeoJson(geometry);
  if (!geo) return [];
  if (geo.type === 'Polygon') return geo.coordinates?.[0] || [];
  if (geo.type === 'MultiPolygon') return geo.coordinates?.[0]?.[0] || [];
  return [];
}

function normalizePredioForDeliverables(source) {
  const predio = source?.predio || source || {};
  const geometry = predio.geometry || predio.polygonGeoJson?.geometry || predio.polygonGeoJson || null;
  const ring = normalizeRing(firstRing(geometry));
  const displayGeometry = buildDisplayRingFromOriginalRing(ring);

  return {
    id: predio.id,
    codigoPredial: cleanText(predio.codigoPredial || predio.codigo || predio.codigo_catastral || predio.id, 'predio'),
    codigoAnterior: cleanText(predio.codigoAnterior || predio.codigo_anterior || 'No disponible'),
    municipio: cleanText(predio.municipio || source?.municipio, 'Sin dato'),
    departamento: cleanText(predio.departamento || source?.departamento, 'Sin dato'),
    areaHa: Number(predio.areaHa || 0),
    areaM2: Number(predio.areaM2 || 0),
    perimetroM: Number(predio.perimetroM || 0),
    estadoPredial: cleanText(predio.estadoPredial, 'Predio identificado en la base catastral consultada.'),
    tipoZona: cleanText(predio.tipoZona, 'Rural'),
    nombrePredio: predioName(predio),
    queryPoint: predio.queryPoint || source?.queryPoint || null,
    geometry,
    ring,
    displayRing: displayGeometry.displayRing,
    displayVertices: displayGeometry.displayVertices,
    displayRingReport: displayGeometry.report,
  };
}

function wrapText(text, maxChars) {
  const words = cleanText(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function latin1BytesFromString(value) {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    bytes[index] = code <= 255 ? code : 63;
  }
  return bytes;
}

function concatUint8Arrays(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function uint16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function uint32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function buildImageOnlyPdf(pageImages) {
  const objects = [];
  const addObject = (bytes) => {
    objects.push(bytes);
    return objects.length;
  };

  const pageEntries = pageImages.map((pageImage, pageIndex) => {
    const imageObjectId = addObject(
      concatUint8Arrays([
        latin1BytesFromString(
          `<< /Type /XObject /Subtype /Image /Width ${pageImage.width} /Height ${pageImage.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pageImage.bytes.length} >>\nstream\n`,
        ),
        pageImage.bytes,
        latin1BytesFromString('\nendstream'),
      ]),
    );

    const content = latin1BytesFromString(
      `q ${PAGE.width} 0 0 ${PAGE.height} 0 0 cm /Im${pageIndex + 1} Do Q`,
    );
    const contentObjectId = addObject(
      concatUint8Arrays([
        latin1BytesFromString(`<< /Length ${content.length} >>\nstream\n`),
        content,
        latin1BytesFromString('\nendstream'),
      ]),
    );

    return {
      imageObjectId,
      contentObjectId,
      name: `Im${pageIndex + 1}`,
    };
  });

  const pageIds = [];
  const pagesRef = objects.length + pageEntries.length + 1;
  pageEntries.forEach((entry) => {
    const pageId = addObject(
      latin1BytesFromString(
        `<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /XObject << /${entry.name} ${entry.imageObjectId} 0 R >> >> /Contents ${entry.contentObjectId} 0 R >>`,
      ),
    );
    pageIds.push(pageId);
  });

  const pagesId = addObject(
    latin1BytesFromString(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`),
  );
  const catalogId = addObject(latin1BytesFromString(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`));

  const header = latin1BytesFromString('%PDF-1.4\n');
  const chunks = [header];
  const offsets = [0];
  let totalLength = header.length;

  objects.forEach((object, index) => {
    offsets.push(totalLength);
    const prefix = latin1BytesFromString(`${index + 1} 0 obj\n`);
    const suffix = latin1BytesFromString('\nendobj\n');
    chunks.push(prefix, object, suffix);
    totalLength += prefix.length + object.length + suffix.length;
  });

  const xrefOffset = totalLength;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  xref += `trailer << /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  chunks.push(latin1BytesFromString(xref));

  return concatUint8Arrays(chunks);
}

function angleScore(prev, current, next) {
  const a = [current[0] - prev[0], current[1] - prev[1]];
  const b = [next[0] - current[0], next[1] - current[1]];
  const magA = Math.hypot(a[0], a[1]) || 1;
  const magB = Math.hypot(b[0], b[1]) || 1;
  const dot = (a[0] * b[0] + a[1] * b[1]) / (magA * magB);
  const clamped = Math.min(1, Math.max(-1, dot));
  return Math.PI - Math.acos(clamped);
}

function insetRect(rect, inset) {
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    width: rect.width - inset * 2,
    height: rect.height - inset * 2,
  };
}

function primaryCardinalSide(candidate) {
  const point = candidate?.point || candidate;
  const bounds = arguments[1];
  let normX = candidate?.normX;
  let normY = candidate?.normY;

  if (
    (!Number.isFinite(normX) || !Number.isFinite(normY)) &&
    bounds &&
    Array.isArray(point) &&
    point.length >= 2 &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1])
  ) {
    const spanLng = Math.max(bounds.maxLng - bounds.minLng, 1e-9);
    const spanLat = Math.max(bounds.maxLat - bounds.minLat, 1e-9);
    normX = (point[0] - bounds.minLng) / spanLng;
    normY = (point[1] - bounds.minLat) / spanLat;
  }

  const distances = [
    ['west', normX ?? 0.5],
    ['east', 1 - (normX ?? 0.5)],
    ['south', normY ?? 0.5],
    ['north', 1 - (normY ?? 0.5)],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0][0];
}

function hasValidCoordinatePoint(entry) {
  const point = entry?.point || entry;
  return Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

function buildReferenceCandidates(ring, options = {}) {
  return selectVisibleReferencePoints(ring, options).selectedCandidates;
}

function rectsOverlap(a, b, padding = 0) {
  return !(
    a.x + a.width + padding <= b.x ||
    b.x + b.width + padding <= a.x ||
    a.y + a.height + padding <= b.y ||
    b.y + b.height + padding <= a.y
  );
}

function ensureRectInside(rect, zone, name) {
  const inside =
    rect.x >= zone.x &&
    rect.y >= zone.y &&
    rect.x + rect.width <= zone.x + zone.width &&
    rect.y + rect.height <= zone.y + zone.height;

  if (!inside) {
    throw new Error(`El bloque ${name} se salió de su zona de composición.`);
  }
}

function createLayoutValidator(layout) {
  const blocks = [];
  return {
    add(name, rect, zoneName) {
      const zone = layout[zoneName];
      if (!zone) throw new Error(`Zona inexistente: ${zoneName}`);
      ensureRectInside(rect, zone, name);
      blocks.push({ name, rect, zoneName });
    },
    validateNoOverlap(names = null) {
      const subset = names ? blocks.filter((block) => names.includes(block.name)) : blocks;
      for (let i = 0; i < subset.length; i += 1) {
        for (let j = i + 1; j < subset.length; j += 1) {
          if (rectsOverlap(subset[i].rect, subset[j].rect, 2)) {
            throw new Error(`Los bloques ${subset[i].name} y ${subset[j].name} se superponen.`);
          }
        }
      }
    },
  };
}

async function ensurePdfFontsLoaded() {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return;
  if (!fontLoadPromise) {
    fontLoadPromise = (async () => {
      const fetchResults = await Promise.all(
        PDF_FONT_DEFINITIONS.map(async ({ url, weight }) => {
          try {
            const response = await fetch(url);

            if (!response.ok) {
              return { missing: true, url, weight, reason: `HTTP ${response.status}` };
            }

            return { missing: false, url, weight, buffer: await response.arrayBuffer() };
          } catch (error) {
            return {
              missing: true,
              url,
              weight,
              reason: error?.message || 'fetch failed',
            };
          }
        }),
      );

      const loadResults = await Promise.all(
        fetchResults.map(async (entry) => {
          if (entry.missing) return entry;

          try {
            const face = new FontFace(CUSTOM_PDF_FONT_FAMILY, entry.buffer, { weight: entry.weight, style: 'normal' });
            await face.load();
            document.fonts.add(face);
            return { missing: false, url: entry.url, weight: entry.weight };
          } catch (error) {
            return {
              missing: true,
              url: entry.url,
              weight: entry.weight,
              reason: error?.message || 'FontFace.load failed',
            };
          }
        }),
      );

      const missingFonts = loadResults.filter((entry) => entry.missing);
      if (missingFonts.length) {
        activePdfFontStack = PDF_FONT_FALLBACK_STACK;
        if (!pdfFontFallbackWarningIssued) {
          pdfFontFallbackWarningIssued = true;
          console.warn(
            `[CatastroX] Fuentes PDF personalizadas no disponibles (${missingFonts.map((entry) => `${entry.url}: ${entry.reason || 'sin detalle'}`).join(', ')}). Se usara el fallback del entorno: ${PDF_FONT_FALLBACK_STACK}.`,
          );
        }
        return;
      }

      await document.fonts.ready;
      activePdfFontStack = `"${CUSTOM_PDF_FONT_FAMILY}", ${PDF_FONT_FALLBACK_STACK}`;
    })();
  }

  await fontLoadPromise;
}

function createPageCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = PAGE.width * PAGE.scale;
  canvas.height = PAGE.height * PAGE.scale;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No fue posible inicializar el contexto de composición PDF.');
  context.scale(PAGE.scale, PAGE.scale);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, PAGE.width, PAGE.height);
  context.textBaseline = 'alphabetic';
  context.imageSmoothingEnabled = true;
  return { canvas, context };
}

function setFont(context, size, weight = 400) {
  context.font = `${weight} ${size}px ${activePdfFontStack}`;
}

function drawWrappedText(context, text, x, y, maxWidth, lineHeight, color = '#0f172a', weight = 400, size = 10) {
  setFont(context, size, weight);
  context.fillStyle = color;
  const words = cleanText(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (context.measureText(next).width <= maxWidth) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  lines.forEach((line, index) => {
    context.fillText(line, x, y + index * lineHeight);
  });

  return { lines, height: lines.length * lineHeight };
}

function chunkArray(values, chunkSize) {
  if (!Array.isArray(values) || chunkSize <= 0) return [];
  const chunks = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

function buildTechnicalSidePanelRects(referenceCount = 0, segmentCount = 0) {
  const panel = TECHNICAL_LAYOUT.rightPanel;
  const gap = 12;
  const canShowReferences = referenceCount > 0 && referenceCount <= 12;
  const infoHeight = 170;
  const distanceHeight = segmentCount > 18 ? 176 : 156;
  const guideHeight = canShowReferences ? panel.height - infoHeight - distanceHeight - gap * 2 : 0;

  return {
    infoRect: { x: panel.x, y: panel.y, width: panel.width, height: infoHeight },
    noteRect: { x: panel.x, y: panel.y + infoHeight + gap, width: panel.width, height: distanceHeight },
    guideRect: canShowReferences
      ? { x: panel.x, y: panel.y + infoHeight + gap + distanceHeight + gap, width: panel.width, height: guideHeight }
      : null,
  };
}

function drawVisibleReferencesPanel(context, rect, referenceRows) {
  drawPanel(context, rect, 'REFERENCIAS VISIBLES');
  const bodyX = rect.x + 12;
  const bodyY = rect.y + 42;
  const bodyWidth = rect.width - 24;
  const labels = referenceRows.map((row) => row.point).filter(Boolean);
  const labelGroups = chunkArray(labels, labels.length >= 18 ? 4 : labels.length >= 10 ? 5 : 6);

  const intro = drawWrappedText(
    context,
    `${labels.length} puntos visibles en este plano técnico.`,
    bodyX,
    bodyY,
    bodyWidth,
    12,
    '#243446',
    700,
    9.4,
  );

  let cursorY = bodyY + intro.height + 8;
  labelGroups.forEach((group) => {
    setFont(context, 8.7, 700);
    context.fillStyle = '#0f172a';
    context.fillText(group.join(', '), bodyX, cursorY);
    cursorY += 12;
  });

  cursorY += 4;
  drawWrappedText(
    context,
    'La tabla ejecutiva consolida longitudes y coordenadas del recorrido oficial.',
    bodyX,
    cursorY,
    bodyWidth,
    11,
    '#52637d',
    400,
    8.6,
  );
}

function formatLinearMeters(value) {
  return `${formatNumber(value)} m.l.`;
}

function drawDistanceTablePanel(context, rect, referenceSegments) {
  drawPanel(context, rect, 'TABLA DE DISTANCIAS');
  const bodyX = rect.x + 10;
  const bodyY = rect.y + 38;
  const bodyWidth = rect.width - 20;
  const columnGap = 8;
  const rowHeight = 11;
  const maxRowsPerColumn = Math.max(6, Math.floor((rect.height - 50) / rowHeight));
  const useTwoColumns = referenceSegments.length > maxRowsPerColumn;
  const columnCount = useTwoColumns ? 2 : 1;
  const columnWidth = (bodyWidth - columnGap * (columnCount - 1)) / columnCount;
  const visibleCapacity = maxRowsPerColumn * columnCount;
  const visibleSegments = referenceSegments.slice(0, visibleCapacity);
  const segmentColumns = chunkArray(
    visibleSegments,
    Math.ceil(visibleSegments.length / columnCount),
  );

  segmentColumns.forEach((columnSegments, columnIndex) => {
    const columnX = bodyX + columnIndex * (columnWidth + columnGap);
    context.fillStyle = '#52637d';
    setFont(context, 7.2, 700);
    context.fillText('Tramo', columnX, bodyY);
    context.fillText('Distancia', columnX + columnWidth * 0.42, bodyY);
    context.strokeStyle = '#d6dfef';
    context.beginPath();
    context.moveTo(columnX, bodyY + 4);
    context.lineTo(columnX + columnWidth, bodyY + 4);
    context.stroke();

    let cursorY = bodyY + 16;
    columnSegments.forEach((segment) => {
      context.fillStyle = '#0f172a';
      setFont(context, 7.1, 700);
      context.fillText(`${segment.from}-${segment.to}`, columnX, cursorY);
      drawWrappedText(
        context,
        formatLinearMeters(segment.distance),
        columnX + columnWidth * 0.42,
        cursorY,
        columnWidth * 0.58,
        10,
        '#243446',
        400,
        7.1,
      );
      cursorY += rowHeight;
    });
  });

  if (referenceSegments.length > visibleCapacity) {
    drawWrappedText(
      context,
      'La tabla ejecutiva presenta el recorrido completo.',
      bodyX,
      rect.y + rect.height - 12,
      bodyWidth,
      10,
      '#52637d',
      400,
      7.8,
    );
  }
}

function resolvePlanLayoutOptions(predio, options = {}) {
  const { preferDenseVisiblePoints: _preferDenseVisiblePoints, ...rest } = options;
  return rest;
}

function drawHeader(context, predio, pageLabel, title, layout) {
  const zone = layout.header;
  context.strokeStyle = '#c9d6ea';
  context.strokeRect(zone.x, zone.y, zone.width, zone.height);
  context.fillStyle = '#10233a';
  setFont(context, 28, 700);
  context.fillText('Catastro', zone.x + 14, zone.y + 30);
  context.fillStyle = '#00aeea';
  context.fillText('X', zone.x + 124, zone.y + 30);
  context.fillStyle = '#10233a';
  setFont(context, 9, 400);
  context.fillText('by CRH', zone.x + 16, zone.y + 46);
  context.fillText('Vertical predial de AgroGenomaX', zone.x + 16, zone.y + 60);

  setFont(context, 18, 700);
  context.fillStyle = '#0a2e73';
  context.fillText(title, zone.x + 360, zone.y + 24);
  setFont(context, 8, 700);
  context.fillStyle = '#334155';
  context.fillText('CÓDIGO PREDIAL', zone.x + 500, zone.y + 42);
  setFont(context, 11, 700);
  context.fillStyle = '#0f172a';
  context.fillText(predio.codigoPredial, zone.x + 500, zone.y + 58);

  context.fillStyle = '#0a2e73';
  context.fillRect(zone.x + zone.width - 56, zone.y + 8, 42, 34);
  context.fillStyle = '#ffffff';
  setFont(context, 7, 700);
  context.fillText('PÁGINA', zone.x + zone.width - 50, zone.y + 21);
  setFont(context, 10, 700);
  context.fillText(pageLabel, zone.x + zone.width - 46, zone.y + 34);
}

function drawPanel(context, rect, title) {
  context.fillStyle = '#ffffff';
  context.fillRect(rect.x, rect.y, rect.width, rect.height);
  context.strokeStyle = '#c9d6ea';
  context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  context.fillStyle = '#0a2e73';
  context.fillRect(rect.x, rect.y, rect.width, 24);
  context.fillStyle = '#ffffff';
  setFont(context, 10, 700);
  context.fillText(title, rect.x + 12, rect.y + 16);
}

function tileUrl(template, z, x, y) {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

async function loadTileBitmap(url) {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timeoutId =
    controller &&
    setTimeout(() => {
      controller.abort();
    }, 5000);

  const response = await fetch(url, {
    mode: 'cors',
    signal: controller?.signal,
  }).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });

  if (!response.ok) throw new Error(`No se pudo cargar tile ${url}`);
  const blob = await response.blob();
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob);
  }

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = URL.createObjectURL(blob);
  });
}

async function drawHybridMap(context, zone, mapState) {
  const centerPixelX = mapState.centerWorldX * mapState.scale;
  const centerPixelY = mapState.centerWorldY * mapState.scale;
  const left = centerPixelX - zone.width / 2;
  const top = centerPixelY - zone.height / 2;
  const right = centerPixelX + zone.width / 2;
  const bottom = centerPixelY + zone.height / 2;

  const tileXStart = Math.floor(left / TILE_SIZE);
  const tileXEnd = Math.floor(right / TILE_SIZE);
  const tileYStart = Math.floor(top / TILE_SIZE);
  const tileYEnd = Math.floor(bottom / TILE_SIZE);

  context.fillStyle = '#eef4fb';
  context.fillRect(zone.x, zone.y, zone.width, zone.height);
  context.strokeStyle = '#c9d6ea';
  context.lineWidth = 1;
  context.strokeRect(zone.x, zone.y, zone.width, zone.height);

  context.save();
  context.beginPath();
  context.rect(zone.x, zone.y, zone.width, zone.height);
  context.clip();

  context.fillStyle = '#1a3325';
  context.fillRect(zone.x, zone.y, zone.width, zone.height);

  for (const template of [IMAGERY_TILE_URL, LABELS_TILE_URL]) {
    const jobs = [];
    for (let tileX = tileXStart; tileX <= tileXEnd; tileX += 1) {
      for (let tileY = tileYStart; tileY <= tileYEnd; tileY += 1) {
        jobs.push({
          tileX,
          tileY,
          url: tileUrl(template, mapState.zoom, tileX, tileY),
        });
      }
    }

    const results = await Promise.allSettled(
      jobs.map(async (job) => ({
        bitmap: await loadTileBitmap(job.url),
        drawX: zone.x + job.tileX * TILE_SIZE - left,
        drawY: zone.y + job.tileY * TILE_SIZE - top,
      })),
    );

    results.forEach((result) => {
      if (result.status !== 'fulfilled') return;
      context.drawImage(result.value.bitmap, result.value.drawX, result.value.drawY, TILE_SIZE, TILE_SIZE);
    });
  }

  context.restore();
}

function toCanvasRect(zone) {
  return { x: zone.x, y: zone.y, width: zone.width, height: zone.height };
}

function drawPolygonOverlay(context, points, { stroke = '#ffea00', fill = 'rgba(0, 116, 136, 0.24)', lineWidth = 2 } = {}) {
  if (!points.length) return;
  context.beginPath();
  context.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) {
    context.lineTo(x, y);
  }
  context.closePath();
  if (fill) {
    context.fillStyle = fill;
    context.fill();
  }
  context.lineWidth = lineWidth;
  context.strokeStyle = stroke;
  context.stroke();
}

function buildVisiblePointPlacements(projectedPoints, mapZone, polygonPoints = [], blockedRects = []) {
  const center = polygonPoints.length ? ringCentroid(polygonPoints) : ringCentroid(projectedPoints);
  const placements = [];
  let displacedCount = 0;
  let guideCount = 0;
  let hiddenCount = 0;

  projectedPoints.forEach(([x, y], index) => {
    const baseAngle = Math.atan2(y - center[1], x - center[0]);
    const angleOffsets = [0, -0.32, 0.32, -0.64, 0.64, -0.96, 0.96, -1.28, 1.28, Math.PI];
    const distanceOffsets = [18, 26, 34, 42, 52, 62, 72, 0];
    let best = null;

    for (const distance of distanceOffsets) {
      for (const angleOffset of angleOffsets) {
        const angle = baseAngle + angleOffset;
        const circleX = x + Math.cos(angle) * distance;
        const circleY = y + Math.sin(angle) * distance;
        const rect = { x: circleX - 8, y: circleY - 8, width: 16, height: 16 };
        const inside =
          rect.x >= mapZone.x + 3 &&
          rect.y >= mapZone.y + 3 &&
          rect.x + rect.width <= mapZone.x + mapZone.width - 3 &&
          rect.y + rect.height <= mapZone.y + mapZone.height - 3;
        const overlapsPoint = placements.some((placement) => rectsOverlap(rect, placement.rect, 3));
        const overlapsBlocked = blockedRects.some((blockedRect) => rectsOverlap(rect, blockedRect, 4));
        if (inside && !overlapsPoint && !overlapsBlocked) {
          best = {
            anchorX: x,
            anchorY: y,
            circleX,
            circleY,
            rect,
            showGuide: distance >= 12,
          };
          break;
        }
      }
      if (best) break;
    }

    if (!best) {
      hiddenCount += 1;
      best = {
        anchorX: x,
        anchorY: y,
        circleX: x,
        circleY: y,
        rect: { x: x - 9, y: y - 9, width: 18, height: 18 },
        showGuide: false,
        hidden: true,
      };
    } else if (Math.hypot(best.circleX - x, best.circleY - y) > 4) {
      displacedCount += 1;
      if (best.showGuide) guideCount += 1;
    }

    placements.push(best);
  });

  placements.displacedCount = displacedCount;
  placements.guideCount = guideCount;
  placements.hiddenCount = hiddenCount;
  return placements;
}

function drawVisiblePoints(context, projectedPoints, placements = null, options = {}) {
  const {
    radius = 7.25,
    lineWidth = 1.5,
    fontSize = 7.1,
    fillStyle = '#ffffff',
    strokeStyle = '#0a2e73',
    textColor = '#0a2e73',
    guideColor = '#9aa7bc',
    guideLineWidth = 0.8,
  } = options;
  const finalPlacements =
    placements ||
    projectedPoints.map(([x, y]) => ({
      anchorX: x,
      anchorY: y,
      circleX: x,
      circleY: y,
      rect: { x: x - 9, y: y - 9, width: 18, height: 18 },
      showGuide: false,
    }));

  finalPlacements.forEach((placement, index) => {
    const { anchorX, anchorY, circleX: x, circleY: y, showGuide, hidden } = placement;
    if (hidden) return;
    if (showGuide) {
      context.strokeStyle = guideColor;
      context.lineWidth = guideLineWidth;
      context.beginPath();
      context.moveTo(anchorX, anchorY);
      context.lineTo(x, y);
      context.stroke();
    }
    context.fillStyle = fillStyle;
    context.strokeStyle = strokeStyle;
    context.lineWidth = lineWidth;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = textColor;
    setFont(context, fontSize, 700);
    const label = `P${index + 1}`;
    const textWidth = context.measureText(label).width;
    context.fillText(label, x - textWidth / 2, y + 3);
  });
}

function drawScaleBar(context, x, y, totalMeters = 800, options = {}) {
  const { compact = false } = options;
  const boxWidth = compact ? 146 : 170;
  const boxHeight = compact ? 46 : 50;
  const blockWidth = compact ? 26 : 32;
  const boxTop = y - 22;
  const barY = boxTop + 18;
  const labelY = boxTop + 13;
  const tickY = boxTop + 38;

  context.fillStyle = '#ffffff';
  context.fillRect(x - 8, boxTop, boxWidth, boxHeight);
  context.strokeStyle = '#10233a';
  context.strokeRect(x - 8, boxTop, boxWidth, boxHeight);
  context.fillStyle = '#10233a';
  setFont(context, compact ? 8 : 9, 700);
  context.fillText('ESCALA GRÁFICA', x, labelY);

  for (let index = 0; index < 4; index += 1) {
    context.fillStyle = index % 2 === 0 ? '#10233a' : '#ffffff';
    context.fillRect(x + index * blockWidth, barY, blockWidth, 10);
    context.strokeStyle = '#10233a';
    context.strokeRect(x + index * blockWidth, barY, blockWidth, 10);
  }
  context.fillStyle = '#10233a';
  setFont(context, 8, 400);
  context.fillText('0', x, tickY);
  context.fillText(`${Math.round(totalMeters / 4)}`, x + Math.round(blockWidth * 0.9), tickY);
  context.fillText(`${Math.round(totalMeters / 2)}`, x + Math.round(blockWidth * 1.9), tickY);
  context.fillText(`${Math.round((totalMeters * 3) / 4)}`, x + Math.round(blockWidth * 2.9), tickY);
  context.fillText(`${totalMeters} m`, x + Math.round(blockWidth * 3.7), tickY);
}

function getScaleBarRect(x, y, compact = false) {
  const boxWidth = compact ? 146 : 170;
  const boxHeight = compact ? 46 : 50;
  return { x: x - 8, y: y - 22, width: boxWidth, height: boxHeight };
}

function pointInExpandedRect(point, rect, padding = 0) {
  return (
    point[0] >= rect.x - padding &&
    point[0] <= rect.x + rect.width + padding &&
    point[1] >= rect.y - padding &&
    point[1] <= rect.y + rect.height + padding
  );
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];
    const intersect =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function chooseScaleBarAnchor(mapRect, projected, projectedRefs, placements = [], compact = false) {
  const candidates = [
    { x: mapRect.x + 18, y: mapRect.y + mapRect.height - 24 },
    { x: mapRect.x + mapRect.width - 166, y: mapRect.y + mapRect.height - 24 },
    { x: mapRect.x + 18, y: mapRect.y + 70 },
    { x: mapRect.x + mapRect.width - 166, y: mapRect.y + 70 },
  ];

  const polygonBounds = getPointBounds(projected);
  let best = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;

  candidates.forEach((candidate, index) => {
    const rect = getScaleBarRect(candidate.x, candidate.y, compact);
    let score = 0;

    projected.forEach((point) => {
      if (pointInExpandedRect(point, rect, 10)) score += 12;
    });
    projectedRefs.forEach((point) => {
      if (pointInExpandedRect(point, rect, 16)) score += 22;
    });
    placements.forEach((placement) => {
      if (rectsOverlap(rect, placement.rect, 10)) score += 28;
    });

    if (rectsOverlap(rect, polygonBounds, 12)) score += 18;
    score += index * 0.4;

    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  });

  return best;
}

function drawCompassRose(context, x, y, dark = false) {
  const color = dark ? '#10233a' : '#ffffff';
  const secondary = dark ? '#ffffff' : '#10233a';
  const outer = 18;
  const inner = 7;

  context.save();
  context.translate(x, y);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 1.2;

  for (let index = 0; index < 8; index += 1) {
    const angle = (Math.PI / 4) * index - Math.PI / 2;
    const tipX = Math.cos(angle) * outer;
    const tipY = Math.sin(angle) * outer;
    const leftX = Math.cos(angle + Math.PI / 12) * inner;
    const leftY = Math.sin(angle + Math.PI / 12) * inner;
    const rightX = Math.cos(angle - Math.PI / 12) * inner;
    const rightY = Math.sin(angle - Math.PI / 12) * inner;
    context.beginPath();
    context.moveTo(tipX, tipY);
    context.lineTo(leftX, leftY);
    context.lineTo(rightX, rightY);
    context.closePath();
    if (index % 2 === 0) {
      context.fill();
    } else {
      context.save();
      context.fillStyle = secondary;
      context.fill();
      context.restore();
      context.stroke();
    }
  }

  context.beginPath();
  context.arc(0, 0, 5.5, 0, Math.PI * 2);
  context.fillStyle = dark ? '#ffffff' : '#10233a';
  context.fill();
  context.strokeStyle = color;
  context.stroke();

  context.fillStyle = color;
  setFont(context, 8, 700);
  context.fillText('N', -3, -24);
  context.fillText('S', -3, 31);
  context.fillText('O', -27, 3);
  context.fillText('E', 21, 3);
  context.restore();
}

function drawKeyValueRows(context, startX, startY, width, rows, options = {}) {
  const {
    labelSize = 9,
    valueSize = 11,
    labelGap = 14,
    rowGap = 22,
    lineHeight = 12,
  } = options;
  let cursorY = startY;
  rows.forEach(({ label, value }) => {
    context.fillStyle = '#52637d';
    setFont(context, labelSize, 700);
    context.fillText(label, startX, cursorY);
    const result = drawWrappedText(context, value, startX, cursorY + labelGap, width, lineHeight, '#0f172a', 700, valueSize);
    cursorY += rowGap + Math.max(0, result.height - lineHeight);
  });
}

function buildAutomaticDiagnosis(predio) {
  const areaLabel = Number.isFinite(predio.areaHa) && predio.areaHa > 0 ? `${formatNumber(predio.areaHa)} ha` : 'Sin dato';
  return [
    `La consulta identifica un predio individualizado con código predial ${predio.codigoPredial}.`,
    `El área estimada en la información catastral consultada es ${areaLabel} y el perímetro reportado es ${formatNumber(predio.perimetroM)} m.`,
    'La información es adecuada para una revisión predial inicial y para apoyar conversaciones técnicas, comerciales o jurídicas previas.',
  ];
}

function buildAutomaticRecommendations(predio) {
  const recommendations = [
    'Verifique la correspondencia del predio con la autoridad catastral competente antes de un trámite jurídico, comercial o de registro.',
    'Utilice el plano predial para revisar ubicación, forma general del polígono y referencias de lectura antes de compartir la información con terceros.',
  ];
  if (predio.areaHa >= 100) {
    recommendations.push(
      'Por la extensión del predio, conviene revisar la información con acompañamiento técnico antes de adelantar negociación, subdivisión o regularización.',
    );
  } else {
    recommendations.push(
      'Si requiere mayor precisión para venta, crédito o subdivisión, solicite validación técnica complementaria antes de avanzar.',
    );
  }
  return recommendations;
}

function drawBullets(context, items, x, y, width, color) {
  let cursorY = y;
  items.forEach((item) => {
    context.fillStyle = color;
    context.fillRect(x, cursorY - 7, 6, 6);
    const result = drawWrappedText(context, item, x + 14, cursorY, width - 14, 14, '#243446', 400, 10.5);
    cursorY += Math.max(22, result.height + 8);
  });
}

function buildDiagnosticPageCanvas(predio) {
  const { canvas, context } = createPageCanvas();
  const layout = {
    page: { x: 0, y: 0, width: 612, height: 792 },
    header: { x: 24, y: 24, width: 564, height: 84 },
    body: { x: 24, y: 120, width: 564, height: 620 },
    footer: { x: 24, y: 748, width: 564, height: 20 },
  };

  context.fillStyle = '#f9fbff';
  context.fillRect(24, 24, 564, 744);
  context.strokeStyle = '#c9d6ea';
  context.strokeRect(24, 24, 564, 744);

  drawHeader(context, predio, '', 'Diagnóstico Predial CatastroX', {
    header: layout.header,
  });

  const rows = [
    ['Código predial', predio.codigoPredial],
    ['Código anterior', predio.codigoAnterior],
    ['Municipio', predio.municipio],
    ['Departamento', predio.departamento],
    ['Tipo de zona', predio.tipoZona],
    ['Área total', `${formatNumber(predio.areaHa)} ha`],
    ['Área total m²', `${formatNumber(predio.areaM2)} m²`],
    ['Perímetro', `${formatNumber(predio.perimetroM)} m`],
    ['Estado predial', predio.estadoPredial],
  ];

  let y = 144;
  rows.forEach(([label, value], index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = 44 + col * 274;
    const boxY = y + row * 64;
    context.fillStyle = '#ffffff';
    context.fillRect(x, boxY, 250, 52);
    context.strokeStyle = '#d6dfef';
    context.strokeRect(x, boxY, 250, 52);
    context.fillStyle = '#52637d';
    setFont(context, 9, 700);
    context.fillText(label.toUpperCase(), x + 12, boxY + 16);
    drawWrappedText(context, value, x + 12, boxY + 34, 226, 12, '#0f172a', 700, 11);
  });

  setFont(context, 12, 700);
  context.fillStyle = '#0f172a';
  context.fillText('DIAGNÓSTICO AUTOMÁTICO', 44, 468);
  drawBullets(context, buildAutomaticDiagnosis(predio), 44, 490, 520, '#00aeea');

  context.fillStyle = '#0f172a';
  context.fillText('RECOMENDACIONES AUTOMÁTICAS', 44, 612);
  drawBullets(context, buildAutomaticRecommendations(predio), 44, 634, 520, '#8bcf2b');

  context.fillStyle = '#52637d';
  setFont(context, 10, 700);
  context.fillText('AVISO LEGAL', 44, 734);
  drawWrappedText(
    context,
    'CatastroX realiza análisis técnico sobre información geográfica y catastral pública disponible. Este documento no reemplaza certificados oficiales del IGAC, gestor catastral, oficina de registro ni autoridad competente.',
    44,
    750,
    520,
    11,
    '#243446',
    400,
    9,
  );

  return canvas;
}

function drawDistanceLabels(context, placements, options = {}) {
  const {
    fontSize = 8,
    textColor = '#334155',
    fillStyle = 'rgba(255,255,255,0.92)',
    strokeStyle = '#cbd5e1',
    lineWidth = 0.8,
    guideColor = '#9ca3af',
    guideLineWidth = 0.75,
    boxPaddingX = 2,
    boxPaddingY = 1,
    showBorder = true,
  } = options;
  context.fillStyle = textColor;
  context.lineWidth = lineWidth;
  setFont(context, fontSize, 400);
  let guideLinesRendered = 0;
  placements.forEach((placement) => {
    if (placement?.status === 'hidden') return;
    const guideLine = placement?.guideLine;
    if (
      guideLine &&
      Number.isFinite(guideLine.x1) &&
      Number.isFinite(guideLine.y1) &&
      Number.isFinite(guideLine.x2) &&
      Number.isFinite(guideLine.y2)
    ) {
      context.strokeStyle = guideColor;
      context.lineWidth = guideLineWidth;
      context.beginPath();
      context.moveTo(guideLine.x1, guideLine.y1);
      context.lineTo(guideLine.x2, guideLine.y2);
      context.stroke();
      guideLinesRendered += 1;
    }
    context.fillStyle = fillStyle;
    context.fillRect(
      placement.rect.x - boxPaddingX,
      placement.rect.y - boxPaddingY,
      placement.rect.width + boxPaddingX * 2,
      placement.rect.height + boxPaddingY * 2,
    );
    if (showBorder) {
      context.strokeStyle = strokeStyle;
      context.lineWidth = lineWidth;
      context.strokeRect(
        placement.rect.x - boxPaddingX,
        placement.rect.y - boxPaddingY,
        placement.rect.width + boxPaddingX * 2,
        placement.rect.height + boxPaddingY * 2,
      );
    }
    context.fillStyle = textColor;
    context.fillText(placement.text, placement.rect.x, placement.rect.y + 10);
  });
  if (placements?.auditReport) {
    placements.auditReport.guideLinesRendered = guideLinesRendered;
  }
}

function buildTechnicalPageDistancePlacements(placements, pointPlacements, mapRect) {
  const accepted = [];
  const blockedRects = pointPlacements
    .filter((placement) => !placement.hidden)
    .map((placement) => placement.rect);

  const candidates = placements
    .map((placement, index) => {
      const centerDistance =
        Number.isFinite(placement?.labelCenterX) &&
        Number.isFinite(placement?.labelCenterY) &&
        Number.isFinite(placement?.midX) &&
        Number.isFinite(placement?.midY)
          ? Math.hypot(placement.labelCenterX - placement.midX, placement.labelCenterY - placement.midY)
          : Number.POSITIVE_INFINITY;
      const guideLength = Number.isFinite(placement?.guideLine?.lengthPx) ? placement.guideLine.lengthPx : 0;
      const strategyPenalty =
        placement?.candidateStrategy === 'primary-offset' ? 0 :
        placement?.candidateStrategy === 'secondary-offset' ? 8 :
        placement?.candidateStrategy === 'edge-angular-fallback' ? 14 :
        20;
      return {
        placement,
        index,
        centerDistance,
        guideLength,
        score: centerDistance + guideLength * 0.55 + strategyPenalty,
      };
    })
    .filter(({ placement }) =>
      placement?.status !== 'hidden' &&
      placement?.rect &&
      Number.isFinite(placement.rect.x) &&
      Number.isFinite(placement.rect.y) &&
      Number.isFinite(placement.rect.width) &&
      Number.isFinite(placement.rect.height),
    )
    .sort((left, right) => left.score - right.score);

  candidates.forEach((entry) => {
    const { placement, centerDistance, guideLength } = entry;
    const rect = placement.rect;
    const inside =
      rect.x >= mapRect.x + 2 &&
      rect.y >= mapRect.y + 2 &&
      rect.x + rect.width <= mapRect.x + mapRect.width - 2 &&
      rect.y + rect.height <= mapRect.y + mapRect.height - 2;
    if (!inside) return;
    if (centerDistance > 116 && guideLength > 112) return;
    if (blockedRects.some((blockedRect) => rectsOverlap(rect, blockedRect, 2))) return;
    if (accepted.some((acceptedPlacement) => rectsOverlap(rect, acceptedPlacement.rect, 2))) return;
    accepted.push(placement);
    blockedRects.push(rect);
  });

  const acceptedIndices = new Set(accepted.map((placement) => placements.indexOf(placement)));
  return placements.map((placement, index) =>
    acceptedIndices.has(index) ? placement : { ...placement, status: 'hidden' },
  );
}

function getCompassRoseRect(x, y) {
  return { x: x - 30, y: y - 30, width: 60, height: 60 };
}

function normalizeDimensionAngle(angle) {
  let next = angle;
  if (next > Math.PI / 2) next -= Math.PI;
  if (next < -Math.PI / 2) next += Math.PI;
  return next;
}

function buildRotatedRect(centerX, centerY, width, height, angle) {
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const boundWidth = width * cos + height * sin;
  const boundHeight = width * sin + height * cos;
  return {
    x: centerX - boundWidth / 2,
    y: centerY - boundHeight / 2,
    width: boundWidth,
    height: boundHeight,
  };
}

function buildTechnicalSegmentDimensionPlacements(
  context,
  projectedRefs,
  referenceSegments,
  polygonPoints,
  pointPlacements,
  mapRect,
  reservedRects = [],
) {
  setFont(context, 7.2, 400);
  const blockedRects = [
    ...pointPlacements.filter((placement) => !placement.hidden).map((placement) => placement.rect),
    ...reservedRects,
  ];
  const placements = [];
  let omittedCount = 0;

  referenceSegments.forEach((segment, index) => {
    const start = projectedRefs[index];
    const end = projectedRefs[(index + 1) % projectedRefs.length];
    if (!start || !end) {
      omittedCount += 1;
      return;
    }

    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length < 10) {
      omittedCount += 1;
      return;
    }

    const text = `${formatNumber(segment.distance)} m`;
    const textWidth = context.measureText(text).width;
    const textHeight = 8;
    const angle = normalizeDimensionAngle(Math.atan2(dy, dx));
    const tangent = { x: dx / length, y: dy / length };
    const normals = [
      { x: -tangent.y, y: tangent.x },
      { x: tangent.y, y: -tangent.x },
    ];
    const midpoint = { x: (start[0] + end[0]) / 2, y: (start[1] + end[1]) / 2 };
    const exteriorFirst =
      !pointInPolygon([midpoint.x + normals[0].x * 12, midpoint.y + normals[0].y * 12], polygonPoints);
    const orderedNormals = exteriorFirst ? normals : [normals[1], normals[0]];
    const alongOffsets = [0, -12, 12, -22, 22];
    const normalOffsets = length < 34 ? [24, 32, 40] : length < 72 ? [18, 24, 32] : [14, 20, 28];
    let best = null;

    orderedNormals.forEach((normal, normalIndex) => {
      normalOffsets.forEach((normalOffset) => {
        alongOffsets.forEach((alongOffset) => {
          const centerX = midpoint.x + tangent.x * alongOffset + normal.x * normalOffset;
          const centerY = midpoint.y + tangent.y * alongOffset + normal.y * normalOffset;
          const maskWidth = textWidth + 4;
          const maskHeight = textHeight + 2;
          const rect = buildRotatedRect(centerX, centerY, maskWidth, maskHeight, angle);
          const inside =
            rect.x >= mapRect.x + 3 &&
            rect.y >= mapRect.y + 3 &&
            rect.x + rect.width <= mapRect.x + mapRect.width - 3 &&
            rect.y + rect.height <= mapRect.y + mapRect.height - 3;
          if (!inside) return;
    if (blockedRects.some((blockedRect) => rectsOverlap(rect, blockedRect, 3))) return;
    if (placements.some((placement) => rectsOverlap(rect, placement.rect, 4))) return;

          const centerInsidePolygon = pointInPolygon([centerX, centerY], polygonPoints);
          const useGuide = normalOffset >= 20 || length < 42;
          const score =
            normalOffset +
            Math.abs(alongOffset) * 0.5 +
            (centerInsidePolygon ? 10 : 0) +
            normalIndex * 4;
          if (!best || score < best.score) {
            best = {
              text,
              angle,
              centerX,
              centerY,
              maskWidth,
              maskHeight,
              rect,
              score,
              guideLine: useGuide
                ? {
                    x1: midpoint.x + normal.x * 4,
                    y1: midpoint.y + normal.y * 4,
                    x2: centerX - normal.x * (textHeight * 0.25),
                    y2: centerY - normal.y * (textHeight * 0.25),
                  }
                : null,
            };
          }
        });
      });
    });

    if (!best) {
      omittedCount += 1;
      return;
    }

    placements.push(best);
    blockedRects.push(best.rect);
  });

  return { placements, omittedCount };
}

function drawTechnicalSegmentDimensions(context, placements) {
  placements.forEach((placement) => {
    if (placement?.guideLine) {
      context.strokeStyle = '#b7c0cd';
      context.lineWidth = 0.5;
      context.beginPath();
      context.moveTo(placement.guideLine.x1, placement.guideLine.y1);
      context.lineTo(placement.guideLine.x2, placement.guideLine.y2);
      context.stroke();
    }

    context.save();
    context.translate(placement.centerX, placement.centerY);
    context.rotate(placement.angle);
    context.fillStyle = 'rgba(255,255,255,0.74)';
    context.fillRect(-placement.maskWidth / 2, -placement.maskHeight / 2, placement.maskWidth, placement.maskHeight);
    context.fillStyle = '#64748b';
    setFont(context, 6.8, 400);
    const textWidth = context.measureText(placement.text).width;
    context.fillText(placement.text, -textWidth / 2, 3);
    context.restore();
  });
}

function drawSimpleTable(context, zone, title, headers, columnXs, rows) {
  drawPanel(context, zone, title);
  const bodyTop = zone.y + 34;
  const rowHeight = 20;

  context.fillStyle = '#0f172a';
  setFont(context, 8.5, 700);
  headers.forEach((header, index) => {
    context.fillText(header, columnXs[index], bodyTop);
  });

  context.strokeStyle = '#d6dfef';
  context.beginPath();
  context.moveTo(zone.x + 10, bodyTop + 6);
  context.lineTo(zone.x + zone.width - 10, bodyTop + 6);
  context.stroke();

  let cursorY = bodyTop + 20;
  rows.forEach((row, rowIndex) => {
    if (cursorY > zone.y + zone.height - 16) {
      throw new Error(`La tabla ${title} excede su zona asignada.`);
    }

    if (rowIndex % 2 === 0) {
      context.fillStyle = '#f8fbff';
      context.fillRect(zone.x + 8, cursorY - 12, zone.width - 16, rowHeight);
    }

    context.fillStyle = '#334155';
    setFont(context, 8.4, 400);
    row.forEach((cell, index) => {
      context.fillText(String(cell), columnXs[index], cursorY);
    });
    cursorY += rowHeight;
  });
}

function estimateTableHeight(rowCount) {
  return 34 + rowCount * 20 + 20;
}

function buildUnifiedTableRows(referenceRows, referenceSegments) {
  return referenceRows.map((row, index) => [
    row.point,
    row.lat,
    row.lng,
    `${referenceSegments[index].from}-${referenceSegments[index].to}`,
    `${Math.round(referenceSegments[index].distance)} m`,
  ]);
}

function buildExecutiveTablePageCanvas(predio, pageLabel, rows, startIndex = 0, isContinuation = false, totalPages = 3) {
  const { canvas, context } = createPageCanvas();
  const validator = createLayoutValidator(TABLE_LAYOUT);

  validator.add('header', TABLE_LAYOUT.header, 'header');
  validator.add('mapArea', TABLE_LAYOUT.mapArea, 'mapArea');
  validator.add('bottomPanel', TABLE_LAYOUT.bottomPanel, 'bottomPanel');
  validator.add('footer', TABLE_LAYOUT.footer, 'footer');
  validator.validateNoOverlap(['mapArea', 'bottomPanel', 'footer']);

  drawHeader(context, predio, pageLabel, 'PLANO PREDIAL CATASTROX', TABLE_LAYOUT);

  const tableRect = {
    x: TABLE_LAYOUT.mapArea.x,
    y: TABLE_LAYOUT.mapArea.y,
    width: TABLE_LAYOUT.mapArea.width,
    height: TABLE_LAYOUT.mapArea.height,
  };
  validator.add('table', tableRect, 'mapArea');

  const headers = ['Punto', 'Latitud', 'Longitud', 'Tramo', 'Distancia'];
  const columnXs = [tableRect.x + 16, tableRect.x + 96, tableRect.x + 254, tableRect.x + 448, tableRect.x + 586];
  const rowHeight = 20;
  const bodyTop = tableRect.y + 34;
  const availableRows = Math.max(1, Math.floor((tableRect.height - 54) / rowHeight));
  const visibleRows = rows.slice(startIndex, startIndex + availableRows);

  drawSimpleTable(
    context,
    tableRect,
    isContinuation ? 'TABLA EJECUTIVA DE PUNTOS VISIBLES Y LONGITUDES (CONTINUACIÓN)' : 'TABLA EJECUTIVA DE PUNTOS VISIBLES Y LONGITUDES',
    headers,
    columnXs,
    visibleRows,
  );

  drawWrappedText(
    context,
    'La tabla ejecutiva compila en una sola vista los puntos visibles del plano, sus coordenadas y la distancia entre tramos consecutivos. La totalidad de vértices permanece en los archivos GIS descargables.',
    TABLE_LAYOUT.bottomPanel.x,
    TABLE_LAYOUT.bottomPanel.y + 14,
    TABLE_LAYOUT.bottomPanel.width,
    12,
    '#334155',
    400,
    9,
  );

  drawWrappedText(
    context,
    'CatastroX realiza análisis técnico sobre información geográfica y catastral pública disponible. Este documento no reemplaza certificados oficiales del IGAC, gestor catastral, oficina de registro ni autoridad competente.',
    TABLE_LAYOUT.footer.x,
    TABLE_LAYOUT.footer.y + 10,
    TABLE_LAYOUT.footer.width,
    10,
    '#334155',
    400,
    8,
  );

  return {
    canvas,
    nextIndex: startIndex + visibleRows.length,
    totalPages,
  };
}

function buildExecutiveTablePagesCanvases(predio, referenceRows, referenceSegments) {
  const unifiedRows = buildUnifiedTableRows(referenceRows, referenceSegments);
  const availableRows = Math.max(1, Math.floor((TABLE_LAYOUT.mapArea.height - 54) / 20));
  const totalTablePages = Math.ceil(unifiedRows.length / availableRows);
  const totalPages = 2 + totalTablePages;
  const canvases = [];
  let nextIndex = 0;

  for (let tablePage = 0; tablePage < totalTablePages; tablePage += 1) {
    const pageLabel = `${3 + tablePage} de ${totalPages}`;
    const result = buildExecutiveTablePageCanvas(predio, pageLabel, unifiedRows, nextIndex, tablePage > 0, totalPages);
    canvases.push(result.canvas);
    nextIndex = result.nextIndex;
  }

  return canvases;
}

function buildReferenceTableRows(referenceRows, referenceSegments) {
  return referenceRows.map((row, index) => ({
    point: row.point,
    lat: row.lat,
    lng: row.lng,
    segment: `${referenceSegments[index].from}-${referenceSegments[index].to}`,
    distance: `${Math.round(referenceSegments[index].distance)} m`,
  }));
}

function medianValue(values) {
  if (!Array.isArray(values) || !values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function recoverLongVisibleSpanCandidates(allVisibleCandidates, visibleCandidates, presentationRing, officialRing) {
  const presentationOpenRing = Array.isArray(presentationRing) ? presentationRing.slice(0, -1) : [];
  const officialOpenRing = Array.isArray(officialRing) ? officialRing.slice(0, -1) : [];
  if (
    !Array.isArray(allVisibleCandidates) ||
    !Array.isArray(visibleCandidates) ||
    visibleCandidates.length < 3 ||
    allVisibleCandidates.length <= visibleCandidates.length ||
    presentationOpenRing.length < 4 ||
    officialOpenRing.length < 4
  ) {
    return {
      visibleCandidates,
      report: {
        recoveredCount: 0,
        recoveredSpanCount: 0,
        recoveredOriginalIndices: [],
      },
    };
  }

  const initialIndexSet = new Set(visibleCandidates.map((entry) => entry.displayRingIndex));
  const officialCumulative = cumulativeDistances(officialOpenRing);
  const localPresentationRing = projectRingToLocalMeters(presentationOpenRing);
  const currentVisibleSpans = visibleCandidates.map((entry, index) => {
    const next = visibleCandidates[(index + 1) % visibleCandidates.length];
    return ringDistanceForward(officialCumulative, officialOpenRing, entry.originalIndex, next.originalIndex);
  });
  const medianVisibleSpan = medianValue(currentVisibleSpans);
  const recoveredByGap = new Map();

  const isForwardIndexBetween = (startIndex, endIndex, candidateIndex) => {
    if (startIndex < endIndex) return candidateIndex > startIndex && candidateIndex < endIndex;
    return candidateIndex > startIndex || candidateIndex < endIndex;
  };

  const buildGapKey = (startIndex, endIndex) => `${startIndex}:${endIndex}`;

  visibleCandidates.forEach((entry, index) => {
    const next = visibleCandidates[(index + 1) % visibleCandidates.length];
    const spanLength = ringDistanceForward(officialCumulative, officialOpenRing, entry.originalIndex, next.originalIndex);
    const hiddenCandidates = allVisibleCandidates.filter(
      (candidate) =>
        !initialIndexSet.has(candidate.displayRingIndex) &&
        isForwardIndexBetween(entry.displayRingIndex, next.displayRingIndex, candidate.displayRingIndex),
    );
    if (hiddenCandidates.length < 3) return;

    const startLocal = localPresentationRing[entry.displayRingIndex];
    const endLocal = localPresentationRing[next.displayRingIndex];
    if (!startLocal || !endLocal) return;

    const evaluatedHiddenCandidates = hiddenCandidates
      .map((candidate) => {
        const pointLocal = localPresentationRing[candidate.displayRingIndex];
        if (!pointLocal) return null;
        const distanceFromStart = ringDistanceForward(
          officialCumulative,
          officialOpenRing,
          entry.originalIndex,
          candidate.originalIndex,
        );
        const distanceToEnd = ringDistanceForward(
          officialCumulative,
          officialOpenRing,
          candidate.originalIndex,
          next.originalIndex,
        );
        const balance = Math.min(distanceFromStart, distanceToEnd) / Math.max(spanLength, 1);
        const deviationToChord = perpendicularDistanceMeters(pointLocal, startLocal, endLocal);
        const importance =
          (candidate.turnDeg || 0) * 12 +
          deviationToChord * 2.1 +
          balance * 280 +
          ((candidate.deviation || 0) * 0.5) +
          (candidate.structuralBreak ? 180 : 0) +
          (candidate.protectedPoint ? 90 : 0) +
          (candidate.mandatory ? 90 : 0);
        return {
          ...candidate,
          distanceFromStart,
          distanceToEnd,
          balance,
          deviationToChord,
          importance,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (b.importance !== a.importance) return b.importance - a.importance;
        return a.distanceFromStart - b.distanceFromStart;
      });

    if (!evaluatedHiddenCandidates.length) return;

    const maxDeviationToChord = Math.max(...evaluatedHiddenCandidates.map((candidate) => candidate.deviationToChord || 0), 0);
    const structuralHiddenCandidates = evaluatedHiddenCandidates.filter(
      (candidate) =>
        candidate.structuralBreak ||
        candidate.protectedPoint ||
        candidate.mandatory ||
        candidate.rdpDominant ||
        (candidate.turnDeg || 0) >= 62 ||
        (candidate.deviationToChord || 0) >= 100,
    );
    const hasLongGap =
      spanLength >= Math.max(medianVisibleSpan * 2.4, 900) ||
      (hiddenCandidates.length >= 5 && spanLength >= Math.max(medianVisibleSpan * 1.9, 700) && maxDeviationToChord >= 140);
    const requiresUniformRecovery =
      hasLongGap &&
      structuralHiddenCandidates.length >= 3 &&
      spanLength >= Math.max(medianVisibleSpan * 2.8, 1200);
    if (!requiresUniformRecovery) return;

    recoveredByGap.set(
      buildGapKey(entry.displayRingIndex, next.displayRingIndex),
      structuralHiddenCandidates
        .sort((a, b) => a.distanceFromStart - b.distanceFromStart)
        .map((candidate) => ({
          ...candidate,
          recoveredLongGap: true,
          displayReasons: Array.from(
            new Set([...(candidate.displayReasons || candidate.reasons || []), 'recuperacion_uniforme_de_tramo_estructural', 'lectura_humana_poligono']),
          ),
        })),
    );
  });

  if (!recoveredByGap.size) {
    return {
      visibleCandidates,
      report: {
        recoveredCount: 0,
        recoveredSpanCount: 0,
        recoveredOriginalIndices: [],
      },
    };
  }

  const nextVisibleCandidates = [];
  visibleCandidates.forEach((entry, index) => {
    const next = visibleCandidates[(index + 1) % visibleCandidates.length];
    nextVisibleCandidates.push(entry);
    const gapRecovered = recoveredByGap.get(buildGapKey(entry.displayRingIndex, next.displayRingIndex));
    if (gapRecovered?.length) nextVisibleCandidates.push(...gapRecovered);
  });

  return {
    visibleCandidates: nextVisibleCandidates,
    report: {
      recoveredCount: nextVisibleCandidates.length - visibleCandidates.length,
      recoveredSpanCount: recoveredByGap.size,
      recoveredOriginalIndices: nextVisibleCandidates
        .filter((candidate) => candidate.recoveredLongGap)
        .map((candidate) => candidate.originalIndex),
    },
  };
}

function buildLayoutData(predio, options = {}) {
  const previewMapRect = insetRect(SATELLITE_LAYOUT.mapArea, 10);
  const presentationRing = predio.displayRing?.length ? predio.displayRing : predio.ring;
  const presentationOpenRing = presentationRing.slice(0, -1);
  const hasDisplayVertices = Array.isArray(predio.displayVertices) && predio.displayVertices.length > 0;
  const displayVerticesByIndex = new Map((predio.displayVertices || []).map((entry) => [entry.originalIndex, entry]));
  const presentationBounds = getRingBounds(presentationOpenRing);
  const mapState = computeMapState(presentationRing, previewMapRect.width, previewMapRect.height, 18);
  const selection = selectVisibleReferencePoints(presentationRing, options);
  const candidates = selection.selectedCandidates;
  const reducedVisibleCandidates = reducePointsForVisualClarity(candidates, presentationRing, mapState, previewMapRect, options);
  const mapVisibleCandidate = (entry) => {
    const displayRingIndex = entry.index;
    const originalIndex =
      typeof entry.index === 'number'
        ? (predio.displayVertices || [])[entry.index]?.originalIndex
        : entry.originalIndex;
    const displayMeta = displayVerticesByIndex.get(originalIndex);
    return {
      ...entry,
      displayRingIndex,
      originalIndex,
      point: displayMeta?.point || entry.point,
      displayReason: displayMeta?.reason || displayMeta?.reasons?.[0] || null,
      displayReasons: displayMeta?.reasons || [],
    };
  };
  const mappedCandidates = candidates.map(mapVisibleCandidate);
  const mappedReducedVisibleCandidates = reducedVisibleCandidates.map(mapVisibleCandidate);
  const visibleRecovery = recoverLongVisibleSpanCandidates(
    mappedCandidates,
    mappedReducedVisibleCandidates,
    presentationRing,
    predio.ring,
  );
  const visibleCandidates = visibleRecovery.visibleCandidates;
  const referencePoints = visibleCandidates.map((entry) => ({
    point: entry.point,
    originalIndex: entry.originalIndex,
    reason: entry.displayReason,
    reasons: entry.displayReasons?.length ? entry.displayReasons : entry.reasons || [],
  }));
  const referenceRows = buildReferenceRows(referencePoints);
  const referenceSegments = buildReferenceSegments(predio.ring, referencePoints);
  const sideSummary = visibleCandidates.reduce((acc, entry) => {
    const side =
      entry.primarySide && entry.primarySide !== 'none'
        ? entry.primarySide
        : primaryCardinalSide(entry, presentationBounds);
    acc[side] = (acc[side] || 0) + 1;
    return acc;
  }, {});
  const structuralPoints = visibleCandidates.filter((entry) => entry.structuralBreak || entry.mandatory || entry.protectedPoint).length;
  const hardValidationErrors = [];
  const visualWarnings = [];
  const projectedPreviewRing = projectRingToViewport(presentationRing, mapState, previewMapRect.width, previewMapRect.height);

  if (!Array.isArray(presentationRing) || presentationRing.length < 4) {
    hardValidationErrors.push('anillo_invalido');
  }
  if (visibleCandidates.length < 3) {
    hardValidationErrors.push('menos_de_3_puntos_visibles_validos');
  }
  if (visibleCandidates.some((entry) => !hasValidCoordinatePoint(entry))) {
    hardValidationErrors.push('puntos_visibles_sin_coordenadas_validas');
  }
  if (
    !Number.isFinite(mapState?.scale) ||
    !Number.isFinite(mapState?.centerWorldX) ||
    !Number.isFinite(mapState?.centerWorldY)
  ) {
    hardValidationErrors.push('imposibilidad_de_proyectar_geometria');
  }
  if (
    !Array.isArray(projectedPreviewRing) ||
    projectedPreviewRing.length < 3 ||
    projectedPreviewRing.some((point) => !Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]))
  ) {
    hardValidationErrors.push('geometria_proyectada_invalida');
  }

  const hasAllCardinalSides =
    (sideSummary.west || 0) > 0 &&
    (sideSummary.east || 0) > 0 &&
    (sideSummary.north || 0) > 0 &&
    (sideSummary.south || 0) > 0;

  if (!hasAllCardinalSides) {
    visualWarnings.push('distribucion_lateral_incompleta');
  }
  if ((selection.report.unresolvedLongSegments || 0) > 0) {
    visualWarnings.push('tramos_largos_sin_representacion_completa');
  }
  if (visibleCandidates.length > 30) {
    visualWarnings.push('exceso_de_puntos_visibles');
  }

  const hardValidationStatus = hardValidationErrors.length === 0 ? 'OK' : 'ERROR';
  const visualQualityStatus = visualWarnings.length === 0 ? 'OK' : 'WARNING';
  const finalValidationStatus = hardValidationStatus === 'ERROR' ? 'ERROR' : visualQualityStatus;
  const finalVisibleReasons = visibleCandidates.map((entry, index) => ({
    point: `P${index + 1}`,
    displayRingIndex: typeof entry.displayRingIndex === 'number' ? entry.displayRingIndex : null,
    originalIndex: typeof entry.originalIndex === 'number' ? entry.originalIndex : null,
    reason: entry.displayReason || entry.reason || entry.reasons?.[0] || null,
    reasons: entry.displayReasons?.length ? entry.displayReasons : entry.reasons || [],
  }));
  const selectionReport = {
    ...selection.report,
    totalVisiblePoints: visibleCandidates.length,
    structuralPoints,
    eliminatedByProximity: reducedVisibleCandidates.removedByProximity || 0,
    recoveredLongVisibleSpans: visibleRecovery.report.recoveredSpanCount,
    recoveredLongVisibleVertices: visibleRecovery.report.recoveredCount,
    recoveredLongVisibleOriginalIndices: visibleRecovery.report.recoveredOriginalIndices,
    sideSummary,
    hardValidationStatus,
    visualQualityStatus,
    warnings: visualWarnings,
    hardValidationErrors,
    reasons: finalVisibleReasons,
    validation: finalValidationStatus,
  };

  console.log('CatastroX visible points report:', {
    codigoPredial: predio.codigoPredial,
    totalVerticesOriginales: predio.displayRingReport?.totalOriginalVertices ?? predio.ring.length - 1,
    totalVerticesDisplayRing: predio.displayRingReport?.totalDisplayVertices ?? presentationRing.length - 1,
    puntosEliminadosPorColinealidad: predio.displayRingReport?.removedByCollinearity ?? 0,
    puntosConservadosPorQuiebre: predio.displayRingReport?.keptByCornerBreak ?? 0,
    puntosConservadosPorCurva: predio.displayRingReport?.keptByCurve ?? 0,
    reduccionPorcentualDisplayRing: predio.displayRingReport?.reductionPercent ?? 0,
    totalVerticesReales: selectionReport.totalRealVertices,
    perimetroTotal: selectionReport.perimeterTotal,
    targetPointCount: selectionReport.targetPointCount,
    maxVisiblePoints: selectionReport.maxAllowed,
    totalCandidatosSignificativos: selectionReport.totalCandidatesDetected,
    puntosEstructuralesObligatorios: structuralPoints,
    puntosInicialesSeleccionados: selection.report.totalVisiblePoints,
    puntosAgregadosPorTramosLargos: selectionReport.addedByLongSegments,
    puntosAgregadosPorQuiebreSecundario: selectionReport.addedBySecondaryBreaks,
    puntosAgregadosPorTramoComplejo: selectionReport.addedByComplexSegments,
    puntosForzadosPorExtremos: selectionReport.forcedByExtremes,
    puntosForzadosPorCambioAngular: selectionReport.forcedByAngularChange,
    puntosSeleccionadosPorSimplificacion: selectionReport.selectedBySimplification,
    puntosEliminadosPorCercania: selectionReport.eliminatedByProximity,
    totalPuntosVisibles: selectionReport.totalVisiblePoints,
    tramoMasLargoAntes: selectionReport.longestSegmentBeforeRefinement,
    tramoMasLargoFinal: selectionReport.longestFinalSegment,
    tramosLargosSinRepresentacion: selectionReport.unresolvedLongSegments,
    distribucionLados: selectionReport.sideSummary,
    hardValidationStatus: selectionReport.hardValidationStatus,
    visualQualityStatus: selectionReport.visualQualityStatus,
    warnings: selectionReport.warnings,
    validacionFinal: selectionReport.validation,
    razones: selectionReport.reasons,
  });

  console.log('CatastroX silhouette refinement report:', {
    codigoPredial: predio.codigoPredial,
    totalPuntosAntesDelRefinamiento: selection.report.totalVisiblePoints,
    puntosAgregadosPorTramoLargo: selectionReport.addedByLongSegments + selectionReport.addedByComplexSegments,
    puntosAgregadosPorQuiebreSecundario: selectionReport.addedBySecondaryBreaks,
    tramoMasLargoAntes: selectionReport.longestSegmentBeforeRefinement,
    tramoMasLargoDespues: selectionReport.longestFinalSegment,
    totalFinalDePuntos: selectionReport.totalVisiblePoints,
    validacion: selectionReport.validation,
  });

  console.log('CatastroX secondary silhouette preservation report:', {
    codigoPredial: predio.codigoPredial,
    totalVerticesReales: selectionReport.totalRealVertices,
    puntosVisiblesAntesDeSecondarySilhouettePreservation: selection.report.totalVisiblePoints,
    candidatosSecundariosDetectados: selectionReport.secondarySilhouetteDetected,
    candidatosSecundariosAgregados: selectionReport.addedBySecondarySilhouette,
    candidatosSecundariosDescartados: selectionReport.secondarySilhouetteDiscarded,
    motivoDeDescarte: selectionReport.secondarySilhouetteDiscardedReasons,
    totalFinalDePuntosVisibles: selectionReport.totalVisiblePoints,
    puntosProtegidosConservados: selectionReport.secondarySilhouetteProtected,
    puntosProtegidosEliminados: 0,
    validacionFinal: selectionReport.validation,
  });
  console.table(selectionReport.secondarySilhouetteCandidates);

  if (selectionReport.hardValidationStatus !== 'OK') {
    throw new Error(`La selección cartográfica de puntos visibles falló la validación para ${predio.codigoPredial}.`);
  }

  return { mapState, referencePoints, referenceRows, referenceSegments, selectionReport };
}

function buildTechnicalLayoutSnapshot(predio, layoutData) {
  const { mapState, referencePoints, referenceSegments, selectionReport } = layoutData;
  const mapRect = insetRect(TECHNICAL_LAYOUT.mapArea, 14);
  const baseProjected = projectRingToViewport(
    predio.displayRing?.length ? predio.displayRing : predio.ring,
    mapState,
    mapRect.width,
    mapRect.height,
  );
  const transform = createFitTransform(baseProjected, mapRect, 30);
  const projected = applyFitTransform(baseProjected, transform);
  const baseProjectedRefs = referencePoints.map((entry) =>
    projectPointToViewport(entry.point || entry, mapState, mapRect.width, mapRect.height),
  );
  const projectedRefs = applyFitTransform(baseProjectedRefs, transform);
  const pointPlacements = buildVisiblePointPlacements(projectedRefs, mapRect, projected);
  const distancePlacements = buildDistanceLabelPlacements(
    projectedRefs,
    referenceSegments,
    mapRect,
    projected,
    pointPlacements.map((placement) => placement.rect),
  );
  const visibleDistancePlacements = distancePlacements
    .map((placement, segmentIndex) => ({ placement, segmentIndex }))
    .filter(({ placement }) => placement.status !== 'hidden');
  const labelOverlapPairs = [];

  for (let left = 0; left < visibleDistancePlacements.length; left += 1) {
    for (let right = left + 1; right < visibleDistancePlacements.length; right += 1) {
      if (
        rectsOverlap(
          visibleDistancePlacements[left].placement.rect,
          visibleDistancePlacements[right].placement.rect,
          2,
        )
      ) {
        labelOverlapPairs.push([
          `${referenceSegments[visibleDistancePlacements[left].segmentIndex].from}-${referenceSegments[visibleDistancePlacements[left].segmentIndex].to}`,
          `${referenceSegments[visibleDistancePlacements[right].segmentIndex].from}-${referenceSegments[visibleDistancePlacements[right].segmentIndex].to}`,
        ]);
      }
    }
  }

  const labelsInsidePolygon = visibleDistancePlacements.flatMap(({ placement, segmentIndex }) =>
    pointInPolygon([placement.labelCenterX, placement.labelCenterY], projected)
      ? [`${referenceSegments[segmentIndex].from}-${referenceSegments[segmentIndex].to}`]
      : [],
  );
  const labelsOverPoints = visibleDistancePlacements.flatMap(({ placement, segmentIndex }) =>
    pointPlacements.some((pointPlacement) => rectsOverlap(placement.rect, pointPlacement.rect, 2))
      ? [`${referenceSegments[segmentIndex].from}-${referenceSegments[segmentIndex].to}`]
      : [],
  );
  const northPoints = referencePoints
    .map((_, index) => `P${index + 1}`)
    .filter((label) => /^P(1[3-9]|20)$/.test(label));
  const guideSegments = visibleDistancePlacements.flatMap(({ placement, segmentIndex }) =>
    placement.guideLine
      ? [{
          segment: `${referenceSegments[segmentIndex].from}-${referenceSegments[segmentIndex].to}`,
          reason: placement.guideLine.reason,
        }]
      : [],
  );
  const p3p4Index = referenceSegments.findIndex((segment) => `${segment.from}-${segment.to}` === 'P3-P4');
  const p3p4Placement = p3p4Index >= 0 ? distancePlacements[p3p4Index] : null;

  return {
    mapRect,
    projected,
    projectedRefs,
    pointPlacements,
    distancePlacements,
    regressionMetrics: {
      totalRequested: distancePlacements.auditReport.totalRequested,
      totalPlaced: distancePlacements.auditReport.totalPlaced,
      totalHidden: distancePlacements.auditReport.totalHidden,
      guideLinesSuggested: distancePlacements.auditReport.guideLinesSuggested,
      guideLinesRendered: guideSegments.length,
      guideLineReasons: distancePlacements.auditReport.guideLineReasons,
      totalVisiblePoints: selectionReport.totalVisiblePoints,
      recoveredLongVisibleVertices: selectionReport.recoveredLongVisibleVertices || 0,
      recoveredLongVisibleSpans: selectionReport.recoveredLongVisibleSpans || 0,
      northPoints,
      p3p4Recovered: Boolean(
        p3p4Placement &&
        p3p4Placement.status === 'placed' &&
        p3p4Placement.candidateStrategy === 'edge-angular-fallback',
      ),
      labelOverlapCount: labelOverlapPairs.length,
      labelsInsidePolygonCount: labelsInsidePolygon.length,
      labelsOverPointCount: labelsOverPoints.length,
      collisionsResolved: distancePlacements.auditReport.collisionsResolved,
    },
  };
}

async function buildSatellitePageCanvas(predio, layoutData, pageLabel = '1 de 3') {
  const { canvas, context } = createPageCanvas();
  const validator = createLayoutValidator(SATELLITE_LAYOUT);
  const { mapState, referencePoints } = layoutData;
  const mapRect = insetRect(SATELLITE_LAYOUT.mapArea, 10);

  validator.add('header', SATELLITE_LAYOUT.header, 'header');
  validator.add('mapArea', SATELLITE_LAYOUT.mapArea, 'mapArea');
  validator.add('rightPanel', SATELLITE_LAYOUT.rightPanel, 'rightPanel');
  validator.add('bottomPanel', SATELLITE_LAYOUT.bottomPanel, 'bottomPanel');
  validator.add('footer', SATELLITE_LAYOUT.footer, 'footer');
  validator.validateNoOverlap(['mapArea', 'rightPanel', 'bottomPanel', 'footer']);

  drawHeader(context, predio, pageLabel, 'PLANO PREDIAL CATASTROX', SATELLITE_LAYOUT);
  await drawHybridMap(context, mapRect, mapState);

  const projected = projectRingToViewport(predio.displayRing?.length ? predio.displayRing : predio.ring, mapState, mapRect.width, mapRect.height).map(([x, y]) => [
    mapRect.x + x,
    mapRect.y + y,
  ]);
  drawPolygonOverlay(context, projected);

  const projectedRefs = buildVisiblePointProjection(referencePoints, mapState, mapRect);
  const pointPlacements = buildVisiblePointPlacements(projectedRefs, mapRect, projected);
  drawVisiblePoints(context, projectedRefs, pointPlacements, {
    radius: 6.1,
    lineWidth: 1.15,
    fontSize: 6.2,
    fillStyle: 'rgba(255,255,255,0.88)',
    strokeStyle: '#0a2e73',
    textColor: '#0a2e73',
    guideColor: 'rgba(154,167,188,0.78)',
    guideLineWidth: 0.65,
  });
  drawCompassRose(context, mapRect.x + 54, mapRect.y + 54, false);
  const satelliteScaleAnchor = chooseScaleBarAnchor(mapRect, projected, projectedRefs, pointPlacements, false);
  drawScaleBar(context, satelliteScaleAnchor.x, satelliteScaleAnchor.y, 800);

  const infoRect = { x: SATELLITE_LAYOUT.rightPanel.x, y: SATELLITE_LAYOUT.rightPanel.y, width: SATELLITE_LAYOUT.rightPanel.width, height: SATELLITE_LAYOUT.rightPanel.height };

  [infoRect].forEach((rect, index) => validator.add(`right-${index}`, rect, 'rightPanel'));

  drawPanel(context, infoRect, 'INFORMACIÓN DEL PREDIO');
  drawKeyValueRows(context, infoRect.x + 14, infoRect.y + 42, infoRect.width - 28, [
    { label: 'Código predial actual', value: predio.codigoPredial },
    { label: 'Código predial anterior', value: predio.codigoAnterior },
    { label: 'Municipio', value: predio.municipio },
    { label: 'Departamento', value: predio.departamento },
    { label: 'Área total', value: `${formatNumber(predio.areaHa)} ha` },
    { label: 'Área total m²', value: `${formatNumber(predio.areaM2)} m²` },
    { label: 'Perímetro', value: `${formatNumber(predio.perimetroM)} m` },
    { label: 'Estado predial', value: predio.estadoPredial },
  ], { labelSize: 9.1, valueSize: 11.5, labelGap: 12, rowGap: 31, lineHeight: 12.5 });

  drawPanel(context, SATELLITE_LAYOUT.bottomPanel, 'LECTURA VISUAL DEL PREDIO');
  drawWrappedText(
    context,
    'Esta página prioriza la interpretación visual del predio sobre la imagen satelital real. Las coordenadas y longitudes de referencia se presentan de forma consolidada en la tabla ejecutiva de las páginas siguientes.',
    SATELLITE_LAYOUT.bottomPanel.x + 14,
    SATELLITE_LAYOUT.bottomPanel.y + 34,
    SATELLITE_LAYOUT.bottomPanel.width - 28,
    11,
    '#243446',
    400,
    8.8,
  );

  drawWrappedText(
    context,
    'CatastroX realiza análisis técnico sobre información geográfica y catastral pública disponible. Este documento no reemplaza certificados oficiales del IGAC, gestor catastral, oficina de registro ni autoridad competente.',
    SATELLITE_LAYOUT.footer.x,
    SATELLITE_LAYOUT.footer.y + 10,
    SATELLITE_LAYOUT.footer.width,
    10,
    '#334155',
    400,
    8,
  );

  return canvas;
}

async function buildTechnicalPagesCanvases(predio, layoutData, technicalPageLabel = '2 de 3') {
  const { mapState, referencePoints, referenceRows, referenceSegments } = layoutData;
  const expandedMapArea = { x: 24, y: 108, width: 744, height: 450 };
  const { canvas, context } = createPageCanvas();
  const validator = createLayoutValidator({ ...TECHNICAL_LAYOUT, mapArea: expandedMapArea });
  const mapRect = insetRect(expandedMapArea, 16);

  validator.add('header', TECHNICAL_LAYOUT.header, 'header');
  validator.add('mapArea', expandedMapArea, 'mapArea');
  validator.add('footer', TECHNICAL_LAYOUT.footer, 'footer');
  validator.validateNoOverlap(['mapArea', 'footer']);

  drawHeader(context, predio, technicalPageLabel, 'PLANO PREDIAL CATASTROX', TECHNICAL_LAYOUT);

  const baseProjected = projectRingToViewport(predio.displayRing?.length ? predio.displayRing : predio.ring, mapState, mapRect.width, mapRect.height);
  const transform = createFitTransform(baseProjected, mapRect, 30);
  const projected = applyFitTransform(baseProjected, transform);
  const baseProjectedRefs = referencePoints.map((entry) => projectPointToViewport(entry.point || entry, mapState, mapRect.width, mapRect.height));
  const projectedRefs = applyFitTransform(baseProjectedRefs, transform);

  context.fillStyle = '#ffffff';
  context.fillRect(expandedMapArea.x, expandedMapArea.y, expandedMapArea.width, expandedMapArea.height);
  context.strokeStyle = '#d6dfef';
  context.strokeRect(expandedMapArea.x, expandedMapArea.y, expandedMapArea.width, expandedMapArea.height);
  context.strokeStyle = '#c9d6ea';
  context.strokeRect(mapRect.x, mapRect.y, mapRect.width, mapRect.height);
  setFont(context, 10.5, 700);
  context.fillStyle = '#0a2e73';
  context.fillText('PLANO TÉCNICO • GEOMETRÍA DEL PREDIO', TECHNICAL_LAYOUT.header.x + 16, TECHNICAL_LAYOUT.header.y + 76);

  drawPolygonOverlay(context, projected, { stroke: '#1170cf', fill: null, lineWidth: 2 });
  const pointPlacements = buildVisiblePointPlacements(projectedRefs, mapRect, projected);
  const compassCenter = { x: mapRect.x + 52, y: mapRect.y + 54 };
  const preliminaryScaleAnchor = chooseScaleBarAnchor(mapRect, projected, projectedRefs, pointPlacements, true);
  const footerRect = {
    x: TECHNICAL_LAYOUT.footer.x + 8,
    y: TECHNICAL_LAYOUT.footer.y - 2,
    width: TECHNICAL_LAYOUT.footer.width - 16,
    height: 20,
  };
  const technicalDimensionResult = buildTechnicalSegmentDimensionPlacements(
    context,
    projectedRefs,
    referenceSegments,
    projected,
    pointPlacements,
    mapRect,
    [
      getCompassRoseRect(compassCenter.x, compassCenter.y),
      getScaleBarRect(preliminaryScaleAnchor.x, preliminaryScaleAnchor.y, true),
      footerRect,
    ],
  );
  drawTechnicalSegmentDimensions(context, technicalDimensionResult.placements);
  drawVisiblePoints(context, projectedRefs, pointPlacements);
  drawCompassRose(context, compassCenter.x, compassCenter.y, true);
  const technicalScaleAnchor = chooseScaleBarAnchor(mapRect, projected, projectedRefs, [...technicalDimensionResult.placements, ...pointPlacements], true);
  drawScaleBar(context, technicalScaleAnchor.x, technicalScaleAnchor.y, 800, { compact: true });

  console.log('CatastroX visible point quality report', {
    codigoPredial: predio.codigoPredial,
    puntosConEtiquetaDesplazada: pointPlacements.displacedCount || 0,
    puntosConLineaGuia: pointPlacements.guideCount || 0,
    etiquetasOcultadasPorColision: pointPlacements.hiddenCount || 0,
    cotasDibujadas: technicalDimensionResult.placements.length,
    cotasOmitidasPorColision: technicalDimensionResult.omittedCount,
  });
  drawWrappedText(
    context,
    'CatastroX realiza análisis técnico sobre información geográfica y catastral pública disponible. Este documento no reemplaza certificados oficiales del IGAC, gestor catastral, oficina de registro ni autoridad competente.',
    TECHNICAL_LAYOUT.footer.x + 16,
    TECHNICAL_LAYOUT.footer.y - 16,
    TECHNICAL_LAYOUT.footer.width - 32,
    10,
    '#334155',
    400,
    8,
  );

  const tableCanvases = buildExecutiveTablePagesCanvases(predio, referenceRows, referenceSegments);
  return [canvas, ...tableCanvases];
}

async function canvasToJpegBytes(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) throw new Error('No fue posible serializar una página PDF.');
  return new Uint8Array(await blob.arrayBuffer());
}

export async function buildDiagnosticPdfBytes(source) {
  if (typeof document === 'undefined') {
    throw new Error('La generación de PDF requiere un entorno con canvas y fuentes disponibles.');
  }
  await ensurePdfFontsLoaded();
  const predio = normalizePredioForDeliverables(source);
  const pageCanvas = buildDiagnosticPageCanvas(predio);
  const pageImages = [
    {
      width: pageCanvas.width,
      height: pageCanvas.height,
      bytes: await canvasToJpegBytes(pageCanvas),
    },
  ];
  return buildImageOnlyPdf(pageImages);
}

export async function buildPlanPdfBytes(source) {
  if (typeof document === 'undefined') {
    throw new Error('La generación de PDF requiere un entorno con canvas, fuentes y mapa disponibles.');
  }
  await ensurePdfFontsLoaded();
  const predio = normalizePredioForDeliverables(source);
  const attemptBuild = async (layoutOptions = {}) => {
    const layoutData = buildLayoutData(predio, resolvePlanLayoutOptions(predio, layoutOptions));
    const availableRows = Math.max(1, Math.floor((TABLE_LAYOUT.mapArea.height - 54) / 20));
    const totalTablePages = Math.ceil(layoutData.referenceRows.length / availableRows);
    const totalPages = 2 + totalTablePages;
    const satelliteCanvas = await buildSatellitePageCanvas(predio, layoutData, `1 de ${totalPages}`);
    const technicalCanvases = await buildTechnicalPagesCanvases(predio, layoutData, `2 de ${totalPages}`);
    const pageImages = [];

    pageImages.push({
      width: satelliteCanvas.width,
      height: satelliteCanvas.height,
      bytes: await canvasToJpegBytes(satelliteCanvas),
    });

    for (const pageCanvas of technicalCanvases) {
      pageImages.push({
        width: pageCanvas.width,
        height: pageCanvas.height,
        bytes: await canvasToJpegBytes(pageCanvas),
      });
    }

    return buildImageOnlyPdf(pageImages);
  };

  try {
    return await attemptBuild();
  } catch (error) {
    console.warn('CatastroX PDF plano reintentando con composición segura', error);
    return attemptBuild({ maxVisiblePoints: 24, minVisiblePoints: 12, preferDenseVisiblePoints: false });
  }
}

export function buildKmlText(source) {
  const predio = normalizePredioForDeliverables(source);
  const coords = predio.ring.map(([lng, lat]) => `${lng},${lat},0`).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${predio.codigoPredial}</name>
    <Placemark>
      <name>${predio.codigoPredial}</name>
      <description>Geometría predial CatastroX.</description>
      <Style>
        <LineStyle><color>ffef8b00</color><width>3</width></LineStyle>
        <PolyStyle><color>66ffd9b3</color></PolyStyle>
      </Style>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${coords}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
  </Document>
</kml>`;
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  const now = dosDateTime();

  entries.forEach((entry) => {
    const nameBytes = textEncoder.encode(entry.name);
    const dataBytes = entry.data instanceof Uint8Array ? entry.data : textEncoder.encode(entry.data);
    const crc = crc32(dataBytes);

    const localHeader = concatUint8Arrays([
      uint32(0x04034b50),
      uint16(20),
      uint16(0),
      uint16(0),
      uint16(now.dosTime),
      uint16(now.dosDate),
      uint32(crc),
      uint32(dataBytes.length),
      uint32(dataBytes.length),
      uint16(nameBytes.length),
      uint16(0),
      nameBytes,
      dataBytes,
    ]);
    localChunks.push(localHeader);

    const centralHeader = concatUint8Arrays([
      uint32(0x02014b50),
      uint16(20),
      uint16(20),
      uint16(0),
      uint16(0),
      uint16(now.dosTime),
      uint16(now.dosDate),
      uint32(crc),
      uint32(dataBytes.length),
      uint32(dataBytes.length),
      uint16(nameBytes.length),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(0),
      uint32(offset),
      nameBytes,
    ]);
    centralChunks.push(centralHeader);
    offset += localHeader.length;
  });

  const centralDirectory = concatUint8Arrays(centralChunks);
  const localData = concatUint8Arrays(localChunks);
  const end = concatUint8Arrays([
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(entries.length),
    uint16(entries.length),
    uint32(centralDirectory.length),
    uint32(localData.length),
    uint16(0),
  ]);

  return concatUint8Arrays([localData, centralDirectory, end]);
}

function writeShapefileParts(source) {
  const predio = normalizePredioForDeliverables(source);
  const ring = [...predio.ring];
  if (!ring.length) {
    throw new Error('El predio no tiene geometría disponible para generar archivos GIS.');
  }

  const xs = ring.map((pt) => pt[0]);
  const ys = ring.map((pt) => pt[1]);
  const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const numPoints = ring.length;
  const recordContentBytes = 4 + 32 + 4 + 4 + 4 + 16 * numPoints;
  const fileLengthWords = (100 + 8 + recordContentBytes) / 2;

  const shp = new ArrayBuffer(100 + 8 + recordContentBytes);
  const shpView = new DataView(shp);
  shpView.setInt32(0, 9994, false);
  shpView.setInt32(24, fileLengthWords, false);
  shpView.setInt32(28, 1000, true);
  shpView.setInt32(32, 5, true);
  bbox.forEach((value, index) => shpView.setFloat64(36 + index * 8, value, true));
  shpView.setInt32(100, 1, false);
  shpView.setInt32(104, recordContentBytes / 2, false);
  shpView.setInt32(108, 5, true);
  bbox.forEach((value, index) => shpView.setFloat64(112 + index * 8, value, true));
  shpView.setInt32(144, 1, true);
  shpView.setInt32(148, numPoints, true);
  shpView.setInt32(152, 0, true);
  let pointOffset = 156;
  ring.forEach(([lng, lat]) => {
    shpView.setFloat64(pointOffset, lng, true);
    shpView.setFloat64(pointOffset + 8, lat, true);
    pointOffset += 16;
  });

  const shx = new ArrayBuffer(108);
  const shxView = new DataView(shx);
  shxView.setInt32(0, 9994, false);
  shxView.setInt32(24, 54, false);
  shxView.setInt32(28, 1000, true);
  shxView.setInt32(32, 5, true);
  bbox.forEach((value, index) => shxView.setFloat64(36 + index * 8, value, true));
  shxView.setInt32(100, 50, false);
  shxView.setInt32(104, recordContentBytes / 2, false);

  const dbfFields = [
    ['id', 'N', 8, 0, String(predio.id || 0)],
    ['codigo', 'C', 40, 0, predio.codigoPredial],
    ['municipio', 'C', 32, 0, predio.municipio],
    ['depto', 'C', 32, 0, predio.departamento],
    ['area_ha', 'N', 12, 2, Number(predio.areaHa || 0).toFixed(2)],
  ];
  const headerLength = 32 + dbfFields.length * 32 + 1;
  const recordLength = 1 + dbfFields.reduce((sum, [, , size]) => sum + size, 0);
  const dbf = new Uint8Array(headerLength + recordLength + 1);
  const dbfView = new DataView(dbf.buffer);
  const today = new Date();
  dbfView.setUint8(0, 3);
  dbfView.setUint8(1, today.getFullYear() - 1900);
  dbfView.setUint8(2, today.getMonth() + 1);
  dbfView.setUint8(3, today.getDate());
  dbfView.setUint32(4, 1, true);
  dbfView.setUint16(8, headerLength, true);
  dbfView.setUint16(10, recordLength, true);
  let fieldOffset = 32;
  dbfFields.forEach(([name, type, size, decimals]) => {
    textEncoder.encode(name.slice(0, 11)).forEach((byte, index) => {
      dbf[fieldOffset + index] = byte;
    });
    dbf[fieldOffset + 11] = type.charCodeAt(0);
    dbf[fieldOffset + 16] = size;
    dbf[fieldOffset + 17] = decimals;
    fieldOffset += 32;
  });
  dbf[headerLength - 1] = 0x0d;
  let recordOffset = headerLength + 1;
  dbf[headerLength] = 0x20;
  dbfFields.forEach(([, type, size, decimals, value]) => {
    let text = String(value);
    if (type === 'N') {
      text = decimals ? Number(value).toFixed(decimals) : String(Math.round(Number(value)));
    }
    const bytes = textEncoder.encode(text.slice(0, size).padStart(type === 'N' ? size : 0, ' ').padEnd(size, ' '));
    dbf.set(bytes, recordOffset);
    recordOffset += size;
  });
  dbf[dbf.length - 1] = 0x1a;

  const prj = textEncoder.encode(
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]',
  );

  return {
    shp: new Uint8Array(shp),
    shx: new Uint8Array(shx),
    dbf,
    prj,
  };
}

export function buildKmzBytes(source) {
  const predio = normalizePredioForDeliverables(source);
  const kmlText = buildKmlText(predio);
  return buildZip([{ name: `${fileSafeCode(predio)}.kml`, data: textEncoder.encode(kmlText) }]);
}

export function buildShpZipBytes(source) {
  const predio = normalizePredioForDeliverables(source);
  const stem = fileSafeCode(predio);
  const parts = writeShapefileParts(predio);
  return buildZip([
    { name: `${stem}.shp`, data: parts.shp },
    { name: `${stem}.shx`, data: parts.shx },
    { name: `${stem}.dbf`, data: parts.dbf },
    { name: `${stem}.prj`, data: parts.prj },
  ]);
}

function downloadBytes(bytes, filename, mimeType) {
  const blob = new Blob([bytes], { type: mimeType });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}

export async function downloadDiagnosticPdf(source) {
  const predio = normalizePredioForDeliverables(source);
  try {
    downloadBytes(await buildDiagnosticPdfBytes(predio), `${fileSafeCode(predio)}.pdf`, 'application/pdf');
  } catch (error) {
    console.error('CatastroX PDF diagnóstico', error);
    window.alert('No fue posible generar el diagnóstico PDF en este momento. Intente nuevamente.');
  }
}

export async function downloadPlanPdf(source) {
  const predio = normalizePredioForDeliverables(source);
  try {
    downloadBytes(await buildPlanPdfBytes(predio), `${fileSafeCode(predio)}_plano.pdf`, 'application/pdf');
  } catch (error) {
    console.error('CatastroX PDF plano', error);
    window.alert('No fue posible generar el plano PDF en este momento. Intente nuevamente.');
  }
}

export function downloadKml(source) {
  const predio = normalizePredioForDeliverables(source);
  downloadBytes(textEncoder.encode(buildKmlText(predio)), `${fileSafeCode(predio)}.kml`, 'application/vnd.google-earth.kml+xml');
}

export function downloadKmz(source) {
  const predio = normalizePredioForDeliverables(source);
  downloadBytes(buildKmzBytes(predio), `${fileSafeCode(predio)}.kmz`, 'application/vnd.google-earth.kmz');
}

export function downloadShpZip(source) {
  const predio = normalizePredioForDeliverables(source);
  downloadBytes(buildShpZipBytes(predio), `${fileSafeCode(predio)}.zip`, 'application/zip');
}

export async function buildDeliverableDebugSummary(source) {
  const predio = normalizePredioForDeliverables(source);
  const layoutData = buildLayoutData(predio, resolvePlanLayoutOptions(predio));
  let planPdfBytes = 0;
  let diagnosticPdfBytes = 0;
  try {
    if (typeof document !== 'undefined') {
      planPdfBytes = (await buildPlanPdfBytes(predio)).length;
      diagnosticPdfBytes = (await buildDiagnosticPdfBytes(predio)).length;
    }
  } catch {
    planPdfBytes = 0;
    diagnosticPdfBytes = 0;
  }

  return {
    code: fileSafeCode(predio),
    municipality: predio.municipio,
    department: predio.departamento,
    areaHa: predio.areaHa,
    ringPoints: predio.ring.length,
    referencePoints: layoutData.referencePoints.length,
    pdfBytes: diagnosticPdfBytes,
    planPdfBytes,
    kmlBytes: textEncoder.encode(buildKmlText(predio)).length,
    kmzBytes: buildKmzBytes(predio).length,
    shpZipBytes: buildShpZipBytes(predio).length,
    fontFamily: activePdfFontStack,
  };
}

export function buildCatastroXRegressionSnapshot(source) {
  const predio = normalizePredioForDeliverables(source);
  const layoutData = buildLayoutData(predio);
  const technicalSnapshot = buildTechnicalLayoutSnapshot(predio, layoutData);
  return {
    code: fileSafeCode(predio),
    predio,
    layoutData,
    regressionMetrics: technicalSnapshot.regressionMetrics,
  };
}
