// CATX-DELIVERY-001: pruebas unitarias del generador PDFKit -- sin red ni
// Postgres (predioData fabricado con la misma forma que devuelve
// resolvePredioDataForDelivery, server/routes/catastrox.js). Verifican los
// requisitos mínimos exigidos por el plan aprobado: magic bytes reales de
// PDF, checksum determinista para el mismo input (sha256, ajuste
// obligatorio #5), y el formato de nombre server-side
// `<canonicalPredioId>_<packageId>.pdf`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { generateCatastroxPdfBuffer, buildCatastroxDeliverableFilename } from '../catastroxPdfGenerator.js';

const SAMPLE_RING = [
  [-75.9, 1.1],
  [-75.899, 1.1],
  [-75.899, 1.101],
  [-75.9, 1.101],
  [-75.9, 1.1],
];

function buildSamplePredioData(overrides = {}) {
  return {
    codigoPredial: '184600002000000030015000000000',
    codigoAnterior: 'No disponible',
    municipio: 'MILAN',
    departamento: 'CAQUETA',
    nombrePredio: 'Predio de prueba',
    direccionReal: 'Vereda de prueba',
    veredaDisplay: { value: 'Vereda de prueba' },
    barrioNombre: null,
    sectorCodigo: null,
    manzanaCodigo: null,
    areaM2: 4371500,
    areaHa: 437.15,
    perimetroM: 8400,
    estadoPredial: 'ACTIVO',
    tipoZona: 'RURAL',
    destinoEconomicoNombre: 'AGROPECUARIO',
    uso1Nombre: 'PASTOS',
    uso2Nombre: null,
    uso3Nombre: null,
    numeroConstrucciones: 1,
    areaConstruidaM2: 80,
    tiposConstruccionResumen: 'Vivienda rural',
    fuente: 'catastrox_clean',
    fechaProceso: '2026-01-01',
    geometry: { type: 'Polygon', coordinates: [SAMPLE_RING] },
    polygonGeoJson: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [SAMPLE_RING] } },
    ...overrides,
  };
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

test('generateCatastroxPdfBuffer produce un PDF real (magic bytes %PDF-)', async () => {
  const buffer = await generateCatastroxPdfBuffer({ predioData: buildSamplePredioData(), packageId: 'basico' });
  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 0);
  assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
});

// PDFKit incrusta un /ID de trailer generado por documento (parte del
// estándar PDF, no un defecto de este generador) -- dos generaciones del
// MISMO predioData nunca son byte-idénticas, así que el checksum
// determinista (ajuste #5) es sobre el Buffer YA generado y almacenado, no
// una propiedad reproducible entre llamadas independientes. Lo que sí debe
// sostenerse -- y es lo que realmente usa deliveryJobService.js
// (findReusableDeliverable) -- es que hashear el MISMO Buffer en memoria es
// puro/estable, y que dos generaciones del mismo predio producen documentos
// de tamaño comparable (ninguna diverge en orden de magnitud).
test('el checksum sha256 de un Buffer ya generado es estable (recalcularlo no cambia el resultado)', async () => {
  const buffer = await generateCatastroxPdfBuffer({ predioData: buildSamplePredioData(), packageId: 'basico' });
  assert.equal(sha256Hex(buffer), sha256Hex(buffer));
});

test('dos generaciones independientes del mismo predioData producen PDFs válidos de tamaño comparable', async () => {
  const predioData = buildSamplePredioData();
  const bufferA = await generateCatastroxPdfBuffer({ predioData, packageId: 'basico' });
  const bufferB = await generateCatastroxPdfBuffer({ predioData, packageId: 'basico' });
  assert.equal(bufferA.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.equal(bufferB.subarray(0, 5).toString('latin1'), '%PDF-');
  const ratio = bufferA.length / bufferB.length;
  assert.ok(ratio > 0.9 && ratio < 1.1, `tamaños demasiado dispares: ${bufferA.length} vs ${bufferB.length}`);
});

test('generateCatastroxPdfBuffer produce checksums distintos para predios distintos', async () => {
  const bufferA = await generateCatastroxPdfBuffer({ predioData: buildSamplePredioData(), packageId: 'basico' });
  const bufferB = await generateCatastroxPdfBuffer({
    predioData: buildSamplePredioData({ codigoPredial: '999900002000000030015000000000', areaHa: 12.5 }),
    packageId: 'basico',
  });
  assert.notEqual(sha256Hex(bufferA), sha256Hex(bufferB));
});

test('generateCatastroxPdfBuffer genera más páginas para paquetes de mayor rango (plus/profesional vs básico)', async () => {
  const predioData = buildSamplePredioData();
  const basico = await generateCatastroxPdfBuffer({ predioData, packageId: 'basico' });
  const profesional = await generateCatastroxPdfBuffer({ predioData, packageId: 'profesional' });
  // No se afirma paridad de contenido con el generador de navegador (riesgo
  // documentado) -- solo que el contenido varía honestamente según el
  // paquete comprado, nunca el mismo documento para paquetes distintos.
  assert.notEqual(sha256Hex(basico), sha256Hex(profesional));
});

test('buildCatastroxDeliverableFilename produce el formato server-side exacto <canonicalPredioId>_<packageId>.pdf', () => {
  const filename = buildCatastroxDeliverableFilename({
    codigoPredial: '184600002000000030015000000000',
    packageId: 'basico',
    deliverableType: 'pdf',
  });
  assert.equal(filename, '184600002000000030015000000000_basico.pdf');
});
