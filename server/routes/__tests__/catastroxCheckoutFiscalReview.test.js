// CATX-FISCAL-PROTECTION-001: pruebas puras (sin Postgres, sin red real)
// de la lógica que decide si un predio requiere revisión especializada
// antes de comprar -- tanto en el checkout (control autoritativo) como en
// el lookup gratuito (señal temprana para la UI). Ambas funciones aceptan
// la fuente de datos por inyección de dependencia (mismo patrón que
// resolveCheckoutCanonicalPredioId/findCleanPredioCandidatesByPoint en
// este mismo módulo), así que no requieren base de datos real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutRequiresFiscalReview } from '../catastroxPayments.js';
import { resolveLookupPointFiscalStatus } from '../catastrox.js';

// --- checkoutRequiresFiscalReview (control autoritativo del checkout) ------

test('checkoutRequiresFiscalReview) predio ordinario (área < 5000 ha) -> false, el checkout puede continuar', async () => {
  const result = await checkoutRequiresFiscalReview('185920003000000080019000000000', async () => ({ areaHa: 86.67 }));
  assert.equal(result, false);
});

test('checkoutRequiresFiscalReview) predio de gran extensión (área >= 5000 ha) -> true, el checkout debe rechazarse', async () => {
  const result = await checkoutRequiresFiscalReview('185920003000000080019000000001', async () => ({ areaHa: 5200 }));
  assert.equal(result, true);
});

test('checkoutRequiresFiscalReview) exactamente en el umbral (5000 ha) -> true (regla existente, >=, no >)', async () => {
  const result = await checkoutRequiresFiscalReview('185920003000000080019000000002', async () => ({ areaHa: 5000 }));
  assert.equal(result, true);
});

test('checkoutRequiresFiscalReview) justo debajo del umbral (4999.99 ha) -> false', async () => {
  const result = await checkoutRequiresFiscalReview('185920003000000080019000000003', async () => ({ areaHa: 4999.99 }));
  assert.equal(result, false);
});

test('checkoutRequiresFiscalReview) sin datos de predio (predio legacy o no encontrado) -> false, nunca bloquea a ciegas', async () => {
  const result = await checkoutRequiresFiscalReview('legacy:v1:12345', async () => null);
  assert.equal(result, false);
});

test('checkoutRequiresFiscalReview) área no finita (NaN/undefined/null) -> false, nunca lanza', async () => {
  for (const areaHa of [NaN, undefined, null, 'no-es-un-numero']) {
    const result = await checkoutRequiresFiscalReview('185920003000000080019000000004', async () => ({ areaHa }));
    assert.equal(result, false, String(areaHa));
  }
});

test('checkoutRequiresFiscalReview) usa por defecto resolvePredioDataForDelivery (sin segundo argumento) -- no lanza aunque no haya DB configurada para este canonicalPredioId inválido', async () => {
  // canonicalPredioId con formato inválido (no 30 dígitos) -> resolvePredioDataForDelivery
  // devuelve null sin tocar la base de datos (mismo guard que ya prueba
  // catastroxCanonicalPredio.test.js) -- confirma que el parámetro por
  // defecto está bien cableado.
  await assert.doesNotReject(() => checkoutRequiresFiscalReview('formato-invalido'));
  assert.equal(await checkoutRequiresFiscalReview('formato-invalido'), false);
});

// --- resolveLookupPointFiscalStatus (señal temprana en POST /lookup) -------

test('resolveLookupPointFiscalStatus) fila con área geométrica >= 5000 ha (area_m2_exact) -> REVISION_ESPECIAL', () => {
  const status = resolveLookupPointFiscalStatus({ area_m2_exact: 60_000_000 }); // 6000 ha
  assert.equal(status, 'REVISION_ESPECIAL');
});

test('resolveLookupPointFiscalStatus) fila legacy con shape_area >= 5000 ha -> REVISION_ESPECIAL', () => {
  const status = resolveLookupPointFiscalStatus({ shape_area: 55_000_000 }); // 5500 ha
  assert.equal(status, 'REVISION_ESPECIAL');
});

test('resolveLookupPointFiscalStatus) predio ordinario (área < 5000 ha) -> null', () => {
  const status = resolveLookupPointFiscalStatus({ area_m2_exact: 866_710.71 }); // 86.67 ha
  assert.equal(status, null);
});

test('resolveLookupPointFiscalStatus) sin ningún área disponible -> null, nunca lanza', () => {
  assert.equal(resolveLookupPointFiscalStatus({}), null);
  assert.equal(resolveLookupPointFiscalStatus(null), null);
  assert.equal(resolveLookupPointFiscalStatus(undefined), null);
});
