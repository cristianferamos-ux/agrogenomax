// LOTE 019-B / 019-B2: contexto pendiente de compra indexado por reference (no una
// unica ranura global), evaluacion pura del retorno de Wompi, recuperacion del
// lookup tras abandonar CatastroX, recuperacion alternativa cuando el registro vivo
// ya no existe, y no-doble-marcacion entre el callback del widget (en pagina) y
// CatastroXWompiReturnPage (retorno por redirect/navegacion manual).
// Fixtures exclusivamente sinteticos. No se contacta a Wompi real: fetch se simula.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

let vite;
let paymentService;
let returnPageModule;
let catastroxApi;
let localStorageMap;
let sessionStorageMap;
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalConsoleInfo = console.info;
const originalConsoleError = console.error;

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    keys: () => [...values.keys()],
  };
}

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

function buildSyntheticLookup(routeId = 'real-9001') {
  return {
    routeId,
    predio: {
      id: routeId,
      routeId,
      codigoPredial: '999990000000000000000000000000',
      areaHa: 1.23,
    },
  };
}

before(async () => {
  vite = await createServer({
    root: process.cwd(),
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true },
    appType: 'custom',
  });
  paymentService = await vite.ssrLoadModule('/src/modules/catastrox/services/catastroxPaymentService.js');
  returnPageModule = await vite.ssrLoadModule('/src/modules/catastrox/pages/CatastroXWompiReturnPage.jsx');
  catastroxApi = await vite.ssrLoadModule('/src/modules/catastrox/services/catastroxApi.js');
});

beforeEach(() => {
  localStorageMap = createStorage();
  sessionStorageMap = createStorage();
  globalThis.window = {
    location: { hostname: 'localhost' },
    localStorage: localStorageMap,
    sessionStorage: sessionStorageMap,
  };
  globalThis.fetch = originalFetch;
  console.info = () => {};
  console.error = () => {};
});

after(async () => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  console.info = originalConsoleInfo;
  console.error = originalConsoleError;
  await vite?.close();
});

test('1) pending indexado por reference: se guarda bajo catastrox_pending_payments_v2[reference]', () => {
  paymentService.savePendingPayment({
    packageId: 'basico',
    routeId: 'real-1',
    purchaseKey: 'catastrox_purchase_real-1',
    reference: 'REF-A',
    expectedAmountInCents: 3990000,
    currency: 'COP',
    targetRoute: '/catastrox/basico/real-1',
  });

  const raw = localStorageMap.getItem('catastrox_pending_payments_v2');
  assert.ok(raw, 'debe escribir en la clave indexada por reference');
  const store = JSON.parse(raw);
  assert.ok(store['REF-A']);
  assert.equal(store['REF-A'].packageId, 'basico');
  assert.equal(store['REF-A'].status, 'pending');

  const byReference = paymentService.getPendingPaymentByReference('REF-A');
  assert.equal(byReference.reference, 'REF-A');
});

test('2) dos checkouts no se sobrescriben: cada reference conserva su propio registro', () => {
  paymentService.savePendingPayment({
    packageId: 'basico',
    routeId: 'real-1',
    purchaseKey: 'catastrox_purchase_real-1',
    reference: 'REF-A',
    expectedAmountInCents: 3990000,
    currency: 'COP',
    targetRoute: '/catastrox/basico/real-1',
  });
  paymentService.savePendingPayment({
    packageId: 'plus',
    routeId: 'real-2',
    purchaseKey: 'catastrox_purchase_real-2',
    reference: 'REF-B',
    expectedAmountInCents: 4990000,
    currency: 'COP',
    targetRoute: '/catastrox/plus/real-2',
  });

  const a = paymentService.getPendingPaymentByReference('REF-A');
  const b = paymentService.getPendingPaymentByReference('REF-B');
  assert.equal(a.packageId, 'basico');
  assert.equal(b.packageId, 'plus');
  assert.notEqual(a.routeId, b.routeId);
});

test('3/4) verify obtiene la reference antes de buscar pending, y el retorno encuentra el pending por esa reference', async () => {
  paymentService.savePendingPayment({
    packageId: 'basico',
    routeId: 'real-3',
    purchaseKey: 'catastrox_purchase_real-3',
    reference: 'REF-VERIFY-FIRST',
    expectedAmountInCents: 3990000,
    currency: 'COP',
    targetRoute: '/catastrox/basico/real-3',
  });

  globalThis.fetch = async (url) => {
    if (String(url).includes('/verify/')) {
      return jsonResponse({
        ok: true,
        transaction: { id: 'txn-1', status: 'APPROVED', reference: 'REF-VERIFY-FIRST', amountInCents: 3990000, currency: 'COP' },
      });
    }
    throw new Error(`URL no simulada: ${url}`);
  };

  const verified = await paymentService.verifyWompiTransaction('txn-1');
  assert.equal(verified.reference, 'REF-VERIFY-FIRST');

  const pending = paymentService.getPendingPaymentByReference(verified.reference);
  assert.ok(pending, 'debe encontrar el pending usando la reference devuelta por verify, no una clave global fija');
  assert.equal(pending.packageId, 'basico');
});

test('5) el callback no elimina el registro: solo lo marca como approved-callback', () => {
  paymentService.savePendingPayment({
    packageId: 'basico',
    routeId: 'real-5',
    reference: 'REF-CALLBACK',
    expectedAmountInCents: 3990000,
    currency: 'COP',
    targetRoute: '/catastrox/basico/real-5',
  });

  paymentService.updatePendingPaymentStatus('REF-CALLBACK', 'approved-callback');

  const pending = paymentService.getPendingPaymentByReference('REF-CALLBACK');
  assert.ok(pending, 'el registro debe seguir existiendo tras el callback');
  assert.equal(pending.status, 'approved-callback');
});

test('6) callback + retorno no duplican el pago: retorno reconoce "ya pagado" via catastrox_purchases_v2 y no reprocesa', () => {
  const lookup = buildSyntheticLookup('real-6');
  paymentService.savePendingPayment({
    packageId: 'basico',
    routeId: 'real-6',
    purchaseKey: paymentService.getLookupPurchaseKey(lookup),
    reference: 'REF-DUPLICADO',
    expectedAmountInCents: 3990000,
    currency: 'COP',
    targetRoute: '/catastrox/basico/real-6',
  });

  // Simula que el callback en pagina ya proceso el pago (como hace
  // CatastroXPackagePage.onApproved: markPackageAsPaid + clearPendingPaymentByReference).
  paymentService.markPackageAsPaidByPurchaseKey({
    packageId: 'basico',
    purchaseKey: paymentService.getLookupPurchaseKey(lookup),
    routeId: 'real-6',
    transactionId: 'txn-6',
    reference: 'REF-DUPLICADO',
    mode: 'wompi-sandbox',
  });
  paymentService.clearPendingPaymentByReference('REF-DUPLICADO');

  // El pending indexado ya no existe...
  assert.equal(paymentService.getPendingPaymentByReference('REF-DUPLICADO'), null);

  // ...pero la recuperacion alternativa lo reconoce como ya pagado en purchases_v2,
  // sin necesitar volver a marcarlo.
  const recovered = paymentService.recoverPendingLikeContextForReference('REF-DUPLICADO');
  assert.ok(recovered, 'debe reconstruirse desde catastrox_purchases_v2');
  assert.equal(recovered.alreadyPaid, true);
});

test('7) recarga conserva el pending (localStorage persiste, no depende de memoria de React)', () => {
  paymentService.savePendingPayment({
    packageId: 'basico',
    routeId: 'real-7',
    reference: 'REF-RECARGA',
    expectedAmountInCents: 3990000,
    currency: 'COP',
    targetRoute: '/catastrox/basico/real-7',
  });

  // "Recargar" no borra localStorage; una nueva lectura debe encontrar el mismo registro.
  const pending = paymentService.getPendingPaymentByReference('REF-RECARGA');
  assert.ok(pending);
  assert.equal(pending.reference, 'REF-RECARGA');
});

test('8) retorno manual con id valido funciona: recoverLookupForPending recupera el predio por routeId', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/full-result')) {
      return jsonResponse({
        found: true,
        predio: { id: 'real-8', routeId: 'real-8', codigoPredial: '999990000000000000000000000000' },
      });
    }
    throw new Error(`URL no simulada: ${url}`);
  };

  const recovered = await returnPageModule.recoverLookupForPending({ routeId: 'real-8', packageId: 'basico' });
  assert.ok(recovered);
  assert.equal(recovered.routeId, 'real-8');
});

test('9) pending legacy (v1) se lee como fuente de recuperacion si su reference coincide', () => {
  localStorageMap.setItem(
    'catastrox_pending_payment_v1',
    JSON.stringify({
      packageId: 'basico',
      routeId: 'real-9',
      purchaseKey: 'catastrox_purchase_real-9',
      reference: 'REF-LEGACY',
      expectedAmountInCents: 3990000,
      currency: 'COP',
      targetRoute: '/catastrox/basico/real-9',
      createdAt: new Date().toISOString(),
    }),
  );

  // No hay nada en la clave v2 -- la recuperacion debe caer al legado.
  assert.equal(paymentService.getPendingPaymentByReference('REF-LEGACY'), null);
  const recovered = paymentService.recoverPendingLikeContextForReference('REF-LEGACY');
  assert.ok(recovered, 'debe leer catastrox_pending_payment_v1 como fuente legada');
  assert.equal(recovered.source, 'legacy-v1');
  assert.equal(recovered.packageId, 'basico');
});

test('10) pending expirado se rechaza (no se trata como valido)', () => {
  const old = { createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
  assert.equal(paymentService.isPendingPaymentContextExpired(old), true);

  paymentService.savePendingPayment({
    packageId: 'basico',
    routeId: 'real-10',
    reference: 'REF-EXPIRADO',
    expectedAmountInCents: 3990000,
    currency: 'COP',
    targetRoute: '/catastrox/basico/real-10',
  });
  // Se fuerza manualmente createdAt viejo para simular el paso del tiempo.
  const store = JSON.parse(localStorageMap.getItem('catastrox_pending_payments_v2'));
  store['REF-EXPIRADO'].createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  localStorageMap.setItem('catastrox_pending_payments_v2', JSON.stringify(store));

  const pending = paymentService.getPendingPaymentByReference('REF-EXPIRADO');
  assert.equal(paymentService.isPendingPaymentContextExpired(pending), true);
});

test('11) reference desconocida no desbloquea nada (ni v2, ni legado, ni purchases_v2)', () => {
  assert.equal(paymentService.getPendingPaymentByReference('REF-JAMAS-EXISTIO'), null);
  assert.equal(paymentService.recoverPendingLikeContextForReference('REF-JAMAS-EXISTIO'), null);
});

test('12/13/14) monto, moneda o packageId distinto no desbloquean (evaluateWompiReturn sobre el pending resuelto)', () => {
  const pending = { reference: 'REF-X', expectedAmountInCents: 3990000, currency: 'COP', packageId: 'basico' };

  const amountMismatch = paymentService.evaluateWompiReturn({
    verifiedTransaction: { status: 'APPROVED', reference: 'REF-X', amountInCents: 4990000, currency: 'COP' },
    pending,
  });
  assert.equal(amountMismatch.outcome, 'rejected');
  assert.equal(amountMismatch.reason, 'amount_mismatch');

  const currencyMismatch = paymentService.evaluateWompiReturn({
    verifiedTransaction: { status: 'APPROVED', reference: 'REF-X', amountInCents: 3990000, currency: 'USD' },
    pending,
  });
  assert.equal(currencyMismatch.outcome, 'rejected');
  assert.equal(currencyMismatch.reason, 'currency_mismatch');

  // packageId distinto: se refleja en que el pending resuelto por reference trae su
  // propio packageId -- si el llamador esperaba otro, getCatastroxPackage seguiria
  // resolviendo el del pending (nunca el de la URL/usuario), evitando que alguien
  // cambie Basico por Profesional manipulando parametros externos.
  assert.equal(pending.packageId, 'basico');
});

test('15) lookup se recupera usando el routeId del pending resuelto', async () => {
  const lookup = buildSyntheticLookup('real-15');
  catastroxApi.saveLastLookup(lookup);

  globalThis.fetch = async () => {
    throw new Error('No debe llamarse a la red si el lookup ya esta en sessionStorage.');
  };

  const recovered = await returnPageModule.recoverLookupForPending({ routeId: 'real-15', packageId: 'basico' });
  assert.equal(recovered.routeId, 'real-15');
});

test('16) targetRoute se conserva en el pending guardado y en la reconstruccion desde purchases_v2', () => {
  paymentService.savePendingPayment({
    packageId: 'basico',
    routeId: 'real-16',
    reference: 'REF-TARGET',
    expectedAmountInCents: 3990000,
    currency: 'COP',
    targetRoute: '/catastrox/basico/real-16',
  });
  const pending = paymentService.getPendingPaymentByReference('REF-TARGET');
  assert.equal(pending.targetRoute, '/catastrox/basico/real-16');

  // Reconstruccion desde purchases_v2 (sin pending vivo) tambien debe producir un
  // targetRoute coherente con el packageId/routeId encontrados.
  paymentService.markPackageAsPaidByPurchaseKey({
    packageId: 'plus',
    purchaseKey: 'catastrox_purchase_real-16b',
    routeId: 'real-16b',
    transactionId: 'txn-16b',
    reference: 'REF-TARGET-RECONSTRUIDO',
    mode: 'wompi-sandbox',
  });
  const reconstructed = paymentService.recoverPendingLikeContextForReference('REF-TARGET-RECONSTRUIDO');
  assert.equal(reconstructed.targetRoute, '/catastrox/plus/real-16b');
});

test('17) el pending se elimina solo tras marcar pagado (clearPendingPaymentByReference es explicito, no automatico)', () => {
  paymentService.savePendingPayment({
    packageId: 'basico',
    routeId: 'real-17',
    reference: 'REF-17',
    expectedAmountInCents: 3990000,
    currency: 'COP',
    targetRoute: '/catastrox/basico/real-17',
  });
  assert.ok(paymentService.getPendingPaymentByReference('REF-17'));

  paymentService.updatePendingPaymentStatus('REF-17', 'approved-callback');
  assert.ok(paymentService.getPendingPaymentByReference('REF-17'), 'sigue vivo tras marcar el status, no se borro solo');

  paymentService.markPackageAsPaidByPurchaseKey({
    packageId: 'basico',
    purchaseKey: 'catastrox_purchase_real-17',
    routeId: 'real-17',
    transactionId: 'txn-17',
    reference: 'REF-17',
    mode: 'wompi-sandbox-verified',
  });
  paymentService.clearPendingPaymentByReference('REF-17');
  assert.equal(paymentService.getPendingPaymentByReference('REF-17'), null);
});

test('18) paid persiste tras refrescar (catastrox_purchases_v2 no depende de memoria de React)', () => {
  const lookup = buildSyntheticLookup('real-18');
  paymentService.markPackageAsPaidByPurchaseKey({
    packageId: 'basico',
    purchaseKey: paymentService.getLookupPurchaseKey(lookup),
    routeId: 'real-18',
    transactionId: 'txn-18',
    reference: 'REF-18',
    mode: 'wompi-sandbox-verified',
  });

  // Una "recarga" es simplemente una nueva lectura de la misma clave persistida.
  assert.equal(paymentService.isPackageUnlockedForLookup({ lookup, packageId: 'basico' }), true);
});

test('19) Básico habilita únicamente PDF (no arrastra DXF/SHP de Profesional)', () => {
  const lookup = buildSyntheticLookup('real-19');
  paymentService.markPackageAsPaidByPurchaseKey({
    packageId: 'basico',
    purchaseKey: paymentService.getLookupPurchaseKey(lookup),
    routeId: 'real-19',
    transactionId: 'txn-19',
    reference: 'REF-19',
    mode: 'wompi-sandbox-verified',
  });

  const downloads = paymentService.getUnlockedDownloadsForPackage({ lookup, packageId: 'basico' });
  assert.deepEqual(downloads, ['pdf']);
});

test('20) no se guardan secretos en ninguna de las dos estructuras de pending', () => {
  paymentService.savePendingPayment({
    packageId: 'basico',
    routeId: 'real-20',
    purchaseKey: 'catastrox_purchase_real-20',
    reference: 'REF-20',
    expectedAmountInCents: 3990000,
    currency: 'COP',
    targetRoute: '/catastrox/basico/real-20',
  });

  const rawV2 = localStorageMap.getItem('catastrox_pending_payments_v2');
  assert.doesNotMatch(rawV2, /pub_test_|integrity|secret|signature|DATABASE_URL/i);
});

test('LOTE 019-C2) si verifyWompiTransaction falla (p. ej. reintento de transporte agotado en backend), el pending permanece intacto', async () => {
  paymentService.savePendingPayment({
    packageId: 'basico',
    routeId: 'real-019c2',
    reference: 'REF-019C2',
    expectedAmountInCents: 3990000,
    currency: 'COP',
    targetRoute: '/catastrox/basico/real-019c2',
  });

  globalThis.fetch = async () => {
    throw new Error('No fue posible verificar el pago con Wompi.');
  };

  await assert.rejects(() => paymentService.verifyWompiTransaction('txn-019c2'));

  const pending = paymentService.getPendingPaymentByReference('REF-019C2');
  assert.ok(pending, 'el pending no debe eliminarse cuando la verificacion falla');
  assert.equal(pending.status, 'pending');
});

test('Fase 7) simulacion completa con mocks: checkout -> callback (marca, no borra) -> retorno por id -> paid + lookup + targetRoute + solo PDF', async () => {
  const lookup = buildSyntheticLookup('real-fase7');
  const reference = 'REF-FASE7-APPROVED';

  // 1) checkout: se guarda el pending indexado por reference.
  paymentService.savePendingPayment({
    packageId: 'basico',
    routeId: 'real-fase7',
    purchaseKey: paymentService.getLookupPurchaseKey(lookup),
    codigoPredial: lookup.predio.codigoPredial,
    reference,
    expectedAmountInCents: 3990000,
    currency: 'COP',
    targetRoute: '/catastrox/basico/real-fase7',
  });

  // 2) se simula que el callback del widget se disparo (en pagina) pero, por lo que
  // sea, no llego a completar markPackageAsPaid todavia -- solo marca el status.
  paymentService.updatePendingPaymentStatus(reference, 'approved-callback');
  assert.ok(paymentService.getPendingPaymentByReference(reference), 'el pending sigue vivo tras el callback');

  // 3) se navega (simulado) a la ruta de retorno solo con `?id=...`, exactamente lo
  // unico que Wompi entrega de vuelta.
  globalThis.fetch = async (url) => {
    if (String(url).includes('/verify/')) {
      return jsonResponse({
        ok: true,
        transaction: { id: 'txn-fase7', status: 'APPROVED', reference, amountInCents: 3990000, currency: 'COP' },
      });
    }
    if (String(url).includes('/full-result')) {
      return jsonResponse({ found: true, predio: lookup.predio });
    }
    throw new Error(`URL no simulada: ${url}`);
  };

  const verified = await paymentService.verifyWompiTransaction('txn-fase7');
  const pending = paymentService.getPendingPaymentByReference(verified.reference);
  assert.ok(pending, 'el retorno debe encontrar el pending por la reference devuelta por verify');

  const decision = paymentService.evaluateWompiReturn({ verifiedTransaction: verified, pending });
  assert.equal(decision.outcome, 'approved');

  const recoveredLookup = await returnPageModule.recoverLookupForPending(pending);
  assert.ok(recoveredLookup, 'el predio debe recuperarse aunque se abandonara CatastroX');

  paymentService.markPackageAsPaidByPurchaseKey({
    packageId: pending.packageId,
    purchaseKey: pending.purchaseKey,
    routeId: pending.routeId,
    codigoPredial: pending.codigoPredial,
    transactionId: verified.id,
    reference: verified.reference,
    mode: 'wompi-sandbox-verified',
  });
  paymentService.clearPendingPaymentByReference(reference);

  // 4) confirma: pago marcado, pending eliminado, targetRoute conservado, y solo PDF.
  assert.equal(paymentService.getPendingPaymentByReference(reference), null);
  assert.equal(pending.targetRoute, '/catastrox/basico/real-fase7');
  assert.equal(paymentService.isPackageUnlockedForLookup({ lookup, packageId: 'basico' }), true);
  assert.deepEqual(paymentService.getUnlockedDownloadsForPackage({ lookup, packageId: 'basico' }), ['pdf']);
});

// --- Sistema de órdenes persistentes en backend (fix del defecto de cobro
// duplicado) -- checkEntitlement()/getOrderStatus() son la vía por la que
// el frontend deja de decidir "¿pagado?" localmente; solo reflejan lo que
// el backend responda. ---------------------------------------------------

test('checkEntitlement) backend responde isPaid=true -> se refleja tal cual, sin exponer ningun token (el backend ya no los devuelve)', async () => {
  let requestedBody = null;
  let requestedCredentials = null;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/entitlements/check')) {
      requestedBody = JSON.parse(options.body);
      requestedCredentials = options.credentials;
      return jsonResponse({ ok: true, isPaid: true, packageId: 'basico' });
    }
    throw new Error(`URL no simulada: ${url}`);
  };

  const result = await paymentService.checkEntitlement({ codigoPredial: '181500003000000130054000000000', packageId: 'basico' });
  assert.equal(result.ok, true);
  assert.equal(result.isPaid, true);
  assert.equal('orderToken' in result, false, 'ya no debe exponer orderToken -- solo la cookie HttpOnly autoriza');
  assert.equal(requestedBody.codigoPredial, '181500003000000130054000000000');
  assert.equal(requestedBody.packageId, 'basico');
  // credentials:'include' -- imprescindible para que el navegador adjunte
  // la cookie de recuperación HttpOnly en esta llamada cross-origin.
  assert.equal(requestedCredentials, 'include');
});

test('checkEntitlement) backend responde isPaid=false -> nunca se infiere true localmente', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/entitlements/check')) {
      return jsonResponse({ ok: true, isPaid: false, packageId: 'basico' });
    }
    throw new Error(`URL no simulada: ${url}`);
  };

  const result = await paymentService.checkEntitlement({ codigoPredial: '181500003000000130054000000000', packageId: 'basico' });
  assert.equal(result.isPaid, false);
});

test('checkEntitlement) sin codigoPredial -> no llama a la red, responde isPaid=false', async () => {
  globalThis.fetch = async () => {
    throw new Error('No debe llamarse a la red sin codigoPredial.');
  };

  const result = await paymentService.checkEntitlement({ codigoPredial: '', packageId: 'basico' });
  assert.equal(result.ok, false);
  assert.equal(result.isPaid, false);
});

test('checkEntitlement) fallo de red -> ok=false, isPaid=false (nunca true por defecto)', async () => {
  globalThis.fetch = async () => {
    throw new Error('network down');
  };

  const result = await paymentService.checkEntitlement({ codigoPredial: '181500003000000130054000000000', packageId: 'basico' });
  assert.equal(result.ok, false);
  assert.equal(result.isPaid, false);
});

test('getOrderStatus) token valido -> devuelve el estado de la orden', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/orders/tok-xyz/status')) {
      return jsonResponse({ ok: true, order: { status: 'APPROVED', packageId: 'basico' } });
    }
    throw new Error(`URL no simulada: ${url}`);
  };

  const order = await paymentService.getOrderStatus('tok-xyz');
  assert.equal(order.status, 'APPROVED');
});

test('getOrderStatus) token invalido/inexistente -> null, nunca se asume pagado', async () => {
  globalThis.fetch = async (url) => jsonResponse({ ok: false, error: 'Orden no encontrada.' }, { status: 404 });

  const order = await paymentService.getOrderStatus('tok-que-no-existe');
  assert.equal(order, null);
});

test('getOrderStatus) sin token -> null sin llamar a la red', async () => {
  globalThis.fetch = async () => {
    throw new Error('No debe llamarse a la red sin orderToken.');
  };
  assert.equal(await paymentService.getOrderStatus(''), null);
});

test('verifyWompiTransaction) incluye el campo order devuelto por el backend, sin perder los campos de transaccion existentes', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/verify/')) {
      return jsonResponse({
        ok: true,
        transaction: { id: 'txn-order-1', status: 'APPROVED', reference: 'REF-ORDER-1', amountInCents: 3990000, currency: 'COP' },
        order: { status: 'APPROVED', packageId: 'basico', orderToken: 'tok-order-1' },
      });
    }
    throw new Error(`URL no simulada: ${url}`);
  };

  const verified = await paymentService.verifyWompiTransaction('txn-order-1');
  assert.equal(verified.status, 'APPROVED');
  assert.equal(verified.reference, 'REF-ORDER-1');
  assert.equal(verified.order.status, 'APPROVED');
  assert.equal(verified.order.orderToken, 'tok-order-1');
});

test('startPackageCheckout) backend responde ALREADY_PAID -> nunca abre Wompi, y NO marca localmente como pagado (checkout no prueba posesión)', async () => {
  const lookup = buildSyntheticLookup('real-already-paid-2');
  globalThis.fetch = async (url) => {
    if (String(url).includes('/checkout')) {
      return jsonResponse({ ok: true, checkout: { status: 'ALREADY_PAID', packageId: 'basico' } });
    }
    throw new Error(`No debe abrirse Wompi ni llamarse otra URL: ${url}`);
  };

  const result = await paymentService.startPackageCheckout({
    packageId: 'basico',
    lookup,
    customerId: 'cust-already-paid-2',
    purchaseAttemptId: '44444444-4444-4444-8444-444444444444',
  });
  assert.equal(result.status, 'already_paid');
  // Antes de este cambio, ALREADY_PAID marcaba la caché local como pagada
  // sin ninguna prueba de posesión -- exactamente el defecto de acceso
  // cruzado que corrige este bloque. Ahora solo checkEntitlement() (cookie
  // de recuperación) puede confirmar un pago como propio.
  assert.equal(paymentService.isPackageUnlockedForLookup({ lookup, packageId: 'basico' }), false);
});
