// CATX-DELIVERY-001-HOTFIX-RAILWAY: copia server-side autosuficiente del
// subconjunto de catastroxDeliverables.js que el generador de PDF server-side
// realmente usa (normalización de datos, layout, contenido por paquete,
// nombre de archivo). Extraído por cierre de dependencias (AST) desde
// src/modules/catastrox/utils/catastroxDeliverables.js -- deliberadamente NO
// incluye ninguna función de dibujo canvas/navegador (build*Canvas,
// buildImageOnlyPdf, canvasToJpegBytes, etc.), que siguen viviendo solo en
// el archivo original (usado exclusivamente por el frontend).
//
// server/__tests__/architecture/noSrcImports.test.js falla el build si algún
// archivo bajo server/ vuelve a importar desde src/.

import {
  buildDisplayRingFromOriginalRing,
  buildReferenceRows,
  buildReferenceSegments,
  computeMapState,
  cumulativeDistances,
  getRingBounds,
  normalizeRing,
  perpendicularDistanceMeters,
  projectRingToLocalMeters,
  projectRingToViewport,
  reducePointsForVisualClarity,
  ringDistanceForward,
  selectVisibleReferencePoints,
} from './catastroxPdfGeometry.js';
import { getDestinoEconomicoDisplay, getTipoConstruccionDisplay, getUsoDisplay, getVeredaDisplay } from './catastroxPdfFormatting.js';

const PAGE = { width: 792, height: 612, scale: 2 };

const UNIFIED_FOOTER_RECT = { x: 24, y: 576, width: 744, height: 20 };

const SATELLITE_LAYOUT = {
  page: { x: 0, y: 0, width: PAGE.width, height: PAGE.height },
  header: { x: 22, y: 20, width: 748, height: 84 },
  mapArea: { x: 24, y: 112, width: 446, height: 394 },
  rightPanel: { x: 484, y: 112, width: 284, height: 394 },
  bottomPanel: { x: 24, y: 516, width: 744, height: 52 },
  footer: UNIFIED_FOOTER_RECT,
};

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

const CATASTROX_VALID_PACKAGE_IDS = Object.freeze(['basico', 'plus', 'profesional']);

export function buildCatastroxDeliverableFilename({ codigoPredial, packageId, deliverableType }) {
  const code = cleanText(codigoPredial, 'predio').toLowerCase().replace(/[^\w.-]+/g, '_');
  const normalizedPackageId = String(packageId || '').trim().toLowerCase();
  const packageSuffix = CATASTROX_VALID_PACKAGE_IDS.includes(normalizedPackageId) ? `_${normalizedPackageId}` : '';
  const base = `${code}${packageSuffix}`;

  const buildersByType = {
    pdf: () => `${base}.pdf`,
    kml: () => `${base}.kml`,
    kmz: () => `${base}.kmz`,
    dxf: () => `${base}.dxf`,
    shpZip: () => `${base}_shp.zip`,
    shp: () => `${base}.shp`,
    shx: () => `${base}.shx`,
    dbf: () => `${base}.dbf`,
    prj: () => `${base}.prj`,
    cpg: () => `${base}.cpg`,
    coordinatesZip: () => `${base}_coordenadas_epsg9377.zip`,
    coordinatesCsv: () => `${base}_coordenadas_epsg9377.csv`,
  };

  const builder = buildersByType[deliverableType];
  if (!builder) {
    throw new Error(`deliverableType desconocido para nombrar un entregable CatastroX: "${deliverableType}".`);
  }

  return builder();
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

export function toSentenceCase(text) {
  const clean = cleanText(text);
  if (!clean) return '';
  const lower = clean.toLocaleLowerCase('es-CO');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
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

function humanizeDashSeparatedList(text) {
  const clean = cleanText(text);
  if (!clean) return clean;
  const parts = clean.split(/\s*-\s*/).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return clean;
  const lowered = parts.map((part) => part.toLowerCase());
  const head = lowered.slice(0, -1);
  return `${head.join(', ')} y ${lowered[lowered.length - 1]}`;
}

export function buildUsosConstructivosList(predio) {
  const usos = collectUsosConstructivos(predio);
  if (!usos.length) return ['Información no disponible'];
  return usos.map((value) => toSentenceCase(humanizeDashSeparatedList(value)));
}

// CATX-PDF-PARITY-002 (tercera vuelta): porte literal de
// simplifyUsoLabelForSummary/buildUsosConstructivosResumen
// (catastroxDeliverables.js:297-324) -- la tarjeta "Usos constructivos" de
// la página 1 usa este resumen deduplicado, NUNCA un join() directo de
// uso1/uso2/uso3 (eso mostraba el mismo uso dos veces cuando uso2Nombre y
// uso3Nombre llegaban duplicados de la fuente).
function simplifyUsoLabelForSummary(value) {
  const clean = cleanText(value);
  if (!clean) return '';
  const humanized = humanizeDashSeparatedList(clean);
  const stripped = humanized.replace(/\s+(HASTA|DESDE|DE|CON|A)\s+\d+.*$/i, '').trim();
  return toSentenceCase(stripped || humanized);
}

export function buildUsosConstructivosResumen(predio) {
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

// Porte literal de toProperNameTitleCase (catastroxDeliverables.js:332-354).
const TITLE_CASE_LOWERCASE_CONNECTORS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'el', 'en']);

export function toProperNameTitleCase(text) {
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

// Porte literal de formatFuenteDisplay/formatFechaProcesoDisplay
// (catastroxDeliverables.js:356-382) -- el panel FUENTE de la ficha
// técnica debe mostrar el nombre legible de la fuente y la fecha en
// español, nunca los códigos crudos (p.ej. "IGAC_PUBLICO_ABRIL_2026" /
// "2026-06-30").
const KNOWN_FUENTE_DISPLAY = {
  IGAC_PUBLICO_ABRIL_2026: 'IGAC - Base Catastral Pública, abril de 2026',
};

export function formatFuenteDisplay(value) {
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

export function formatFechaProcesoDisplay(value) {
  const clean = cleanText(value);
  if (!clean) return 'No registrado';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
  if (!match) return clean;
  const [, year, month, day] = match;
  const monthName = SPANISH_MONTH_NAMES[Number(month) - 1];
  if (!monthName) return clean;
  return `${Number(day)} de ${monthName} de ${year}`;
}

// Porte literal de LEGACY_EMPTY_FIELD_LABELS/resolveFieldOrNotRegistered/
// resolveUrbanFieldOrNotApplicable/isUrbanZona (catastroxDeliverables.js:384-403)
// -- gobierna qué campos se muestran, con qué fallback, y diferencia
// predios urbanos de rurales (Barrio/Manzana no aplican en rural; en
// urbano, si faltan, es un dato que debería existir pero no está en la
// fuente -- fallback distinto en cada caso).
const LEGACY_EMPTY_FIELD_LABELS = new Set([
  '', 'NO DISPONIBLE', 'NO APLICA / NO REGISTRA', 'NO REGISTRA', 'NO REGISTRADO', 'NO APLICA',
]);

export function resolveFieldOrNotRegistered(value) {
  const clean = cleanText(value);
  return LEGACY_EMPTY_FIELD_LABELS.has(clean.toUpperCase()) ? 'No registrado' : clean;
}

export function resolveUrbanFieldOrNotApplicable(value, zona) {
  const clean = cleanText(value);
  if (clean && !LEGACY_EMPTY_FIELD_LABELS.has(clean.toUpperCase())) return clean;
  return /rural/i.test(cleanText(zona)) ? 'No aplica' : 'No registrado';
}

export function isUrbanZona(predio) {
  return /urbano/i.test(cleanText(predio?.tipoZona || predio?.zona));
}

// Porte literal de KNOWN_TOPONYM_TITLE_CASE/toDisplayToponymTitleCase
// (catastroxDeliverables.js:239-257) -- correcciones tipográficas de
// topónimos conocidos de la cobertura Caquetá (la fuente exporta nombres
// en mayúsculas sin tilde); ámbito presentación únicamente.
const KNOWN_TOPONYM_TITLE_CASE = {
  CAQUETA: 'Caquetá',
  'CARTAGENA DEL CHAIRA': 'Cartagena del Chairá',
  'LA MONTANITA': 'La Montañita',
  'PUERTO RICO': 'Puerto Rico',
  FLORENCIA: 'Florencia',
};

export function toDisplayToponymTitleCase(text) {
  const clean = cleanText(text);
  if (!clean) return '';
  return KNOWN_TOPONYM_TITLE_CASE[clean.toUpperCase()] || toSentenceCase(clean);
}

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

export function normalizePredioForDeliverables(source) {
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
    deliverablePackageId: cleanText(predio.deliverablePackageId || source?.deliverablePackageId),
    queryPoint: predio.queryPoint || source?.queryPoint || null,
    // Estructura OPCIONAL de anotaciones CatastroX (no forma parte de los
    // datos catastrales de catastrox_clean/migración 007) -- linderos por
    // fuente hídrica u otros tipos futuros de lindero, ver
    // catastroxPdfBoundaryAnnotations.js. Ausente/vacío por defecto: ningún
    // predio se agrupa automáticamente. Ver esa asignación manual/futura
    // interfaz -- este campo solo se pasa tal cual si el llamador ya lo
    // incluyó explícitamente en predioData.
    boundaryAnnotations: Array.isArray(predio.boundaryAnnotations) ? predio.boundaryAnnotations : [],
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

export function resolvePlanLayoutOptions(predio, options = {}) {
  const { preferDenseVisiblePoints: _preferDenseVisiblePoints, ...rest } = options;
  return rest;
}

export function estimateFichaTecnicaPageCount(predio) {
  const usosCount = buildUsosConstructivosList(predio).length;
  const tiposLineCount = formatTiposConstruccionDisplayLines(predio.tiposConstruccionResumen).length;
  return usosCount > 3 || tiposLineCount > 3 ? 2 : 1;
}

export const PDF_CONTENT_MODE = Object.freeze({
  INFORMATIVE: 'informative',
  PROFESSIONAL_CURRENT: 'professional-current',
});

export function resolvePdfContentMode(packageId) {
  const normalized = String(packageId || '').trim().toLowerCase();
  return normalized === 'profesional'
    ? PDF_CONTENT_MODE.PROFESSIONAL_CURRENT
    : PDF_CONTENT_MODE.INFORMATIVE;
}

export function resolvePdfSummaryCardContent(packageId) {
  const normalized = String(packageId || '').trim().toLowerCase();

  if (normalized === 'basico') {
    return {
      title: 'PAQUETE BÁSICO',
      body: 'Incluye PDF con diagnóstico predial, ficha catastral y plano informativo.',
    };
  }

  if (normalized === 'profesional') {
    // LOTE 018-D: ya no comparte la tarjeta de Plus. Se usa la variante corta
    // (autorizada explicitamente si la version larga desborda la tarjeta de
    // 332x68px) -- la lista completa de archivos vive en la pagina 3.
    return {
      title: 'PAQUETE PROFESIONAL',
      body: 'Incluye PDF profesional y archivos técnicos para análisis geográfico especializado.',
    };
  }

  // Plus conserva exactamente el texto previo a este lote.
  return {
    title: 'PAQUETE PLUS',
    body: 'Incluye PDF, KML y KMZ para visualizar el polígono del predio y abrirlo en Google Earth.',
  };
}

export function resolvePdfUsoAlcanceContent(packageId) {
  const normalized = String(packageId || '').trim().toLowerCase();
  const isBasico = normalized === 'basico';
  const isProfesional = normalized === 'profesional';

  if (isBasico) {
    return {
      deliveredFiles: [
        'PDF: diagnóstico predial, ficha técnica y catastral y plano informativo con vértices representativos y distancias.',
      ],
      instructions: [
        'Revise la ficha técnica y catastral del predio.',
        'Consulte el plano informativo, los vértices representativos y las distancias entre tramos.',
        'Utilice el documento como apoyo para consulta, planeación y orientación técnica.',
      ],
      // LOTE 018-D: singular -- Basico entrega un unico archivo.
      instructionsTitle: 'CÓMO UTILIZARLO',
    };
  }

  if (isProfesional) {
    // LOTE 018-D: enumera exactamente los 6 entregables reales de
    // ['pdf','kml','kmz','shp','dxf','coords9377'] -- ya no omite SHP/DXF.
    // No afirma que SHP/DXF equivalgan a un levantamiento topografico certificado.
    return {
      deliveredFiles: [
        'PDF: diagnóstico predial, ficha técnica, plano y tabla de vértices representativos.',
        'KML: polígono para Google Earth y aplicaciones compatibles.',
        'KMZ: versión comprimida del KML.',
        'SHP: conjunto de archivos para software SIG.',
        'DXF: geometría de referencia para software CAD.',
        'CSV: vértices con coordenadas Este y Norte en MAGNA-SIRGAS 2018 / Origen-Nacional (EPSG:9377).',
      ],
      instructions: [
        'Consulte el PDF para revisar la información catastral, el plano y las distancias.',
        'Abra KML o KMZ en Google Earth o aplicaciones compatibles.',
        'Use el SHP en software SIG para análisis geográfico.',
        'Use el DXF como geometría de referencia en software CAD.',
        'Use el CSV para consultar coordenadas EPSG:9377 e interoperar con otras herramientas.',
      ],
      instructionsTitle: 'CÓMO UTILIZARLOS',
    };
  }

  // Plus conserva exactamente el contenido previo a este lote.
  return {
    deliveredFiles: [
      'PDF: resumen comercial, ficha técnica y plano predial con puntos y distancias.',
      'KML: polígono del predio para Google Earth y aplicaciones compatibles.',
      'KMZ: versión comprimida del KML, lista para compartir.',
    ],
    instructions: [
      'Abra el archivo KML o KMZ en Google Earth o una aplicación compatible.',
      'Verifique visualmente la ubicación del polígono sobre el mapa.',
      'Utilícelo como apoyo de consulta y planeación técnica o comercial.',
    ],
    instructionsTitle: 'CÓMO UTILIZARLOS',
  };
}

export function resolvePdfTechnicalPageTitle(contentMode) {
  return contentMode === PDF_CONTENT_MODE.INFORMATIVE
    ? 'PLANO INFORMATIVO • GEOMETRÍA CATASTRAL DEL PREDIO'
    : 'PLANO TÉCNICO • GEOMETRÍA DEL PREDIO';
}

export function resolvePdfExecutiveBottomNote(contentMode, packageId) {
  if (contentMode !== PDF_CONTENT_MODE.INFORMATIVE) {
    // LOTE 018-D: ya no menciona unicamente KML/KMZ -- Profesional tambien
    // entrega SHP/DXF/CSV. Unica combinacion real hoy (contentMode
    // profesional-actual + packageId 'profesional'); se deja generico por si
    // en el futuro otro packageId comparte este contentMode.
    return 'La tabla ejecutiva compila los puntos representativos visibles, sus coordenadas geográficas y las distancias entre tramos consecutivos. La geometría completa y los archivos técnicos del predio se entregan según el alcance del paquete Profesional. Este documento no reemplaza un levantamiento topográfico ni una certificación oficial.';
  }

  const isBasico = String(packageId || '').trim().toLowerCase() === 'basico';
  return isBasico
    ? 'La tabla informativa compila en una sola vista los puntos visibles del plano y la distancia entre tramos consecutivos. La geometría catastral completa se conserva internamente para el procesamiento del documento.'
    : 'La tabla informativa compila en una sola vista los puntos visibles del plano y la distancia entre tramos consecutivos. La geometría completa del predio permanece disponible en los archivos KML y KMZ descargables.';
}

export function resolveExecutiveTableHeaders(contentMode) {
  return contentMode === PDF_CONTENT_MODE.INFORMATIVE
    ? ['Punto', 'Siguiente', 'Distancia']
    : ['Punto', 'Latitud', 'Longitud', 'Tramo', 'Distancia'];
}

export function buildUnifiedTableRows(referenceRows, referenceSegments, contentMode = PDF_CONTENT_MODE.PROFESSIONAL_CURRENT) {
  if (contentMode === PDF_CONTENT_MODE.INFORMATIVE) {
    // Basico/Plus: unicamente vertice util, siguiente vertice util y la
    // distancia ya producida por buildReferenceSegments (nunca recalculada
    // aqui). Sin latitud, longitud, Este ni Norte.
    return referenceSegments.map((segment) => [
      segment.from,
      segment.to,
      `${formatNumber(segment.distance, 2)} m`,
    ]);
  }

  return referenceRows.map((row, index) => [
    row.point,
    row.lat,
    row.lng,
    `${referenceSegments[index].from}-${referenceSegments[index].to}`,
    `${formatNumber(referenceSegments[index].distance, 2)} m`,
  ]);
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

export function buildLayoutData(predio, options = {}) {
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
