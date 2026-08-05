// CATX-DELIVERABLE-CANONICAL-001: pruebas arquitectónicas (análisis de
// texto fuente, no en tiempo de ejecución) que garantizan que "Descargas
// habilitadas" (CatastroXPackagePage.jsx), "Mis compras"
// (CatastroXMyPurchases.jsx) y "Entrega y facturación"
// (CatastroXWompiReturnPage.jsx) descargan el mismo blob oficial del
// backend -- mismo patrón ya usado en este repositorio para invariantes
// estructurales (ver server/__tests__/architecture/noSrcImports.test.js).
// No se monta ningún componente (CatastroXPackagePage.jsx importa
// leaflet, que exige un DOM completo para cargar -- ver
// catastroxDeliverableDownload.js) -- se analiza el código fuente
// directamente como texto.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  executeCatastroxPackageDownloadDecision,
  resolveDeliverableOrderTokenForPredio,
} from '../../utils/catastroxDeliverableDownload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = path.resolve(__dirname, '..');
const COMPONENTS_DIR = path.resolve(PAGES_DIR, '..', 'components');

const packagePageSource = fs.readFileSync(path.join(PAGES_DIR, 'CatastroXPackagePage.jsx'), 'utf8');
const myPurchasesSource = fs.readFileSync(path.join(COMPONENTS_DIR, 'CatastroXMyPurchases.jsx'), 'utf8');
const returnPageSource = fs.readFileSync(path.join(PAGES_DIR, 'CatastroXWompiReturnPage.jsx'), 'utf8');

test('las 3 vistas (Descargas habilitadas, Mis compras, Entrega y facturación) importan downloadDeliverablePdf desde el mismo módulo', () => {
  const importPattern = /import\s*\{[^}]*\bdownloadDeliverablePdf\b[^}]*\}\s*from\s*['"]([^'"]+)['"]/;
  [
    ['CatastroXPackagePage.jsx', packagePageSource],
    ['CatastroXMyPurchases.jsx', myPurchasesSource],
    ['CatastroXWompiReturnPage.jsx', returnPageSource],
  ].forEach(([name, source]) => {
    const match = source.match(importPattern);
    assert.ok(match, `${name} debe importar downloadDeliverablePdf`);
    assert.equal(match[1], '../services/catastroxPaymentService.js', `${name}: mismo módulo que las otras dos vistas`);
  });
});

test('CatastroXPackagePage.jsx enruta el botón "Descargar PDF" de una compra real hacia el endpoint oficial, nunca hacia downloadPlanPdf', () => {
  assert.ok(
    packagePageSource.includes('shouldUseOfficialPdfDownload({ fileType, useAuditEndpoint })'),
    'debe existir el chequeo que decide usar el endpoint oficial para una compra real',
  );
  assert.ok(
    packagePageSource.includes('executeCatastroxPackageDownloadDecision({'),
    'el camino de compra real debe invocar la decisión funcional que llama al handler oficial, no `action` (downloadPlanPdf)',
  );
  assert.ok(
    packagePageSource.includes('await downloadDeliverablePdf(deliverableOrderToken)'),
    'handleOfficialPdfDownload debe llamar a downloadDeliverablePdf con el orderToken real',
  );
});

test('clic funcional de PDF oficial: compra real APPROVED usa downloadDeliverablePdf con token compatible y nunca downloadPlanPdf', async () => {
  const codigoPredial = '184600002000000030015000000000';
  const orders = [
    { orderToken: 'tok-basico', packageId: 'basico', codigoPredial, paymentStatus: 'APPROVED' },
    { orderToken: 'tok-plus', packageId: 'plus', codigoPredial, paymentStatus: 'APPROVED' },
    { orderToken: 'tok-otro-predio', packageId: 'profesional', codigoPredial: '999', paymentStatus: 'APPROVED' },
  ];
  const deliverableOrderToken = resolveDeliverableOrderTokenForPredio({
    orders,
    codigoPredial,
    requiredPackageId: 'plus',
  });

  const calls = { official: [], local: 0 };
  const result = await executeCatastroxPackageDownloadDecision({
    fileType: 'pdf',
    useAuditEndpoint: false,
    deliverableOrderToken,
    officialDownload: async (token) => {
      calls.official.push(token);
      return { ok: true };
    },
    localDownload: async () => {
      calls.local += 1;
      return { ok: true };
    },
  });

  assert.equal(deliverableOrderToken, 'tok-plus');
  assert.equal(result.mode, 'official');
  assert.deepEqual(calls.official, ['tok-plus']);
  assert.equal(calls.local, 0, 'downloadPlanPdf/localDownload nunca debe ejecutarse en compra real');
});

test('CatastroXPackagePage.jsx rehidrata el orderToken cuando cambia packageId y limpia el token anterior', () => {
  assert.ok(
    packagePageSource.includes('setDeliverableOrderToken(null);') &&
      packagePageSource.includes('setPdfDownloadState({});'),
    'el efecto debe limpiar token y errores antes de resolver otra orden',
  );
  assert.ok(
    packagePageSource.includes('[isPaid, isAuditUnlocked, packageId, predio.codigoPredial, predio.codigo]'),
    'packageId debe estar en las dependencias del efecto de deliverableOrderToken',
  );
});

test('downloadPlanPdf (generador rasterizado de navegador) sigue existiendo únicamente como acción del botón PDF -- pero solo se alcanza en modo auditoría', () => {
  // DOWNLOAD_BUTTONS.pdf.action = downloadPlanPdf sigue presente (modo
  // auditoría no tiene orden real, ver catastroxDeliverables.js) -- lo que
  // esta prueba garantiza es que el camino de COMPRA REAL nunca llega a
  // invocarlo (cubierto por la prueba anterior).
  assert.ok(packagePageSource.includes('action: downloadPlanPdf'), 'downloadPlanPdf debe seguir registrado como acción (modo auditoría)');
});

test('CatastroXMyPurchases.jsx (referencia ya correcta) también descarga vía downloadDeliverablePdf(orderToken), nunca genera un PDF en el navegador', () => {
  assert.ok(myPurchasesSource.includes('downloadDeliverablePdf(orderToken)'));
  assert.ok(!myPurchasesSource.includes('downloadPlanPdf'), 'Mis compras nunca debe importar el generador rasterizado');
});

test('CatastroXWompiReturnPage.jsx (Entrega y facturación) también descarga vía downloadDeliverablePdf, nunca genera un PDF en el navegador', () => {
  assert.ok(returnPageSource.includes('downloadDeliverablePdf(state.orderToken)'));
  assert.ok(!returnPageSource.includes('downloadPlanPdf'), 'Entrega y facturación nunca debe importar el generador rasterizado');
});
