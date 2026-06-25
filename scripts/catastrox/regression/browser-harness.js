import {
  buildCatastroXRegressionSnapshot,
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

function buildPolygon(vertices) {
  const coordinates = vertices.map(([lng, lat]) => [lng, lat]);
  const [firstLng, firstLat] = coordinates[0];
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[...coordinates, [firstLng, firstLat]]],
    },
  };
}

function buildSimplePredio() {
  const polygon = buildPolygon([
    [-75.87211, 1.331245],
    [-75.869928, 1.332018],
    [-75.868744, 1.329917],
    [-75.871406, 1.328806],
  ]);

  return {
    id: 'albania-demo',
    estado: 'PREDIO_IDENTIFICADO',
    estadoLabel: 'Predio identificado',
    municipio: 'Albania',
    departamento: 'Caquetá',
    areaHa: 9.16,
    areaM2: 91588.88,
    perimetroM: 1468.75,
    codigoPredial: '180290001000000027001500000000',
    codigoAnterior: '18029000100279015000',
    estadoPredial: 'Predio individualizado en cartografía catastral pública.',
    verificacionPoligono: 'La vista preliminar coincide con la consulta de referencia y permite continuar con el diagnóstico predial.',
    recomendaciones: [
      'Conserve el diagnóstico para trámites, venta o validación interna.',
      'Verifique la información contra la entidad catastral competente antes de un acto jurídico.',
      'Solicite el plano predial si necesita soportar crédito, proyecto o negociación.',
    ],
    polygonGeoJson: polygon,
    geometry: polygon.geometry,
    linderos: [
      ['Lindero norte', '418.50 m'],
      ['Lindero oriental', '365.20 m'],
      ['Lindero sur', '401.45 m'],
      ['Lindero occidental', '283.60 m'],
    ],
    referencePoint: { lat: 1.331245, lng: -75.87211 },
    queryPoint: { lat: 1.331245, lng: -75.87211 },
  };
}

function buildIrregularPredio() {
  const vertices = [
    [-75.9052, 1.3552],
    [-75.9038, 1.3568],
    [-75.9011, 1.3574],
    [-75.8987, 1.3566],
    [-75.8964, 1.3571],
    [-75.8942, 1.3587],
    [-75.8925, 1.3581],
    [-75.8914, 1.3562],
    [-75.8901, 1.3551],
    [-75.8886, 1.3535],
    [-75.8892, 1.3519],
    [-75.8905, 1.3508],
    [-75.8929, 1.3504],
    [-75.8944, 1.3493],
    [-75.8968, 1.3489],
    [-75.8989, 1.3497],
    [-75.9008, 1.3501],
    [-75.9027, 1.3510],
    [-75.9043, 1.3522],
    [-75.9054, 1.3536],
  ];
  const polygon = buildPolygon(vertices);

  return {
    id: 'irregular-multi-vertex',
    routeId: 'irregular-multi-vertex',
    estado: 'PREDIO_IDENTIFICADO',
    estadoLabel: 'Predio identificado',
    municipio: 'Florencia',
    departamento: 'Caquetá',
    areaHa: 26.4,
    areaM2: 264000,
    perimetroM: 4285.6,
    codigoPredial: '180010001000000099999900000000',
    codigoAnterior: '18001000100999990000',
    estadoPredial: 'Predio de prueba irregular para validación del plano PDF.',
    verificacionPoligono: 'Caso sintético con múltiples quiebres y curvas suaves para validar simplificación visual.',
    recomendaciones: ['Caso técnico interno de validación.'],
    polygonGeoJson: polygon,
    geometry: polygon.geometry,
    queryPoint: { lat: 1.3539, lng: -75.8973 },
    referencePoint: { lat: 1.3539, lng: -75.8973 },
  };
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

async function runCase(name, predio) {
  const source = { predio };
  const snapshot = buildCatastroXRegressionSnapshot(source);
  const kmlText = buildKmlText(source);
  const kmzBytes = buildKmzBytes(source);
  const shpBytes = buildShpZipBytes(source);
  let pdfBytes = null;
  let pdfError = null;

  try {
    pdfBytes = await buildPlanPdfBytes(source);
  } catch (error) {
    pdfError = {
      message: error?.message || String(error),
      stack: error?.stack || null,
    };
  }

  return {
    name,
    predioId: predio.id,
    ringVertices: predio.polygonGeoJson.geometry.coordinates[0].length - 1,
    pdfBytes: pdfBytes ? pdfBytes.length : 0,
    kmlBytes: kmlText.length,
    kmzBytes: kmzBytes.length,
    shpZipBytes: shpBytes.length,
    regressionMetrics: snapshot.regressionMetrics,
    pdfGenerationSucceeded: Boolean(pdfBytes),
    pdfError,
    pdfBase64: pdfBytes ? base64FromUint8Array(pdfBytes) : null,
  };
}

async function main() {
  const cases = [
    await runCase('simple', buildSimplePredio()),
    await runCase('irregular', buildIrregularPredio()),
  ];

  document.body.innerHTML = `<script id="result-json" type="application/json">${JSON.stringify({
    ok: true,
    cases,
  })}</script>`;
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
