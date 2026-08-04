// CATX-PDF-PARITY-002: mosaico satelital server-side para la página 1 del
// PDF comprado. Reproduce el mismo mecanismo que ya usa el generador de
// navegador (src/modules/catastrox/utils/catastroxDeliverables.js,
// drawHybridMap/loadTileBitmap/tileUrl) -- mismo proveedor, mismas dos
// capas, mismo esquema de teselas XYZ -- pero SIN canvas/Image/document:
// cada tesela se pide con fetch() (ya global en Node >=18, sin dependencia
// nueva) y se coloca directamente como imagen PDFKit (doc.image(buffer, x,
// y, {width, height})) en su posición exacta dentro del recuadro del mapa.
// PDFKit permite superponer múltiples imágenes en la misma página, así que
// el mosaico nunca necesita componerse en un bitmap intermedio -- no hace
// falta canvas/node-canvas/sharp/skia-canvas ni ninguna otra dependencia
// nativa, ni en producción ni en pruebas (ajuste obligatorio del pedido).
//
// Estricto por diseño (a diferencia del navegador, que usa
// Promise.allSettled y tolera teselas faltantes): aquí CUALQUIER tesela que
// falle o exceda el timeout aborta toda la generación con un error
// .code='MAP_RENDER_FAILED' -- nunca se arma un mapa con huecos. El
// llamador (deliveryJobService.js, vía catastroxPdfGenerator.js) deja el
// job en FAILED con ese código, nunca almacena ni envía un PDF a medio
// generar (ver processDeliveryJob: el throw ocurre antes de cualquier
// insert/storage.put).

const TILE_SIZE = 256;

// Mismo proveedor que el mapa interactivo (CatastroXMap.jsx/GisMap.jsx) y
// que el generador de navegador -- Esri World Imagery, servicio de teselas
// público, sin API key ni token.
const IMAGERY_TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const LABELS_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

// Atribución vigente obtenida en vivo de cada servicio
// (`<url>/MapServer?f=json`, campo `copyrightText`) el 2026-08-03 --
// requisito obligatorio del pedido (nunca omitir la atribución del
// proveedor de la imagen base). Es texto público que cambia con muy poca
// frecuencia -- se documenta como constante en vez de volver a pedirlo en
// cada generación de PDF (evitaría una tercera llamada de red por
// documento, con su propio riesgo de fallo, por un dato casi estático).
// Revisar periódicamente contra el servicio si Esri actualiza el crédito.
export const ESRI_IMAGERY_ATTRIBUTION = 'Fuente: Esri, Vantor, Earthstar Geographics y la comunidad de usuarios GIS.';
export const ESRI_LABELS_ATTRIBUTION = 'Referencias: Esri, HERE, Garmin, © colaboradores de OpenStreetMap y la comunidad de usuarios GIS.';

const DEFAULT_TILE_TIMEOUT_MS = 5000;

function tileUrl(template, z, x, y) {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

class MapRenderError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'MapRenderError';
    this.code = 'MAP_RENDER_FAILED';
    if (cause) this.cause = cause;
  }
}

async function fetchTileBuffer(url, { timeoutMs = DEFAULT_TILE_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new MapRenderError(`El proveedor de teselas respondió ${response.status} para ${url}.`);
    }
    const arrayBuffer = await response.arrayBuffer();
    if (!arrayBuffer.byteLength) {
      throw new MapRenderError(`El proveedor de teselas devolvió una tesela vacía para ${url}.`);
    }
    return Buffer.from(arrayBuffer);
  } catch (error) {
    if (error instanceof MapRenderError) throw error;
    if (error?.name === 'AbortError') {
      throw new MapRenderError(`Timeout (${timeoutMs}ms) al descargar tesela satelital: ${url}.`, { cause: error });
    }
    throw new MapRenderError(`Error de red al descargar tesela satelital: ${url}.`, { cause: error });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Calcula, para un `mapState` (ver computeMapState en catastroxPdfGeometry.js)
 * y un recuadro `zone` (ancho/alto en las mismas unidades que mapState), qué
 * teselas XYZ cubren ese recuadro y en qué posición relativa a `zone` debe
 * colocarse cada una -- misma matemática exacta que drawHybridMap del
 * navegador (mismo TILE_SIZE, mismo cálculo de left/top vía
 * centerWorldX*scale). Pura, sin red -- separada de fetchSatelliteTiles
 * para poder probarla sin mockear fetch.
 */
export function computeTilePlacements(mapState, zoneWidth, zoneHeight) {
  const centerPixelX = mapState.centerWorldX * mapState.scale;
  const centerPixelY = mapState.centerWorldY * mapState.scale;
  const left = centerPixelX - zoneWidth / 2;
  const top = centerPixelY - zoneHeight / 2;
  const right = centerPixelX + zoneWidth / 2;
  const bottom = centerPixelY + zoneHeight / 2;

  const tileXStart = Math.floor(left / TILE_SIZE);
  const tileXEnd = Math.floor(right / TILE_SIZE);
  const tileYStart = Math.floor(top / TILE_SIZE);
  const tileYEnd = Math.floor(bottom / TILE_SIZE);

  const placements = [];
  for (let tileX = tileXStart; tileX <= tileXEnd; tileX += 1) {
    for (let tileY = tileYStart; tileY <= tileYEnd; tileY += 1) {
      placements.push({
        tileX,
        tileY,
        drawX: tileX * TILE_SIZE - left,
        drawY: tileY * TILE_SIZE - top,
      });
    }
  }
  return placements;
}

/**
 * Descarga el mosaico satelital completo (imagería + etiquetas) para un
 * `mapState` y un tamaño de recuadro dados. Estricto: cualquier tesela que
 * falle (`Promise.all`, no `allSettled`) rechaza de inmediato con
 * MapRenderError (.code='MAP_RENDER_FAILED') -- nunca se arma un mosaico
 * con huecos. `fetchTile` es inyectable exclusivamente para pruebas
 * (mock determinista de teselas fijas, ver __tests__).
 *
 * @returns {Promise<Array<{buffer: Buffer, drawX: number, drawY: number}>>}
 */
export async function fetchSatelliteMosaic(mapState, zoneWidth, zoneHeight, { timeoutMs = DEFAULT_TILE_TIMEOUT_MS, fetchTile = fetchTileBuffer } = {}) {
  const placements = computeTilePlacements(mapState, zoneWidth, zoneHeight);
  if (!placements.length) {
    throw new MapRenderError('No fue posible determinar ninguna tesela satelital para el recuadro del mapa.');
  }

  const layers = [IMAGERY_TILE_URL, LABELS_TILE_URL];
  const allTiles = [];

  for (const template of layers) {
    // Secuencial por capa (imagería primero, etiquetas encima) para que el
    // orden de dibujo en PDFKit sea determinista; dentro de cada capa las
    // teselas se piden en paralelo.
    const layerTiles = await Promise.all(
      placements.map(async (placement) => {
        const url = tileUrl(template, mapState.zoom, placement.tileX, placement.tileY);
        const buffer = await fetchTile(url, { timeoutMs });
        return { buffer, drawX: placement.drawX, drawY: placement.drawY };
      }),
    );
    allTiles.push(...layerTiles);
  }

  return allTiles;
}

export { MapRenderError, TILE_SIZE, IMAGERY_TILE_URL, LABELS_TILE_URL, fetchTileBuffer };
