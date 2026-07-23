import {
  buildCatastroXRegressionSnapshot,
  buildDeliverableDebugSummary,
  buildDiagnosticPdfBytes,
  buildKmlText,
  buildKmzBytes,
  buildPlanPdfBytes,
  buildShpZipBytes,
} from '/src/modules/catastrox/utils/catastroxDeliverables.js';

const BLANK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9pS4x6QAAAAASUVORK5CYII=';
const originalFetch = window.fetch.bind(window);

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function base64FromUint8Array(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function readSearchParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function coerceSource(raw) {
  if (raw?.predio) return raw;
  if (raw?.type === 'Feature' || raw?.type === 'Polygon' || raw?.type === 'MultiPolygon') {
    return { predio: { geometry: raw, polygonGeoJson: raw } };
  }
  return { predio: raw || {} };
}

function firstRingVertexCount(source) {
  const predio = source?.predio || {};
  const geometry = predio.geometry || predio.polygonGeoJson?.geometry || predio.polygonGeoJson || null;
  const coords =
    geometry?.type === 'Feature'
      ? geometry.geometry?.coordinates
      : geometry?.coordinates;

  const ring =
    geometry?.type === 'Polygon'
      ? coords?.[0]
      : geometry?.type === 'MultiPolygon'
        ? coords?.[0]?.[0]
        : geometry?.type === 'Feature' && geometry.geometry?.type === 'Polygon'
          ? geometry.geometry.coordinates?.[0]
          : geometry?.type === 'Feature' && geometry.geometry?.type === 'MultiPolygon'
            ? geometry.geometry.coordinates?.[0]?.[0]
            : null;

  return Array.isArray(ring) ? Math.max(0, ring.length - 1) : 0;
}

window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (url.includes('server.arcgisonline.com')) {
    return new Response(base64ToUint8Array(BLANK_PNG_BASE64), {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    });
  }
  return originalFetch(input, init);
};

async function main() {
  const inputUrl = readSearchParam('input');
  if (!inputUrl) {
    throw new Error('Falta el parámetro ?input= con la ruta JSON del predio.');
  }

  const raw = await fetch(inputUrl, { cache: 'no-store' }).then((response) => {
    if (!response.ok) {
      throw new Error(`No se pudo cargar el JSON del predio (${response.status}) desde ${inputUrl}`);
    }
    return response.json();
  });

  const source = coerceSource(raw);
  const predio = source.predio || {};
  const regressionSnapshot = buildCatastroXRegressionSnapshot(source);
  const debugSummary = await buildDeliverableDebugSummary(source);
  const kmlText = buildKmlText(source);
  const kmzBytes = buildKmzBytes(source);
  const shpZipBytes = buildShpZipBytes(source);

  let planPdfBytes = null;
  let diagnosticPdfBytes = null;
  let pdfError = null;

  try {
    planPdfBytes = await buildPlanPdfBytes(source);
    diagnosticPdfBytes = await buildDiagnosticPdfBytes(source);
  } catch (error) {
    pdfError = {
      message: error?.message || String(error),
      stack: error?.stack || null,
    };
  }

  const result = {
    ok: true,
    inputUrl,
    predioId: predio.id || null,
    codigoPredial: predio.codigoPredial || predio.codigo || predio.codigo_catastral || predio.id || null,
    municipality: predio.municipio || null,
    department: predio.departamento || null,
    ringVertices: firstRingVertexCount(source),
    debugSummary,
    regressionMetrics: regressionSnapshot.regressionMetrics,
    pdfGenerationSucceeded: Boolean(planPdfBytes),
    pdfError,
    artifacts: {
      pdfBytes: planPdfBytes ? planPdfBytes.length : 0,
      diagnosticPdfBytes: diagnosticPdfBytes ? diagnosticPdfBytes.length : 0,
      kmlBytes: kmlText.length,
      kmzBytes: kmzBytes.length,
      shpZipBytes: shpZipBytes.length,
      planPdfBase64: planPdfBytes ? base64FromUint8Array(planPdfBytes) : null,
      diagnosticPdfBase64: diagnosticPdfBytes ? base64FromUint8Array(diagnosticPdfBytes) : null,
      kmlBase64: btoa(unescape(encodeURIComponent(kmlText))),
      kmzBase64: base64FromUint8Array(kmzBytes),
      shpZipBase64: base64FromUint8Array(shpZipBytes),
    },
  };

  document.body.innerHTML = `<script id="result-json" type="application/json">${JSON.stringify(result)}</script>`;
}

main().catch((error) => {
  document.body.innerHTML = `<script id="result-json" type="application/json">${JSON.stringify({
    ok: false,
    fatal: {
      message: error?.message || String(error),
      stack: error?.stack || null,
    },
  })}</script>`;
});
