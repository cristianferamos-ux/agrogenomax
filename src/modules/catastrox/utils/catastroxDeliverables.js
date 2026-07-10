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
import { getVeredaDisplay } from './veredaDisplay.js';
import {
  getDestinoEconomicoDisplay,
  getTipoConstruccionDisplay,
  getUsoDisplay,
} from '../semantic/catastroxSemanticCatalog.js';
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

function escapeXml(value) {
  return cleanText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatNumber(value, decimals = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 'Sin dato';
  return parsed.toLocaleString('es-CO', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatNumberOrUnavailable(value, { decimals = 2, suffix = '', emptyLabel = 'No disponible' } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return emptyLabel;
  return `${formatNumber(parsed, decimals)}${suffix ? ` ${suffix}` : ''}`;
}

function fileSafeCode(predio) {
  return cleanText(predio.codigoPredial || predio.codigo || predio.id || 'predio').replace(/[^\w.-]+/g, '_');
}

function predioName(predio) {
  return cleanText(predio.nombrePredio || predio.nombre_predio || predio.nombrePredioClean) || `Predio ${fileSafeCode(predio)}`;
}

function resolveVeredaNombre(predio, source) {
  return cleanText(
    predio.veredaNombre ||
      predio.vereda_nombre ||
      predio.vereda ||
      predio.nombreVereda ||
      predio.nombre_vereda ||
      source?.veredaNombre ||
      source?.vereda_nombre ||
      source?.vereda,
  );
}

function resolveFirstValue(...values) {
  return values.find((value) => cleanText(value));
}

function semanticText(result, fallback = 'No disponible') {
  return cleanText(result?.value, fallback);
}

function resolveDestinoEconomico(predio) {
  return getDestinoEconomicoDisplay(resolveFirstValue(
    predio.destinoEconomicoNombre,
    predio.destino_economico_nombre,
    predio.codDestino,
    predio.cod_destino,
    predio.destinoEconomico,
    predio.destino_economico,
    predio.DESTINO_ECONOMICO,
  ));
}

function resolveUso(predio, camelName, snakeName, rawName) {
  return getUsoDisplay(resolveFirstValue(
    predio[camelName],
    predio[snakeName],
    predio[rawName],
  ));
}

function resolveTipoConstruccionResumen(predio) {
  const summary = resolveFirstValue(predio.tiposConstruccionResumen, predio.tipos_construccion_resumen);
  if (summary) return cleanText(summary, 'No registra');

  const direct = getTipoConstruccionDisplay(resolveFirstValue(
    predio.tipoConstruccion,
    predio.tipo_construccion,
    predio.TIPO_CONSTRUCCION,
  ));
  return semanticText(direct, 'No registra');
}

function toSentenceCase(text) {
  const clean = cleanText(text);
  if (!clean) return '';
  const lower = clean.toLocaleLowerCase('es-CO');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// Correcciones tipograficas de topónimos conocidos de la cobertura Caqueta (catastrox_clean),
// cuya fuente exporta nombres en mayusculas sin tilde. Ambito: presentacion en PDF unicamente,
// nunca se escriben de vuelta en el objeto predio ni se usan en KML/KMZ.
const KNOWN_TOPONYM_UPPERCASE_ACCENTS = {
  CAQUETA: 'CAQUETÁ',
  'CARTAGENA DEL CHAIRA': 'CARTAGENA DEL CHAIRÁ',
  'LA MONTANITA': 'LA MONTAÑITA',
};

const KNOWN_TOPONYM_TITLE_CASE = {
  CAQUETA: 'Caquetá',
  'CARTAGENA DEL CHAIRA': 'Cartagena del Chairá',
  'LA MONTANITA': 'La Montañita',
  'PUERTO RICO': 'Puerto Rico',
  FLORENCIA: 'Florencia',
};

function withKnownToponymAccents(text) {
  const clean = cleanText(text);
  if (!clean) return clean;
  return KNOWN_TOPONYM_UPPERCASE_ACCENTS[clean.toUpperCase()] || clean;
}

function toDisplayToponymTitleCase(text) {
  const clean = cleanText(text);
  if (!clean) return '';
  return KNOWN_TOPONYM_TITLE_CASE[clean.toUpperCase()] || toSentenceCase(clean);
}

const EMPTY_USO_DISPLAY_VALUES = new Set(['', 'INFORMACIÓN NO DISPONIBLE', 'NO DISPONIBLE', 'NO REGISTRA']);

function isUsableUsoValue(value) {
  const text = cleanText(value);
  return Boolean(text) && !EMPTY_USO_DISPLAY_VALUES.has(text.toUpperCase());
}

function collectUsosConstructivos(predio) {
  const seen = new Set();
  const usos = [];
  [predio.uso1Nombre, predio.uso2Nombre, predio.uso3Nombre].forEach((value) => {
    if (!isUsableUsoValue(value)) return;
    const key = cleanText(value).toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    usos.push(cleanText(value));
  });
  return usos;
}

// Algunos usos constructivos llegan de la fuente separados por guiones
// ("ESTABLOS - PESEBRERAS - CABALLERIZAS"); se muestran como una enumeración natural.
function humanizeDashSeparatedList(text) {
  const clean = cleanText(text);
  if (!clean) return clean;
  const parts = clean.split(/\s*-\s*/).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return clean;
  const lowered = parts.map((part) => part.toLowerCase());
  const head = lowered.slice(0, -1);
  return `${head.join(', ')} y ${lowered[lowered.length - 1]}`;
}

function buildUsosConstructivosList(predio) {
  const usos = collectUsosConstructivos(predio);
  if (!usos.length) return ['Información no disponible'];
  return usos.map((value) => toSentenceCase(humanizeDashSeparatedList(value)));
}

function simplifyUsoLabelForSummary(value) {
  const clean = cleanText(value);
  if (!clean) return '';
  const humanized = humanizeDashSeparatedList(clean);
  const stripped = humanized.replace(/\s+(HASTA|DESDE|DE|CON|A)\s+\d+.*$/i, '').trim();
  return toSentenceCase(stripped || humanized);
}

function buildUsosConstructivosResumen(predio) {
  const usos = collectUsosConstructivos(predio);
  if (!usos.length) return 'Información no disponible';

  const seen = new Set();
  const simplified = [];
  usos.forEach((value) => {
    const label = simplifyUsoLabelForSummary(value);
    const key = label.toUpperCase();
    if (!label || seen.has(key)) return;
    seen.add(key);
    simplified.push(label);
  });

  if (!simplified.length) return 'Información no disponible';
  if (simplified.length === 1) return simplified[0];
  const last = simplified[simplified.length - 1];
  const head = simplified.slice(0, -1);
  return `${head.join(', ')} y ${last.charAt(0).toLowerCase()}${last.slice(1)}`;
}

function areEquivalentTexts(a, b) {
  const normalize = (value) => cleanText(value).toUpperCase().replace(/\s+/g, ' ');
  const left = normalize(a);
  return left !== '' && left === normalize(b);
}

const TITLE_CASE_LOWERCASE_CONNECTORS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'el', 'en']);

// Titulo propio generico para nombres de predio: capitaliza cada palabra (conectores en
// minuscula salvo al inicio) y aplica la convencion "N 2" -> "N.° 2". No restaura tildes
// faltantes en nombres propios arbitrarios (requeriria un diccionario de nombres, fuera de
// alcance); las tildes de topónimos conocidos (municipio/departamento) se resuelven aparte.
function toProperNameTitleCase(text) {
  const clean = cleanText(text);
  if (!clean) return '';
  let sawWord = false;
  const titled = clean
    .toLocaleLowerCase('es-CO')
    .split(/(\s+)/)
    .map((chunk) => {
      if (!chunk.trim()) return chunk;
      const isFirst = !sawWord;
      sawWord = true;
      if (!isFirst && TITLE_CASE_LOWERCASE_CONNECTORS.has(chunk)) return chunk;
      return chunk.charAt(0).toUpperCase() + chunk.slice(1);
    })
    .join('');
  return titled.replace(/\bN\.?\s+(\d+)/gi, 'N.° $1');
}

const KNOWN_FUENTE_DISPLAY = {
  IGAC_PUBLICO_ABRIL_2026: 'IGAC - Base Catastral Pública, abril de 2026',
};

function formatFuenteDisplay(value) {
  const clean = cleanText(value);
  if (!clean) return 'No registrado';
  const known = KNOWN_FUENTE_DISPLAY[clean.toUpperCase()];
  if (known) return known;
  return clean.split('_').map((part) => toSentenceCase(part)).join(' ');
}

const SPANISH_MONTH_NAMES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function formatFechaProcesoDisplay(value) {
  const clean = cleanText(value);
  if (!clean) return 'No registrado';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
  if (!match) return clean;
  const [, year, month, day] = match;
  const monthName = SPANISH_MONTH_NAMES[Number(month) - 1];
  if (!monthName) return clean;
  return `${Number(day)} de ${monthName} de ${year}`;
}

const LEGACY_EMPTY_FIELD_LABELS = new Set([
  '', 'NO DISPONIBLE', 'NO APLICA / NO REGISTRA', 'NO REGISTRA', 'NO REGISTRADO', 'NO APLICA',
]);

function resolveFieldOrNotRegistered(value) {
  const clean = cleanText(value);
  return LEGACY_EMPTY_FIELD_LABELS.has(clean.toUpperCase()) ? 'No registrado' : clean;
}

// Barrio/Manzana no aplican en predios rurales; en predios urbanos, si faltan, es un dato
// que deberia existir pero no esta en la fuente.
function resolveUrbanFieldOrNotApplicable(value, zona) {
  const clean = cleanText(value);
  if (clean && !LEGACY_EMPTY_FIELD_LABELS.has(clean.toUpperCase())) return clean;
  return /rural/i.test(cleanText(zona)) ? 'No aplica' : 'No registrado';
}

// Devuelve una linea por tipo de construccion ("Convencional: 1"), nunca unidas en una sola linea.
function formatTiposConstruccionDisplayLines(value) {
  const clean = cleanText(value);
  if (!clean || clean.toUpperCase() === 'NO REGISTRA') return ['No registrado'];
  const parts = clean.split(';').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return ['No registrado'];
  return parts.map((part) => {
    const [label, count] = part.split(':').map((piece) => piece?.trim());
    const displayLabel = toSentenceCase(label);
    return count ? `${displayLabel}: ${count}` : displayLabel;
  });
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

function normalizePolygonParts(geometry) {
  const geo = geometryToGeoJson(geometry);
  if (!geo) return [];
  const rawPolygons =
    geo.type === 'Polygon'
      ? [geo.coordinates || []]
      : geo.type === 'MultiPolygon'
        ? geo.coordinates || []
        : [];

  return rawPolygons
    .map((polygon, partIndex) => {
      const outerRing = normalizeRing(polygon?.[0] || []);
      if (outerRing.length < 4) return null;
      const innerRings = (polygon || [])
        .slice(1)
        .map((ring) => normalizeRing(ring || []))
        .filter((ring) => ring.length >= 4);
      const displayGeometry = buildDisplayRingFromOriginalRing(outerRing);
      const bounds = getRingBounds(outerRing);
      return {
        partIndex,
        outerRing,
        innerRings,
        bounds,
        vertexCount: outerRing.length - 1,
        displayRing: displayGeometry.displayRing,
        displayVertices: displayGeometry.displayVertices,
        displayRingReport: displayGeometry.report,
      };
    })
    .filter(Boolean);
}

function mergePartBounds(parts) {
  const rings = parts.flatMap((part) => part.outerRing.slice(0, -1));
  if (!rings.length) return null;
  return getRingBounds(rings);
}

function buildMapRingFromParts(parts) {
  const points = parts.flatMap((part) => part.outerRing.slice(0, -1));
  return normalizeRing(points);
}

function partPredio(predio, part, totalParts = 1) {
  return {
    ...predio,
    ring: part.outerRing,
    displayRing: part.displayRing,
    displayVertices: part.displayVertices,
    displayRingReport: part.displayRingReport,
    geometryParts: [part],
    partIndex: part.partIndex,
    // Solo se numera cuando el MultiPolygon tiene mas de una parte valida.
    partLabel: totalParts > 1 ? `Polígono ${part.partIndex + 1} de ${totalParts}` : '',
  };
}

function normalizePredioForDeliverables(source) {
  const predio = source?.predio || source || {};
  const geometry =
    predio.geometry ||
    predio.polygonGeoJson?.geometry ||
    predio.polygonGeoJson ||
    predio.geojson?.geometry ||
    predio.geojson ||
    null;
  const geometryParts = normalizePolygonParts(geometry);
  const ring = geometryParts[0]?.outerRing || normalizeRing(firstRing(geometry));
  const displayGeometry = geometryParts[0]
    ? {
        displayRing: geometryParts[0].displayRing,
        displayVertices: geometryParts[0].displayVertices,
        report: geometryParts[0].displayRingReport,
      }
    : buildDisplayRingFromOriginalRing(ring);
  const mapRing = geometryParts.length ? buildMapRingFromParts(geometryParts) : ring;
  const geometryBounds = geometryParts.length ? mergePartBounds(geometryParts) : getRingBounds(ring);
  const destinoEconomico = resolveDestinoEconomico(predio);
  const uso1 = resolveUso(predio, 'uso1Nombre', 'uso_1_nombre', 'USO_1');
  const uso2 = resolveUso(predio, 'uso2Nombre', 'uso_2_nombre', 'USO_2');
  const uso3 = resolveUso(predio, 'uso3Nombre', 'uso_3_nombre', 'USO_3');

  return {
    id: predio.id,
    codigoPredial: cleanText(
      predio.codigoPredial ||
        predio.codigo ||
        predio.codigo_predial ||
        predio.codigo_catastral ||
        predio.id,
      'predio',
    ),
    codigoAnterior: cleanText(predio.codigoAnterior || predio.codigo_anterior || predio.codigoAnteriorReal || 'No disponible'),
    municipio: cleanText(predio.municipio || source?.municipio, 'Sin dato'),
    departamento: cleanText(predio.departamento || source?.departamento, 'Sin dato'),
    areaHa: Number(predio.areaHa ?? predio.area_terreno_ha ?? 0),
    areaM2: Number(predio.areaM2 ?? predio.area_terreno_m2 ?? 0),
    perimetroM: Number(predio.perimetroM ?? predio.perimetro_m ?? 0),
    estadoPredial: cleanText(predio.estadoPredial, 'Predio identificado en la base catastral consultada.'),
    tipoZona: cleanText(predio.tipoZona || predio.zona, 'Rural'),
    zona: cleanText(predio.zona || predio.tipoZona, 'Rural'),
    veredaDisplay: predio.veredaDisplay || getVeredaDisplay(resolveVeredaNombre(predio, source)),
    nombrePredio: predioName(predio),
    direccionReal: cleanText(predio.direccionReal || predio.direccion_real, 'No disponible'),
    barrioNombre: cleanText(predio.barrioNombre || predio.barrio_nombre, ''),
    manzanaCodigo: cleanText(predio.manzanaCodigo || predio.manzana_codigo, ''),
    sectorCodigo: cleanText(predio.sectorCodigo || predio.sector_codigo, ''),
    destinoEconomicoNombre: semanticText(destinoEconomico),
    destinoEconomicoSemantic: destinoEconomico,
    uso1Nombre: semanticText(uso1),
    uso1Semantic: uso1,
    uso2Nombre: semanticText(uso2, ''),
    uso2Semantic: uso2,
    uso3Nombre: semanticText(uso3, ''),
    uso3Semantic: uso3,
    numeroConstrucciones: Number(predio.numeroConstrucciones ?? predio.numero_construcciones ?? 0),
    areaConstruidaM2: Number(predio.areaConstruidaM2 ?? predio.area_construida_m2 ?? 0),
    tiposConstruccionResumen: resolveTipoConstruccionResumen(predio),
    fuente: cleanText(predio.fuente, 'No disponible'),
    fechaProceso: cleanText(predio.fechaProceso || predio.fecha_proceso, 'No disponible'),
    queryPoint: predio.queryPoint || source?.queryPoint || null,
    geometry,
    geometryParts,
    geometryBounds,
    mapRing,
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

  const pageBox = {
    x: zone.x + zone.width - 76,
    y: zone.y + 8,
    width: 62,
    height: 34,
  };
  const titleX = zone.x + 360;
  const titleMaxWidth = pageBox.x - titleX - 12;
  let titleFontSize = 18;
  setFont(context, titleFontSize, 700);
  while (context.measureText(title).width > titleMaxWidth && titleFontSize > 12) {
    titleFontSize -= 0.5;
    setFont(context, titleFontSize, 700);
  }
  context.fillStyle = '#0a2e73';
  context.fillText(title, titleX, zone.y + 24);
  setFont(context, 8, 700);
  context.fillStyle = '#334155';
  context.fillText('CÓDIGO PREDIAL', zone.x + 500, zone.y + 42);
  const codigoMaxWidth = pageBox.x - (zone.x + 500) - 12;
  const codigoSize = fitSingleLineFontSize(context, predio.codigoPredial, codigoMaxWidth, { maxSize: 11, minSize: 7 });
  setFont(context, codigoSize, 700);
  context.fillStyle = '#0f172a';
  context.fillText(predio.codigoPredial, zone.x + 500, zone.y + 58);

  context.fillStyle = '#0a2e73';
  context.fillRect(pageBox.x, pageBox.y, pageBox.width, pageBox.height);
  context.fillStyle = '#ffffff';
  setFont(context, 7, 700);
  context.fillText('PÁGINA', pageBox.x + 7, zone.y + 21);
  setFont(context, 8.6, 700);
  context.fillText(pageLabel, pageBox.x + 7, zone.y + 34);
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

function drawPolygonPartOverlay(context, outerPoints, innerPointRings = [], options = {}) {
  if (!outerPoints.length) return;
  const { stroke = '#ffea00', fill = 'rgba(0, 116, 136, 0.24)', lineWidth = 2 } = options;
  context.beginPath();
  context.moveTo(outerPoints[0][0], outerPoints[0][1]);
  for (const [x, y] of outerPoints.slice(1)) {
    context.lineTo(x, y);
  }
  context.closePath();
  innerPointRings.forEach((ring) => {
    if (!ring.length) return;
    context.moveTo(ring[0][0], ring[0][1]);
    for (const [x, y] of ring.slice(1)) {
      context.lineTo(x, y);
    }
    context.closePath();
  });
  if (fill) {
    context.fillStyle = fill;
    context.fill('evenodd');
  }
  context.lineWidth = lineWidth;
  context.strokeStyle = stroke;
  context.stroke();
}

function projectRingForMap(ring, mapState, mapRect) {
  return projectRingToViewport(ring, mapState, mapRect.width, mapRect.height).map(([x, y]) => [
    mapRect.x + x,
    mapRect.y + y,
  ]);
}

function projectDisplayParts(predio, mapState, mapRect) {
  const parts = predio.geometryParts?.length
    ? predio.geometryParts
    : [{
        outerRing: predio.ring,
        innerRings: [],
        displayRing: predio.displayRing?.length ? predio.displayRing : predio.ring,
      }];
  return parts.map((part) => ({
    part,
    outer: projectRingForMap(part.displayRing?.length ? part.displayRing : part.outerRing, mapState, mapRect),
    inners: (part.innerRings || []).map((ring) => projectRingForMap(ring, mapState, mapRect)),
  }));
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

function fitSingleLineFontSize(context, text, maxWidth, { maxSize = 11.5, minSize = 8, weight = 700, step = 0.5 } = {}) {
  let size = maxSize;
  while (size > minSize) {
    setFont(context, size, weight);
    if (context.measureText(text).width <= maxWidth) return size;
    size -= step;
  }
  return minSize;
}

function splitTextToFitWidth(context, text, maxWidth, size, weight = 700) {
  setFont(context, size, weight);
  const clean = cleanText(text);
  if (context.measureText(clean).width <= maxWidth || clean.length < 2) return [clean];

  let splitAt = Math.ceil(clean.length / 2);
  while (splitAt > 1 && context.measureText(clean.slice(0, splitAt)).width > maxWidth) {
    splitAt -= 1;
  }
  const first = clean.slice(0, splitAt);
  const second = clean.slice(splitAt);
  return second ? [first, second] : [first];
}

// Renderiza campos de valor unico (codigos catastrales largos) con ancho maximo fijo:
// reduce el tamano de fuente localmente antes de partir la linea, reserva una altura fija
// por campo (deterministica) y nunca toca el tamano de fuente del resto de la pagina.
function drawCodeFieldRows(context, startX, startY, width, rows, options = {}) {
  const {
    labelSize = 9.1,
    maxValueSize = 11.5,
    minValueSize = 8,
    labelGap = 12,
    fieldHeight = 38,
    lineHeight = 12.5,
    rightMargin = 16,
  } = options;
  let cursorY = startY;
  const fitWidth = Math.max(1, width - rightMargin);

  rows.forEach(({ label, value }) => {
    context.fillStyle = '#52637d';
    setFont(context, labelSize, 700);
    context.fillText(label, startX, cursorY);

    const text = cleanText(value, 'No disponible');
    const size = fitSingleLineFontSize(context, text, fitWidth, { maxSize: maxValueSize, minSize: minValueSize });
    const lines = splitTextToFitWidth(context, text, fitWidth, size);

    context.fillStyle = '#0f172a';
    setFont(context, size, 700);
    lines.forEach((line, index) => {
      context.fillText(line, startX, cursorY + labelGap + index * lineHeight);
    });

    cursorY += fieldHeight;
  });

  return cursorY;
}

// Retícula tipográfica compartida por la ficha técnica consolidada del PDF Plus.
const PDF_LAYOUT_GRID = {
  pageMargin: 40,
  panelPaddingX: 26,
  panelPaddingY: 24,
  labelValueGap: 15,
  fieldGap: 26,
  sectionGap: 22,
  minBottomPadding: 18,
};

function drawFieldLabel(context, x, y, label, labelSize = 9) {
  context.fillStyle = '#52637d';
  setFont(context, labelSize, 700);
  context.fillText(label, x, y);
}

// Dibuja una grilla de campos etiqueta/valor (1 o 2 columnas, con soporte para filas de
// ancho completo) y devuelve la coordenada Y siguiente disponible tras el ultimo campo.
function drawFieldGrid(context, rect, fields, options = {}) {
  const {
    labelSize = 9,
    valueSize = 11,
    labelValueGap = PDF_LAYOUT_GRID.labelValueGap,
    fieldGap = PDF_LAYOUT_GRID.fieldGap,
    valueLineHeight = 13,
    columns = 2,
    columnGap = 24,
  } = options;

  const colWidth = columns === 2 ? (rect.width - columnGap) / 2 : rect.width;
  let cursorY = rect.y;
  let col = 0;
  let pendingRowHeight = 0;

  const flushRow = () => {
    cursorY += pendingRowHeight + fieldGap;
    col = 0;
    pendingRowHeight = 0;
  };

  fields.forEach((field) => {
    if (field.fullWidth && col !== 0) flushRow();
    const x = rect.x + (col === 1 ? colWidth + columnGap : 0);
    const fieldWidth = field.fullWidth || columns === 1 ? rect.width : colWidth;

    drawFieldLabel(context, x, cursorY, field.label, labelSize);
    const valueResult = drawWrappedText(context, field.value, x, cursorY + labelValueGap, fieldWidth, valueLineHeight, '#0f172a', 700, valueSize);
    const rowHeight = labelValueGap + Math.max(valueLineHeight, valueResult.height);
    pendingRowHeight = Math.max(pendingRowHeight, rowHeight);

    if (field.fullWidth || columns === 1 || col === 1) {
      flushRow();
    } else {
      col = 1;
    }
  });

  if (col !== 0) flushRow();
  return cursorY;
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

function todayDisplayDate() {
  const now = new Date();
  return new Intl.DateTimeFormat('es-CO', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(now).replace(/\//g, '-');
}

function drawLegalFooter(context, rect) {
  drawWrappedText(
    context,
    'CatastroX realiza análisis técnico con información geográfica y catastral pública disponible. No reemplaza certificados oficiales del IGAC, gestor catastral, oficina de registro ni autoridad competente.',
    rect.x,
    rect.y,
    rect.width,
    10,
    '#334155',
    400,
    8,
  );
}

function drawCommercialMetric(context, x, y, width, label, value, accent = '#00aeea') {
  context.fillStyle = '#ffffff';
  context.fillRect(x, y, width, 58);
  context.strokeStyle = '#d6dfef';
  context.strokeRect(x, y, width, 58);
  context.fillStyle = accent;
  context.fillRect(x, y, 5, 58);
  setFont(context, 8.7, 700);
  context.fillStyle = '#52637d';
  context.fillText(label.toUpperCase(), x + 14, y + 19);
  drawWrappedText(context, value, x + 14, y + 40, width - 24, 13, '#0f172a', 700, 12);
}

function buildPlusSummaryPageCanvas(predio, layoutData, pageLabel = '1 de 6') {
  const { canvas, context } = createPageCanvas();
  const mapRect = { x: 420, y: 136, width: 332, height: 296 };
  const mapState = computeMapState(predio.mapRing?.length ? predio.mapRing : predio.ring, mapRect.width, mapRect.height, 18);
  const constructionLabel = `${formatNumberOrUnavailable(predio.numeroConstrucciones, { decimals: 0 })} / ${formatNumberOrUnavailable(predio.areaConstruidaM2, { suffix: 'm²' })}`;

  drawHeader(context, predio, pageLabel, 'DIAGNÓSTICO PREDIAL CATASTROX', SATELLITE_LAYOUT);

  const displayNombrePredio = toProperNameTitleCase(predio.nombrePredio);
  const sameNameAndAddress = areEquivalentTexts(predio.nombrePredio, predio.direccionReal);
  const summaryHeadline = sameNameAndAddress
    ? `Predio ${displayNombrePredio}. Información identificada por CatastroX a partir de fuentes geográficas y catastrales públicas disponibles.`
    : `Predio ${displayNombrePredio}. Dirección: ${predio.direccionReal}. Información identificada por CatastroX a partir de fuentes geográficas y catastrales públicas disponibles.`;

  context.fillStyle = '#07152d';
  context.fillRect(24, 128, 360, 86);
  context.fillStyle = '#00aeea';
  context.fillRect(24, 128, 6, 86);
  drawWrappedText(
    context,
    summaryHeadline,
    44,
    150,
    316,
    13,
    '#ffffff',
    700,
    11.5,
  );

  drawCommercialMetric(context, 24, 238, 172, 'Municipio', withKnownToponymAccents(predio.municipio));
  drawCommercialMetric(context, 212, 238, 172, 'Departamento', withKnownToponymAccents(predio.departamento));
  drawCommercialMetric(context, 24, 312, 172, 'Zona', toSentenceCase(predio.tipoZona), '#00aeea');
  drawCommercialMetric(context, 212, 312, 172, 'Área total', `${formatNumber(predio.areaHa)} ha`, '#8bcf2b');
  drawCommercialMetric(context, 24, 386, 172, 'Perímetro', `${formatNumber(predio.perimetroM)} m`, '#8bcf2b');
  drawCommercialMetric(context, 212, 386, 172, 'Construcciones', constructionLabel, '#8bcf2b');
  drawCommercialMetric(context, 24, 460, 172, 'Destinación catastral', toSentenceCase(predio.destinoEconomicoNombre) || 'Información no disponible', '#00aeea');
  drawCommercialMetric(context, 212, 460, 172, 'Usos constructivos', buildUsosConstructivosResumen(predio), '#00aeea');

  context.fillStyle = '#f8fbff';
  context.fillRect(mapRect.x - 10, mapRect.y - 10, mapRect.width + 20, mapRect.height + 20);
  context.strokeStyle = '#c9d6ea';
  context.strokeRect(mapRect.x - 10, mapRect.y - 10, mapRect.width + 20, mapRect.height + 20);

  return drawHybridMap(context, mapRect, mapState).then(() => {
    const projectedParts = projectDisplayParts(predio, mapState, mapRect);
    projectedParts.forEach(({ outer, inners }) => {
      drawPolygonPartOverlay(context, outer, inners, { stroke: '#ffea00', fill: 'rgba(0, 174, 234, 0.18)', lineWidth: 2.4 });
    });
    drawCompassRose(context, mapRect.x + 46, mapRect.y + 48, false);
    const scalePolygon = projectedParts.flatMap((entry) => entry.outer);
    const summaryScaleAnchor = chooseScaleBarAnchor(mapRect, scalePolygon, [], [], true);
    drawScaleBar(context, summaryScaleAnchor.x, summaryScaleAnchor.y, 800, { compact: true });

    drawPanel(context, { x: 420, y: 456, width: 332, height: 68 }, 'PAQUETE PLUS');
    drawWrappedText(
      context,
      'Incluye PDF, KML y KMZ para visualizar el polígono del predio y abrirlo en Google Earth.',
      436,
      494,
      300,
      13,
      '#243446',
      400,
      10.5,
    );

    drawLegalFooter(context, { x: 24, y: 580, width: 744, height: 14 });
    return canvas;
  });
}

function buildDiagnosticPageCanvas(predio) {
  const { canvas, context } = createPageCanvas();
  const veredaDisplay = predio.veredaDisplay || getVeredaDisplay();
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
    [veredaDisplay.label, veredaDisplay.value],
    ...(veredaDisplay.isCadastralCode ? [[veredaDisplay.secondaryLabel, veredaDisplay.secondaryValue]] : []),
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

  if (veredaDisplay.isCadastralCode) {
    drawWrappedText(context, veredaDisplay.note, 44, 704, 520, 11, '#52637d', 400, 9);
  }

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

function buildContextoPredioText(predio) {
  const zona = toSentenceCase(predio.tipoZona) || 'Rural';
  const municipio = toDisplayToponymTitleCase(predio.municipio);
  const departamento = toDisplayToponymTitleCase(predio.departamento);
  const destinacion = toSentenceCase(predio.destinoEconomicoNombre);
  const usosResumen = buildUsosConstructivosResumen(predio);

  const destinacionText = isUsableUsoValue(destinacion)
    ? `una destinación catastral de tipo ${destinacion}`
    : 'una destinación catastral no registrada';
  const usosText = usosResumen && usosResumen !== 'Información no disponible'
    ? ` y construcciones asociadas con usos de ${usosResumen.toLowerCase()}`
    : '';

  return `Predio ${zona.toLowerCase()} denominado ${toProperNameTitleCase(predio.nombrePredio)}, ubicado en el municipio de ${municipio}, ${departamento}. La fuente catastral registra ${destinacionText}${usosText}.`;
}

function estimateFichaTecnicaPageCount(predio) {
  const usosCount = buildUsosConstructivosList(predio).length;
  const tiposLineCount = formatTiposConstruccionDisplayLines(predio.tiposConstruccionResumen).length;
  return usosCount > 3 || tiposLineCount > 3 ? 2 : 1;
}

function drawIdentificacionPanel(context, rect, predio, options = {}) {
  const { labelValueGap = 13, fieldGap = 24, fieldHeight = 34, columns = 2 } = options;
  drawPanel(context, rect, 'IDENTIFICACIÓN Y LOCALIZACIÓN');

  const veredaDisplay = predio.veredaDisplay || getVeredaDisplay();
  const veredaFields = veredaDisplay.isCadastralCode
    ? [
        { label: veredaDisplay.label, value: 'No registrada' },
        { label: 'Código catastral de vereda', value: veredaDisplay.secondaryValue },
      ]
    : [{ label: veredaDisplay.label, value: veredaDisplay.value }];

  const regularFields = [
    { label: 'Nombre del predio', value: toProperNameTitleCase(predio.nombrePredio), fullWidth: true },
    { label: 'Municipio', value: toDisplayToponymTitleCase(predio.municipio) },
    { label: 'Departamento', value: toDisplayToponymTitleCase(predio.departamento) },
    { label: 'Zona', value: toSentenceCase(predio.tipoZona) },
    ...veredaFields,
    { label: 'Barrio', value: resolveUrbanFieldOrNotApplicable(predio.barrioNombre, predio.tipoZona) },
    { label: 'Manzana', value: resolveUrbanFieldOrNotApplicable(predio.manzanaCodigo, predio.tipoZona) },
  ];

  const contentX = rect.x + PDF_LAYOUT_GRID.panelPaddingX;
  const contentWidth = rect.width - PDF_LAYOUT_GRID.panelPaddingX * 2;
  const startY = rect.y + 46;

  const afterRegularY = drawFieldGrid(context, { x: contentX, y: startY, width: contentWidth }, regularFields, {
    labelSize: 9, valueSize: 10.8, labelValueGap, fieldGap, valueLineHeight: 12, columns, columnGap: 20,
  });

  const codeRows = [
    { label: 'Código predial', value: predio.codigoPredial },
    { label: 'Código anterior', value: resolveFieldOrNotRegistered(predio.codigoAnterior) },
  ];
  return drawCodeFieldRows(context, contentX, afterRegularY + PDF_LAYOUT_GRID.sectionGap - fieldGap, contentWidth, codeRows, {
    labelSize: 9, maxValueSize: 10.8, minValueSize: 7.5, labelGap: labelValueGap, fieldHeight, lineHeight: 11.5, rightMargin: 16,
  });
}

function drawCaracteristicasFisicasPanel(context, rect, predio, options = {}) {
  const { labelValueGap = 13, fieldGap = 24 } = options;
  drawPanel(context, rect, 'CARACTERÍSTICAS FÍSICAS');
  const fields = [
    { label: 'Área en hectáreas', value: `${formatNumber(predio.areaHa)} ha` },
    { label: 'Área en metros cuadrados', value: `${formatNumber(predio.areaM2)} m²` },
    { label: 'Perímetro', value: `${formatNumber(predio.perimetroM)} m` },
    { label: 'Número de construcciones', value: formatNumberOrUnavailable(predio.numeroConstrucciones, { decimals: 0 }) },
    { label: 'Área construida', value: formatNumberOrUnavailable(predio.areaConstruidaM2, { suffix: 'm²' }) },
  ];
  return drawFieldGrid(
    context,
    { x: rect.x + PDF_LAYOUT_GRID.panelPaddingX, y: rect.y + 46, width: rect.width - PDF_LAYOUT_GRID.panelPaddingX * 2 },
    fields,
    { labelSize: 9, valueSize: 11.5, labelValueGap, fieldGap, valueLineHeight: 13, columns: 2, columnGap: 20 },
  );
}

function drawClasificacionPanel(context, rect, predio, options = {}) {
  const { usoLineHeight = 14, sectionGap = PDF_LAYOUT_GRID.sectionGap } = options;
  drawPanel(context, rect, 'CLASIFICACIÓN Y CONSTRUCCIONES');

  const paddingX = PDF_LAYOUT_GRID.panelPaddingX;
  const colWidth = (rect.width - paddingX * 2 - 24) / 2;
  const leftX = rect.x + paddingX;
  const rightX = leftX + colWidth + 24;
  const labelY = rect.y + 42;
  const labelValueGap = 15;

  drawFieldLabel(context, leftX, labelY, 'DESTINACIÓN CATASTRAL');
  const destinacionResult = drawWrappedText(context, toSentenceCase(predio.destinoEconomicoNombre) || 'Información no disponible', leftX, labelY + labelValueGap, colWidth, 16, '#0f172a', 700, 13);

  drawFieldLabel(context, rightX, labelY, 'USOS CONSTRUCTIVOS');
  let usoCursorY = labelY + labelValueGap;
  buildUsosConstructivosList(predio).forEach((uso) => {
    const result = drawWrappedText(context, uso, rightX, usoCursorY, colWidth, usoLineHeight, '#0f172a', 700, 11.5);
    usoCursorY += Math.max(usoLineHeight, result.height) + 11;
  });

  const destinacionBottom = labelY + labelValueGap + Math.max(16, destinacionResult.height);
  const tiposY = Math.max(destinacionBottom, usoCursorY) + sectionGap;
  drawFieldLabel(context, leftX, tiposY, 'TIPOS DE CONSTRUCCIÓN');
  const tiposLines = formatTiposConstruccionDisplayLines(predio.tiposConstruccionResumen);
  let tiposCursorY = tiposY + labelValueGap;
  tiposLines.forEach((line) => {
    const result = drawWrappedText(context, line, leftX, tiposCursorY, rect.width - paddingX * 2, 15, '#0f172a', 700, 11.5);
    tiposCursorY += Math.max(15, result.height) + 3;
  });

  return tiposCursorY;
}

function drawFuentePanel(context, rect, predio) {
  drawPanel(context, rect, 'FUENTE');
  drawWrappedText(
    context,
    `${formatFuenteDisplay(predio.fuente)}. Fecha de procesamiento: ${formatFechaProcesoDisplay(predio.fechaProceso)}.`,
    rect.x + PDF_LAYOUT_GRID.panelPaddingX,
    rect.y + 42,
    rect.width - PDF_LAYOUT_GRID.panelPaddingX * 2,
    15,
    '#243446',
    400,
    11,
  );
}

function buildFichaTecnicaSinglePageCanvas(predio, pageLabel) {
  const { canvas, context } = createPageCanvas();
  drawHeader(context, predio, pageLabel, 'FICHA TÉCNICA Y CATASTRAL', TABLE_LAYOUT);

  drawIdentificacionPanel(context, { x: 24, y: 126, width: 360, height: 356 }, predio, { labelValueGap: 13, fieldGap: 24, fieldHeight: 34 });
  drawCaracteristicasFisicasPanel(context, { x: 408, y: 126, width: 360, height: 168 }, predio, { labelValueGap: 13, fieldGap: 24 });
  drawClasificacionPanel(context, { x: 408, y: 310, width: 360, height: 190 }, predio, { usoLineHeight: 13, sectionGap: 16 });
  drawFuentePanel(context, { x: 24, y: 514, width: 744, height: 56 }, predio);

  drawLegalFooter(context, { x: 24, y: 580, width: 744, height: 14 });
  return canvas;
}

function buildFichaTecnicaSplitPageCanvases(predio, pageLabelA, pageLabelB) {
  const { canvas: canvasA, context: contextA } = createPageCanvas();
  drawHeader(contextA, predio, pageLabelA, 'FICHA TÉCNICA Y CATASTRAL', TABLE_LAYOUT);
  drawIdentificacionPanel(contextA, { x: 24, y: 126, width: 360, height: 430 }, predio, { labelValueGap: 15, fieldGap: 28, fieldHeight: 40, columns: 1 });
  drawCaracteristicasFisicasPanel(contextA, { x: 408, y: 126, width: 360, height: 430 }, predio, { labelValueGap: 15, fieldGap: 40 });
  drawLegalFooter(contextA, { x: 24, y: 580, width: 744, height: 14 });

  const { canvas: canvasB, context: contextB } = createPageCanvas();
  drawHeader(contextB, predio, pageLabelB, 'FICHA TÉCNICA Y CATASTRAL (CONTINUACIÓN)', TABLE_LAYOUT);
  drawClasificacionPanel(contextB, { x: 24, y: 126, width: 744, height: 260 }, predio, { usoLineHeight: 16, sectionGap: 24 });
  drawFuentePanel(contextB, { x: 24, y: 404, width: 744, height: 70 }, predio);
  drawLegalFooter(contextB, { x: 24, y: 580, width: 744, height: 14 });

  return [canvasA, canvasB];
}

function buildFichaTecnicaCanvases(predio, pageLabels) {
  if (pageLabels.length === 1) {
    return [buildFichaTecnicaSinglePageCanvas(predio, pageLabels[0])];
  }
  return buildFichaTecnicaSplitPageCanvases(predio, pageLabels[0], pageLabels[1]);
}

function buildUsoAlcancePageCanvas(predio, pageLabel) {
  const { canvas, context } = createPageCanvas();
  drawHeader(context, predio, pageLabel, 'USO, ALCANCE Y ADVERTENCIAS', TABLE_LAYOUT);

  drawPanel(context, { x: 24, y: 126, width: 744, height: 110 }, 'ARCHIVOS ENTREGADOS');
  drawBullets(context, [
    'PDF: resumen comercial, ficha técnica y plano predial con puntos y distancias.',
    'KML: polígono del predio para Google Earth y aplicaciones compatibles.',
    'KMZ: versión comprimida del KML, lista para compartir.',
  ], 48, 172, 700, '#00aeea');

  drawPanel(context, { x: 24, y: 250, width: 360, height: 236 }, 'CÓMO UTILIZARLOS');
  drawBullets(context, [
    'Abra el archivo KML o KMZ en Google Earth o una aplicación compatible.',
    'Verifique visualmente la ubicación del polígono sobre el mapa.',
    'Utilícelo como apoyo de consulta y planeación técnica o comercial.',
  ], 48, 296, 332, '#8bcf2b');

  drawPanel(context, { x: 408, y: 250, width: 360, height: 236 }, 'ALCANCE Y VALIDACIÓN OFICIAL');
  drawBullets(context, [
    'No reemplaza certificados oficiales del IGAC, gestor catastral ni oficina de registro.',
    'No reemplaza levantamientos topográficos ni actos de deslinde o amojonamiento.',
    'Los usos normativos del suelo están sujetos al POT, PBOT o EOT municipal vigente.',
    'Decisiones jurídicas, registrales o de linderos requieren validación de autoridad competente.',
  ], 424, 296, 332, '#00aeea');

  drawLegalFooter(context, { x: 24, y: 580, width: 744, height: 14 });
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
    `${isContinuation ? 'TABLA DE VÉRTICES REPRESENTATIVOS Y LONGITUDES (CONTINUACIÓN)' : 'TABLA DE VÉRTICES REPRESENTATIVOS Y LONGITUDES'}${predio.partLabel ? ` - ${predio.partLabel.toUpperCase()}` : ''}`,
    headers,
    columnXs,
    visibleRows,
  );

  drawWrappedText(
    context,
    'La tabla ejecutiva compila en una sola vista los puntos visibles del plano, sus coordenadas y la distancia entre tramos consecutivos. La geometría completa del predio permanece disponible en los archivos KML y KMZ descargables.',
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

function buildExecutiveTablePagesCanvases(predio, referenceRows, referenceSegments, startPage = 3, totalDocumentPages = null) {
  const unifiedRows = buildUnifiedTableRows(referenceRows, referenceSegments);
  const availableRows = Math.max(1, Math.floor((TABLE_LAYOUT.mapArea.height - 54) / 20));
  const totalTablePages = Math.ceil(unifiedRows.length / availableRows);
  const totalPages = totalDocumentPages || 2 + totalTablePages;
  const canvases = [];
  let nextIndex = 0;

  for (let tablePage = 0; tablePage < totalTablePages; tablePage += 1) {
    const pageLabel = `${startPage + tablePage} de ${totalPages}`;
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
    `Plano visual generado el ${todayDisplayDate()}. La imagen satelital permite ubicar el predio identificado; los puntos y longitudes se conservan como anexo técnico al final del reporte.`,
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

async function buildTechnicalPagesCanvases(predio, layoutData, technicalPageLabel = '2 de 3', tableStartPage = 3, totalDocumentPages = null) {
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
  context.fillText(
    `PLANO TÉCNICO • GEOMETRÍA DEL PREDIO${predio.partLabel ? ` • ${predio.partLabel.toUpperCase()}` : ''}`,
    TECHNICAL_LAYOUT.header.x + 16,
    TECHNICAL_LAYOUT.header.y + 76,
  );

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

  const tableCanvases = buildExecutiveTablePagesCanvases(predio, referenceRows, referenceSegments, tableStartPage, totalDocumentPages);
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
    const parts = predio.geometryParts?.length ? predio.geometryParts : [{ outerRing: predio.ring, innerRings: [] }];
    const partEntries = parts.map((part) => {
      const nextPredio = partPredio(predio, part, parts.length);
      const layoutData = buildLayoutData(nextPredio, resolvePlanLayoutOptions(nextPredio, layoutOptions));
      const availableRows = Math.max(1, Math.floor((TABLE_LAYOUT.mapArea.height - 54) / 20));
      const tablePages = Math.max(1, Math.ceil(layoutData.referenceRows.length / availableRows));
      return { predio: nextPredio, layoutData, tablePages };
    });
    const summaryLayoutData = {
      ...partEntries[0].layoutData,
      mapState: computeMapState(predio.mapRing?.length ? predio.mapRing : predio.ring, SATELLITE_LAYOUT.mapArea.width, SATELLITE_LAYOUT.mapArea.height, 18),
    };
    const totalTechnicalPages = partEntries.reduce((sum, entry) => sum + 1 + entry.tablePages, 0);
    const fichaTecnicaPageCount = estimateFichaTecnicaPageCount(predio);
    // 1 (resumen) + ficha tecnica (1 o 2, dinamico) + 1 (uso/alcance) + paginas tecnicas.
    const totalPages = 1 + fichaTecnicaPageCount + 1 + totalTechnicalPages;

    const summaryCanvas = await buildPlusSummaryPageCanvas(predio, summaryLayoutData, `1 de ${totalPages}`);

    const fichaTecnicaPageLabels = Array.from(
      { length: fichaTecnicaPageCount },
      (_, index) => `${2 + index} de ${totalPages}`,
    );
    const fichaTecnicaCanvases = buildFichaTecnicaCanvases(predio, fichaTecnicaPageLabels);

    const usoAlcancePageNumber = 2 + fichaTecnicaPageCount;
    const usoAlcanceCanvas = buildUsoAlcancePageCanvas(predio, `${usoAlcancePageNumber} de ${totalPages}`);

    const technicalCanvases = [];
    let pageCursor = usoAlcancePageNumber + 1;
    for (const entry of partEntries) {
      const canvases = await buildTechnicalPagesCanvases(
        entry.predio,
        entry.layoutData,
        `${pageCursor} de ${totalPages}`,
        pageCursor + 1,
        totalPages,
      );
      technicalCanvases.push(...canvases);
      pageCursor += canvases.length;
    }
    const pageImages = [];

    pageImages.push({
      width: summaryCanvas.width,
      height: summaryCanvas.height,
      bytes: await canvasToJpegBytes(summaryCanvas),
    });

    for (const pageCanvas of [...fichaTecnicaCanvases, usoAlcanceCanvas]) {
      pageImages.push({
        width: pageCanvas.width,
        height: pageCanvas.height,
        bytes: await canvasToJpegBytes(pageCanvas),
      });
    }

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

function kmlLinearRing(ring) {
  const coords = ring.map(([lng, lat]) => `${lng},${lat},0`).join(' ');
  return `<LinearRing>
            <coordinates>${coords}</coordinates>
          </LinearRing>`;
}

function kmlPolygon(part) {
  const inners = (part.innerRings || [])
    .map((ring) => `
        <innerBoundaryIs>
          ${kmlLinearRing(ring)}
        </innerBoundaryIs>`)
    .join('');
  return `<Polygon>
        <outerBoundaryIs>
          ${kmlLinearRing(part.outerRing)}
        </outerBoundaryIs>${inners}
      </Polygon>`;
}

function isWgs84Ring(ring) {
  return ring.length >= 4 && ring.every(
    ([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90,
  );
}

export function buildKmlText(source) {
  const predio = normalizePredioForDeliverables(source);
  const parts = predio.geometryParts?.length
    ? predio.geometryParts
    : [{ outerRing: predio.ring, innerRings: [] }];

  if (!parts.length || !parts.every((part) => isWgs84Ring(part.outerRing))) {
    throw new Error('El predio no tiene geometría WGS84 válida para generar el archivo KML.');
  }

  const geometryKml = parts.length === 1
    ? kmlPolygon(parts[0])
    : `<MultiGeometry>
${parts.map((part) => `      ${kmlPolygon(part)}`).join('\n')}
      </MultiGeometry>`;
  const documentName = `CatastroX - ${predio.municipio}, ${predio.departamento}`;
  const veredaLine = predio.veredaDisplay?.isCadastralCode
    ? `${predio.veredaDisplay.label}: ${predio.veredaDisplay.value}. ${predio.veredaDisplay.secondaryLabel}: ${predio.veredaDisplay.secondaryValue}. ${predio.veredaDisplay.note}`
    : `${predio.veredaDisplay?.label || 'Vereda'}: ${predio.veredaDisplay?.value || 'Información no disponible'}.`;
  const description = [
    'Reporte predial CatastroX - Paquete Plus.',
    `Municipio: ${predio.municipio}.`,
    `Departamento: ${predio.departamento}.`,
    veredaLine,
    `Código predial: ${predio.codigoPredial}.`,
    `Área total: ${formatNumber(predio.areaHa)} ha.`,
    `Perímetro: ${formatNumber(predio.perimetroM)} m.`,
    `Destino económico: ${predio.destinoEconomicoNombre}.`,
    `Uso principal: ${predio.uso1Nombre}.`,
    `Registros constructivos asociados: ${formatNumberOrUnavailable(predio.numeroConstrucciones, { decimals: 0 })}.`,
    predio.destinoEconomicoSemantic?.isAmbiguous ? predio.destinoEconomicoSemantic.note : null,
    'Archivo para visualización del polígono predial en Google Earth o herramientas compatibles.',
    'No reemplaza certificados oficiales, levantamientos topográficos ni decisiones de autoridad competente.',
  ].filter(Boolean).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(documentName)}</name>
    <Placemark>
      <name>${escapeXml(`Predio ${predio.codigoPredial}`)}</name>
      <description>${escapeXml(description)}</description>
      <Style>
        <LineStyle><color>ffef8b00</color><width>3</width></LineStyle>
        <PolyStyle><color>66ffd9b3</color></PolyStyle>
      </Style>
      ${geometryKml}
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
  const geometryParts = predio.geometryParts?.length
    ? predio.geometryParts
    : [{ outerRing: predio.ring, innerRings: [] }];
  const shapeRings = geometryParts.flatMap((part) => [part.outerRing, ...(part.innerRings || [])]).filter((ring) => ring.length >= 4);
  if (!shapeRings.length) {
    throw new Error('El predio no tiene geometría disponible para generar archivos GIS.');
  }

  const allPoints = shapeRings.flat();
  const xs = allPoints.map((pt) => pt[0]);
  const ys = allPoints.map((pt) => pt[1]);
  const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const numParts = shapeRings.length;
  const numPoints = allPoints.length;
  const recordContentBytes = 4 + 32 + 4 + 4 + 4 * numParts + 16 * numPoints;
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
  shpView.setInt32(144, numParts, true);
  shpView.setInt32(148, numPoints, true);
  let partStart = 0;
  let partOffset = 152;
  shapeRings.forEach((ring) => {
    shpView.setInt32(partOffset, partStart, true);
    partStart += ring.length;
    partOffset += 4;
  });
  let pointOffset = 152 + numParts * 4;
  shapeRings.forEach((ring) => {
    ring.forEach(([lng, lat]) => {
      shpView.setFloat64(pointOffset, lng, true);
      shpView.setFloat64(pointOffset + 8, lat, true);
      pointOffset += 16;
    });
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
  const kmlText = buildKmlText(source);
  return buildZip([{ name: `${fileSafeCode(predio)}.kml`, data: textEncoder.encode(kmlText) }]);
}

export function buildShpZipBytes(source) {
  const predio = normalizePredioForDeliverables(source);
  const stem = fileSafeCode(predio);
  const parts = writeShapefileParts(source);
  return buildZip([
    { name: `${stem}.shp`, data: parts.shp },
    { name: `${stem}.shx`, data: parts.shx },
    { name: `${stem}.dbf`, data: parts.dbf },
    { name: `${stem}.prj`, data: parts.prj },
  ]);
}

function dxfSafeText(value) {
  return cleanText(value).replace(/\r?\n/g, ' ').replace(/\^/g, '');
}

function dxfPair(code, value) {
  return `${code}\n${value}\n`;
}

function dxfPointEntity(layer, x, y) {
  return [
    dxfPair(0, 'POINT'),
    dxfPair(8, layer),
    dxfPair(10, x),
    dxfPair(20, y),
    dxfPair(30, 0),
  ].join('');
}

function dxfCircleEntity(layer, x, y, radius) {
  return [
    dxfPair(0, 'CIRCLE'),
    dxfPair(8, layer),
    dxfPair(10, x),
    dxfPair(20, y),
    dxfPair(30, 0),
    dxfPair(40, radius),
  ].join('');
}

function dxfTextEntity(layer, x, y, height, text, rotation = 0) {
  return [
    dxfPair(0, 'TEXT'),
    dxfPair(8, layer),
    dxfPair(10, x),
    dxfPair(20, y),
    dxfPair(30, 0),
    dxfPair(40, height),
    dxfPair(1, dxfSafeText(text)),
    dxfPair(50, rotation),
  ].join('');
}

function buildDxfLayerTable(layerNames) {
  const layerEntries = layerNames
    .map((layerName) =>
      [
        dxfPair(0, 'LAYER'),
        dxfPair(2, layerName),
        dxfPair(70, 0),
        dxfPair(62, 7),
        dxfPair(6, 'CONTINUOUS'),
      ].join(''),
    )
    .join('');

  return [
    dxfPair(0, 'TABLE'),
    dxfPair(2, 'LAYER'),
    dxfPair(70, layerNames.length),
    layerEntries,
    dxfPair(0, 'ENDTAB'),
  ].join('');
}

function buildDxfPolylineEntity(layer, ring) {
  const pairs = [
    dxfPair(0, 'LWPOLYLINE'),
    dxfPair(8, layer),
    dxfPair(90, ring.length),
    dxfPair(70, 1),
  ];

  ring.forEach(([lng, lat]) => {
    pairs.push(dxfPair(10, lng));
    pairs.push(dxfPair(20, lat));
  });

  return pairs.join('');
}

function buildDxfInfoEntities(predio, bbox, spanLng, spanLat) {
  const textHeight = Math.max(spanLat * 0.03, 0.00008);
  const lineGap = textHeight * 1.8;
  const startX = bbox[2] + spanLng * 0.06;
  const startY = bbox[3];
  const infoLines = [
    `CODIGO PREDIAL: ${predio.codigoPredial}`,
    `MUNICIPIO: ${predio.municipio}`,
    `DEPARTAMENTO: ${predio.departamento}`,
    `AREA: ${formatNumber(predio.areaHa)} ha`,
    `PERIMETRO: ${formatNumber(predio.perimetroM)} m`,
    'SISTEMA DE REFERENCIA: WGS84 GEOGRAFICO',
  ];

  return infoLines
    .map((line, index) => dxfTextEntity('CATASTROX_INFO', startX, startY - lineGap * index, textHeight, line))
    .join('');
}

function buildDxfWarningEntities(bbox, spanLng, spanLat) {
  const textHeight = Math.max(spanLat * 0.024, 0.000065);
  const lineGap = textHeight * 1.7;
  const startX = bbox[0];
  const startY = bbox[1] - spanLat * 0.09;
  const lines = [
    'Coordenadas en WGS84 geograficas. Para uso profesional proyectar al sistema oficial correspondiente.',
    'CatastroX realiza analisis tecnico sobre informacion geografica y catastral publica disponible.',
    'Este documento no reemplaza certificados oficiales del IGAC, gestor catastral, oficina de registro ni autoridad competente.',
  ];

  return lines
    .map((line, index) => dxfTextEntity('CATASTROX_ADVERTENCIA', startX, startY - lineGap * index, textHeight, line))
    .join('');
}

export function buildDxfText(source) {
  const predio = normalizePredioForDeliverables(source);
  if (!predio.ring.length) {
    throw new Error('El predio no tiene geometria disponible para generar DXF.');
  }

  const layoutData = buildLayoutData(predio, resolvePlanLayoutOptions(predio));
  const { referencePoints = [], referenceRows = [] } = layoutData;
  const shapeRings = (predio.geometryParts?.length
    ? predio.geometryParts.flatMap((part) => [part.outerRing, ...(part.innerRings || [])])
    : [predio.ring]).filter((ring) => ring.length >= 4);
  const allDxfPoints = shapeRings.flat();
  const bbox = getRingBounds(allDxfPoints);
  const spanLng = Math.max((bbox.maxLng || 0) - (bbox.minLng || 0), 0.0001);
  const spanLat = Math.max((bbox.maxLat || 0) - (bbox.minLat || 0), 0.0001);
  const vertexRadius = Math.max(Math.min(spanLng, spanLat) * 0.015, 0.00004);
  const labelOffsetX = spanLng * 0.02;
  const labelOffsetY = spanLat * 0.02;
  const labelHeight = Math.max(spanLat * 0.028, 0.00007);

  const vertexEntities = referencePoints
    .map((entry, index) => {
      const point = entry.point || entry;
      const label = referenceRows[index]?.point || `P${index + 1}`;
      if (!Array.isArray(point) || point.length < 2) return '';
      return [
        dxfPointEntity('CATASTROX_VERTICES', point[0], point[1]),
        dxfCircleEntity('CATASTROX_VERTICES', point[0], point[1], vertexRadius),
        dxfTextEntity('CATASTROX_ETIQUETAS', point[0] + labelOffsetX, point[1] + labelOffsetY, labelHeight, label),
      ].join('');
    })
    .join('');

  const sections = [
    '0\nSECTION\n2\nHEADER\n0\nENDSEC\n',
    `0\nSECTION\n2\nTABLES\n${buildDxfLayerTable([
      'CATASTROX_POLIGONO',
      'CATASTROX_VERTICES',
      'CATASTROX_ETIQUETAS',
      'CATASTROX_INFO',
      'CATASTROX_ADVERTENCIA',
    ])}0\nENDSEC\n`,
    `0\nSECTION\n2\nENTITIES\n${shapeRings.map((ring) => buildDxfPolylineEntity('CATASTROX_POLIGONO', ring)).join('')}${vertexEntities}${buildDxfInfoEntities(
      predio,
      [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat],
      spanLng,
      spanLat,
    )}${buildDxfWarningEntities([bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat], spanLng, spanLat)}0\nENDSEC\n0\nEOF\n`,
  ];

  return sections.join('');
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

function diagnosePlanPdfError(predio, error) {
  if (!predio.ring?.length && !predio.geometryParts?.length) return 'geometria_vacia';
  const message = String(error?.message || '');
  if (/tile|NetworkError|fetch/i.test(message)) return 'error_tile';
  if (/font|FontFace/i.test(message)) return 'error_fuente';
  if (/toBlob|canvas|Tainted/i.test(message)) return 'error_canvas';
  return 'error_layout';
}

export async function downloadDiagnosticPdf(source) {
  const predio = normalizePredioForDeliverables(source);
  try {
    downloadBytes(await buildDiagnosticPdfBytes(source), `${fileSafeCode(predio)}.pdf`, 'application/pdf');
  } catch (error) {
    console.error(`CatastroX PDF diagnóstico [${diagnosePlanPdfError(predio, error)}]`, error);
    window.alert('No fue posible generar el diagnóstico PDF en este momento. Intente nuevamente.');
  }
}

export async function downloadPlanPdf(source) {
  const predio = normalizePredioForDeliverables(source);
  try {
    downloadBytes(await buildPlanPdfBytes(source), `${fileSafeCode(predio)}_plano.pdf`, 'application/pdf');
  } catch (error) {
    console.error(`CatastroX PDF plano [${diagnosePlanPdfError(predio, error)}]`, error);
    window.alert('No fue posible generar el plano PDF en este momento. Intente nuevamente.');
  }
}

export function downloadKml(source) {
  const predio = normalizePredioForDeliverables(source);
  try {
    downloadBytes(textEncoder.encode(buildKmlText(source)), `${fileSafeCode(predio)}.kml`, 'application/vnd.google-earth.kml+xml');
  } catch (error) {
    console.error('CatastroX KML', error);
    window.alert('No fue posible generar el archivo KML: geometría del predio no disponible o inválida.');
  }
}

export function downloadKmz(source) {
  const predio = normalizePredioForDeliverables(source);
  try {
    downloadBytes(buildKmzBytes(source), `${fileSafeCode(predio)}.kmz`, 'application/vnd.google-earth.kmz');
  } catch (error) {
    console.error('CatastroX KMZ', error);
    window.alert('No fue posible generar el archivo KMZ: geometría del predio no disponible o inválida.');
  }
}

export function downloadShpZip(source) {
  const predio = normalizePredioForDeliverables(source);
  try {
    downloadBytes(buildShpZipBytes(source), `${fileSafeCode(predio)}.zip`, 'application/zip');
  } catch (error) {
    console.error('CatastroX SHP', error);
    window.alert('No fue posible generar los archivos GIS: geometría del predio no disponible o inválida.');
  }
}

export function downloadDxf(source) {
  const predio = normalizePredioForDeliverables(source);
  try {
    downloadBytes(textEncoder.encode(buildDxfText(source)), `${fileSafeCode(predio)}.dxf`, 'application/dxf');
  } catch (error) {
    console.error('CatastroX DXF', error);
    window.alert('No fue posible generar el archivo DXF: geometría del predio no disponible o inválida.');
  }
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
    geometryPartCount: predio.geometryParts?.length || 0,
    geometryRingCount: predio.geometryParts?.reduce((sum, part) => sum + 1 + (part.innerRings?.length || 0), 0) || 0,
    geometryTotalPoints: predio.geometryParts?.reduce(
      (sum, part) => sum + part.outerRing.length + (part.innerRings || []).reduce((innerSum, ring) => innerSum + ring.length, 0),
      0,
    ) || predio.ring.length,
    referencePoints: layoutData.referencePoints.length,
    pdfBytes: diagnosticPdfBytes,
    planPdfBytes,
    kmlBytes: textEncoder.encode(buildKmlText(predio)).length,
    kmzBytes: buildKmzBytes(predio).length,
    shpZipBytes: buildShpZipBytes(predio).length,
    dxfBytes: textEncoder.encode(buildDxfText(predio)).length,
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
