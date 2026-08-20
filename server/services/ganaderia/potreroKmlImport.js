// SPRINT-3D5-POTRERO-KML-KMZ: parseo server-side de archivos KML/KMZ para
// generar candidatos de Potrero. Módulo puro (sin Express, sin DB) --
// recibe un Buffer + el nombre de archivo declarado por el cliente, y
// devuelve una lista de { wkt, nombreSugerido } listos para validar contra
// PostGIS (ver server/services/ganaderia/potrerosRepository.js, que sigue
// siendo la única fuente de verdad para ST_IsValid/ST_CoveredBy/ST_Area --
// este módulo NUNCA valida geometría espacialmente, solo la extrae).
//
// Todo se procesa en memoria. Nunca se escribe a disco.
import { DOMParser } from '@xmldom/xmldom';
import { kml as kmlToGeoJson } from '@tmcw/togeojson';
import JSZip from 'jszip';

// §4 del sprint: límites explícitos, valores tomados directamente del
// ejemplo propuesto en el sprint (no se justifican desviaciones porque no
// se desvía de lo propuesto).
export const FILE_MAX_BYTES = 10 * 1024 * 1024; // archivo subido (KML o KMZ comprimido)
export const KMZ_MAX_DECOMPRESSED_BYTES = 25 * 1024 * 1024; // contenido .kml ya descomprimido
export const KMZ_MAX_ENTRIES = 100; // entradas dentro del ZIP
export const MAX_POLYGONS = 100; // geometrías poligonales procesables por archivo
const MAX_NOMBRE_SUGERIDO_LENGTH = 120; // mismo límite que MAX_NOMBRE_LENGTH en ganaderiaPotreros.js
const MIN_DISTINCT_VERTICES = 3;

function semanticError(code, status, message) {
  return Object.assign(new Error(message || code), { status, code });
}

// -----------------------------------------------------------------------
// §3: extensión declarada -- gate rápido y barato, NUNCA la única defensa
// (el contenido se re-verifica por firma binaria más abajo).
// -----------------------------------------------------------------------
export function resolveDeclaredExtension(fileNameHeader) {
  if (typeof fileNameHeader !== 'string') return null;
  // Solo el nombre base -- cualquier componente de ruta se descarta, nunca
  // se usa para escribir a disco ni para nada más que decidir kml/kmz.
  const baseName = fileNameHeader.split(/[/\\]/).pop() || '';
  const match = /\.([a-z0-9]+)$/i.exec(baseName.trim());
  return match ? match[1].toLowerCase() : null;
}

const ZIP_MAGIC_PREFIXES = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]), // zip vacío
  Buffer.from([0x50, 0x4b, 0x07, 0x08]), // spanned archive
];

function looksLikeZip(buffer) {
  return ZIP_MAGIC_PREFIXES.some((magic) => buffer.length >= magic.length && buffer.subarray(0, magic.length).equals(magic));
}

function looksLikeXml(buffer) {
  // Salta BOM UTF-8 opcional y espacios en blanco antes de buscar '<'.
  let offset = 0;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) offset = 3;
  const text = buffer.subarray(offset, offset + 256).toString('utf8');
  return /^\s*</.test(text);
}

// -----------------------------------------------------------------------
// §5: seguridad KMZ (ZIP). Procesado íntegramente en memoria. Solo se
// decodifica la ÚNICA entrada .kml elegida -- ninguna otra entrada
// (imágenes, recursos) se descomprime jamás, sin importar su tamaño
// declarado.
// -----------------------------------------------------------------------
async function extractKmlBufferFromKmz(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  } catch {
    throw semanticError('INVALID_KMZ', 422, 'El archivo KMZ no es un ZIP válido.');
  }

  const entries = Object.values(zip.files);
  if (entries.length > KMZ_MAX_ENTRIES) {
    throw semanticError('KMZ_TOO_MANY_ENTRIES', 422, `El archivo KMZ tiene demasiadas entradas (máx ${KMZ_MAX_ENTRIES}).`);
  }

  let declaredTotal = 0;
  for (const entry of entries) {
    // unsafeOriginalName: nombre crudo tal como aparece en el ZIP, antes de
    // que JSZip lo normalice a `entry.name`. Si difieren, o el nombre
    // crudo contiene '..'/ruta absoluta, es un intento de path traversal
    // -- se rechaza el archivo completo aunque nunca se escriba a disco.
    const rawName = entry.unsafeOriginalName ?? entry.name;
    if (
      /(^|[/\\])\.\.([/\\]|$)/.test(rawName) ||
      rawName.startsWith('/') ||
      rawName.startsWith('\\') ||
      /^[a-zA-Z]:/.test(rawName)
    ) {
      throw semanticError('INVALID_KMZ', 422, 'El archivo KMZ contiene rutas no permitidas.');
    }

    if (entry.dir) continue;

    const lowerName = entry.name.toLowerCase();
    if (lowerName.endsWith('.zip') || lowerName.endsWith('.kmz')) {
      throw semanticError('INVALID_KMZ', 422, 'El archivo KMZ contiene un archivo comprimido anidado, no permitido.');
    }

    // Chequeo declarado ANTES de descomprimir nada (§4) -- best-effort:
    // depende de metadatos internos de JSZip, por eso el chequeo real y
    // vinculante es el de tamaño post-descompresión más abajo, sobre la
    // ÚNICA entrada que efectivamente se descomprime.
    declaredTotal += entry._data?.uncompressedSize ?? 0;
  }

  if (declaredTotal > KMZ_MAX_DECOMPRESSED_BYTES) {
    throw semanticError('KMZ_DECOMPRESSED_TOO_LARGE', 422, 'El contenido del KMZ excede el tamaño máximo permitido.');
  }

  const kmlEntries = entries.filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith('.kml'));
  if (kmlEntries.length === 0) {
    throw semanticError('INVALID_KMZ', 422, 'El archivo KMZ no contiene ningún archivo .kml.');
  }
  // SPRINT-3D5-CIERRE-SEMANTICO §2: contrato aprobado explícito -- NUNCA
  // se elige "el primero" en silencio cuando hay ambigüedad. Un KMZ con
  // más de un .kml se rechaza de forma determinística: 0 -> INVALID_KMZ
  // (ya cubierto arriba), exactamente 1 -> se procesa, >1 ->
  // KMZ_MULTIPLE_KML_FILES.
  if (kmlEntries.length > 1) {
    throw semanticError('KMZ_MULTIPLE_KML_FILES', 422, 'El archivo KMZ contiene más de un archivo .kml.');
  }

  const chosen = kmlEntries[0];
  const kmlBuffer = await chosen.async('nodebuffer');

  // Chequeo real y vinculante: nunca confiar solo en el tamaño declarado.
  if (kmlBuffer.length > KMZ_MAX_DECOMPRESSED_BYTES) {
    throw semanticError('KMZ_DECOMPRESSED_TOO_LARGE', 422, 'El contenido del KMZ excede el tamaño máximo permitido.');
  }

  return kmlBuffer;
}

// -----------------------------------------------------------------------
// §6: seguridad XML / XXE.
//
// @xmldom/xmldom es un parser puro en JS sin capacidad de red -- nunca
// puede resolver una entidad externa vía HTTP/FTP/file:// (a diferencia de
// parsers como libxml2). Se comprobó además que NO expande entidades
// generales declaradas en un DOCTYPE interno (`<!ENTITY xxe "...">`):
// deja el literal `&xxe;` sin resolver y reporta 'entity not found'. Aun
// así, y siguiendo la instrucción explícita del sprint de no confiar
// únicamente en el comportamiento no documentado de la librería, se aplica
// un pre-check estricto: cualquier DOCTYPE o declaración de ENTITY se
// rechaza ANTES de tocar el parser, determinístico e independiente de la
// versión de @xmldom/xmldom instalada.
// -----------------------------------------------------------------------
const DOCTYPE_OR_ENTITY_PATTERN = /<!\s*(DOCTYPE|ENTITY)\b/i;

function assertNoDtd(xmlText) {
  if (DOCTYPE_OR_ENTITY_PATTERN.test(xmlText)) {
    throw semanticError('INVALID_KML', 422, 'El archivo KML contiene una declaración DOCTYPE/ENTITY no permitida.');
  }
}

function parseKmlXmlToDom(xmlText) {
  assertNoDtd(xmlText);

  try {
    const parser = new DOMParser({
      onError: (level, message) => {
        if (level === 'error' || level === 'fatalError') {
          throw new Error(message);
        }
        // 'warning' se tolera (p.ej. namespaces no estrictos) -- no es
        // motivo de rechazo, mismo criterio que otros parsers XML tolerantes.
      },
    });
    const dom = parser.parseFromString(xmlText, 'text/xml');
    if (!dom?.documentElement) {
      throw new Error('documento KML vacío o sin elemento raíz');
    }
    return dom;
  } catch {
    throw semanticError('INVALID_KML', 422, 'El archivo KML no es XML válido.');
  }
}

// -----------------------------------------------------------------------
// §7/§8: extracción de geometrías. Solo Polygon. MultiPolygon se separa en
// Polygon individuales de forma determinística (por índice del array
// `coordinates`) -- nunca ST_Union, nunca se guarda MultiPolygon.
// Point/LineString/MultiLineString se ignoran (no producen candidato ni
// abortan el archivo completo), pero SIEMPRE se cuentan y se reportan al
// llamador (`ignored`) -- nunca de forma silenciosa (SPRINT-3D5-CIERRE-
// SEMANTICO §1). Si al final no queda ningún Polygon, se lanza
// NO_POLYGONS_FOUND igual que antes.
// -----------------------------------------------------------------------
function sanitizeNombreSugerido(rawName) {
  if (typeof rawName !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = rawName.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_NOMBRE_SUGERIDO_LENGTH);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Construye un WKT Polygon (con anillos/huecos, si los hay) a partir de
 * `coordinates` de un Polygon GeoJSON ([anilloExterior, hueco1, ...], cada
 * anillo es una lista de [lng, lat, alt?]). Misma filosofía que
 * buildPolygonWktFromPuntos en potrerosRepository.js: cierre de anillo
 * explícito en JS, nunca en SQL, sin buffer/snap/tolerancia oculta. La
 * altitud (3er valor opcional de KML) se descarta -- el esquema es 2D
 * (SRID 4326 plano).
 */
export function geoJsonPolygonToWkt(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    throw semanticError('INVALID_POTRERO_GEOMETRY', 422, 'Polígono sin anillos.');
  }

  const rings = coordinates.map((ring) => {
    if (!Array.isArray(ring) || ring.length < MIN_DISTINCT_VERTICES) {
      throw semanticError('INVALID_POTRERO_GEOMETRY', 422, `Se requieren al menos ${MIN_DISTINCT_VERTICES} vértices por anillo.`);
    }

    const parsed = ring.map((coord) => {
      const lng = Number(coord?.[0]);
      const lat = Number(coord?.[1]);
      if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) {
        throw semanticError('INVALID_POTRERO_GEOMETRY', 422, 'Coordenadas no numéricas en el polígono.');
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        throw semanticError('INVALID_POTRERO_GEOMETRY', 422, 'Coordenadas fuera de rango WGS84.');
      }
      return { lat, lng };
    });

    let points = parsed;
    const first = points[0];
    const last = points[points.length - 1];
    if (points.length > MIN_DISTINCT_VERTICES && first.lat === last.lat && first.lng === last.lng) {
      points = points.slice(0, -1);
    }

    const distinctCount = new Set(points.map((p) => `${p.lat}:${p.lng}`)).size;
    if (points.length < MIN_DISTINCT_VERTICES || distinctCount < MIN_DISTINCT_VERTICES) {
      throw semanticError('INVALID_POTRERO_GEOMETRY', 422, `Se requieren al menos ${MIN_DISTINCT_VERTICES} vértices distintos por anillo.`);
    }

    const closed = [...points, points[0]];
    return `(${closed.map((p) => `${p.lng} ${p.lat}`).join(', ')})`;
  });

  return `POLYGON(${rings.join(', ')})`;
}

function collectPolygonGeometries(geometry, results, name, ignored) {
  if (!geometry || typeof geometry.type !== 'string') return;

  if (geometry.type === 'Polygon') {
    results.push({ wkt: geoJsonPolygonToWkt(geometry.coordinates), nombreSugerido: name });
    return;
  }

  if (geometry.type === 'MultiPolygon') {
    for (const polygonCoordinates of geometry.coordinates || []) {
      results.push({ wkt: geoJsonPolygonToWkt(polygonCoordinates), nombreSugerido: name });
    }
    return;
  }

  if (geometry.type === 'GeometryCollection') {
    for (const sub of geometry.geometries || []) {
      collectPolygonGeometries(sub, results, name, ignored);
    }
    return;
  }

  // SPRINT-3D5-CIERRE-SEMANTICO §1: Point/LineString/MultiLineString se
  // ignoran (nunca se convierten en polígono, nunca abortan un archivo
  // mixto), pero el conteo se reporta al llamador -- nunca de forma
  // silenciosa. Cualquier otro tipo (p.ej. MultiPoint) no forma parte del
  // contrato aprobado y se descarta sin contar (fuera de alcance).
  if (geometry.type === 'Point') {
    ignored.points += 1;
    return;
  }
  if (geometry.type === 'LineString') {
    ignored.lineStrings += 1;
    return;
  }
  if (geometry.type === 'MultiLineString') {
    ignored.multiLineStrings += 1;
    return;
  }
}

function extractPolygonsFromGeoJson(featureCollection) {
  const results = [];
  const ignored = { points: 0, lineStrings: 0, multiLineStrings: 0 };
  const features = Array.isArray(featureCollection?.features) ? featureCollection.features : [];

  for (const feature of features) {
    const nombreSugerido = sanitizeNombreSugerido(feature?.properties?.name);
    collectPolygonGeometries(feature?.geometry, results, nombreSugerido, ignored);
  }

  if (results.length === 0) {
    throw semanticError('NO_POLYGONS_FOUND', 422, 'El archivo no contiene ningún polígono.');
  }
  if (results.length > MAX_POLYGONS) {
    throw semanticError('TOO_MANY_POLYGONS', 422, `El archivo supera el máximo de ${MAX_POLYGONS} polígonos procesables.`);
  }

  return { polygons: results, ignored };
}

// -----------------------------------------------------------------------
// Entrada pública del módulo.
// -----------------------------------------------------------------------

/**
 * Valida tamaño/tipo, extrae (si aplica) el .kml de un .kmz de forma
 * segura, parsea el XML sin DTD/XXE y devuelve los polígonos encontrados.
 * `buffer` es el archivo crudo tal como llegó en el body de la request
 * (§4: el llamador ya debe haber validado FILE_MAX_BYTES ANTES de invocar
 * esto -- aquí se revalida como defensa en profundidad).
 */
export async function parseKmlOrKmzUpload(buffer, { fileNameHeader } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw semanticError('INVALID_KML', 422, 'Archivo vacío.');
  }
  if (buffer.length > FILE_MAX_BYTES) {
    throw semanticError('FILE_TOO_LARGE', 413, `El archivo supera el máximo permitido (${FILE_MAX_BYTES / (1024 * 1024)} MB).`);
  }

  const extension = resolveDeclaredExtension(fileNameHeader);
  if (extension !== 'kml' && extension !== 'kmz') {
    throw semanticError('UNSUPPORTED_FILE_TYPE', 415, 'Solo se aceptan archivos .kml o .kmz.');
  }

  const isZip = looksLikeZip(buffer);

  let kmlBuffer;
  let metodoDelimitacion;

  if (extension === 'kmz') {
    if (!isZip) {
      throw semanticError('INVALID_KMZ', 422, 'El archivo declarado como .kmz no tiene formato ZIP.');
    }
    kmlBuffer = await extractKmlBufferFromKmz(buffer);
    metodoDelimitacion = 'kmz';
  } else {
    if (isZip || !looksLikeXml(buffer)) {
      throw semanticError('INVALID_KML', 422, 'El archivo declarado como .kml no tiene formato XML.');
    }
    kmlBuffer = buffer;
    metodoDelimitacion = 'kml';
  }

  const xmlText = kmlBuffer.toString('utf8');
  const dom = parseKmlXmlToDom(xmlText);

  let geojson;
  try {
    geojson = kmlToGeoJson(dom);
  } catch {
    throw semanticError('INVALID_KML', 422, 'No fue posible interpretar el contenido KML.');
  }

  const { polygons, ignored } = extractPolygonsFromGeoJson(geojson);

  return { metodoDelimitacion, polygons, ignored };
}
