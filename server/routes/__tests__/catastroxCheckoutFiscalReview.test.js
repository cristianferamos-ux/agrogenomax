// CATX-FISCAL-PROTECTION-001 + P1-02/P1-03 (remediación post-auditoría):
// pruebas puras (sin Postgres, sin red real) de la lógica que decide si un
// checkout puede continuar -- tanto la resolubilidad del predio (P1-02,
// "invariante purchasable = deliverable") como la revisión fiscal (P1-03,
// "no hay datos no equivale a no requiere revisión") ahora son la MISMA
// decisión estructurada, resuelta en una sola llamada. Tanto
// resolveCheckoutPredioEligibility (control autoritativo del checkout)
// como resolveLookupPointFiscalStatus (señal temprana en el lookup
// gratuito) aceptan la fuente de datos por inyección de dependencia (mismo
// patrón que resolveCheckoutCanonicalPredioId/findCleanPredioCandidatesByPoint
// en este mismo módulo), así que no requieren base de datos real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCheckoutPredioEligibility } from '../catastroxPayments.js';
import { resolveLookupPointFiscalStatus } from '../catastrox.js';

// --- resolveCheckoutPredioEligibility (control autoritativo del checkout) --

test('resolveCheckoutPredioEligibility) predio ordinario (área < 5000 ha) -> resolvable=true, requiresFiscalReview=false', async () => {
  const result = await resolveCheckoutPredioEligibility('185920003000000080019000000000', async () => ({ areaHa: 86.67 }));
  assert.deepEqual(result, {
    resolvable: true,
    requiresFiscalReview: false,
    canonicalAreaHa: 86.67,
    reason: 'OK',
  });
});

test('resolveCheckoutPredioEligibility) predio de gran extensión (área >= 5000 ha) -> resolvable=true, requiresFiscalReview=true', async () => {
  const result = await resolveCheckoutPredioEligibility('185920003000000080019000000001', async () => ({ areaHa: 5200 }));
  assert.deepEqual(result, {
    resolvable: true,
    requiresFiscalReview: true,
    canonicalAreaHa: 5200,
    reason: 'FISCAL_REVIEW_REQUIRED',
  });
});

test('resolveCheckoutPredioEligibility) exactamente en el umbral (5000 ha) -> requiresFiscalReview=true (regla existente, >=, no >)', async () => {
  const result = await resolveCheckoutPredioEligibility('185920003000000080019000000002', async () => ({ areaHa: 5000 }));
  assert.equal(result.resolvable, true);
  assert.equal(result.requiresFiscalReview, true);
});

test('resolveCheckoutPredioEligibility) justo debajo del umbral (4999.99 ha) -> requiresFiscalReview=false', async () => {
  const result = await resolveCheckoutPredioEligibility('185920003000000080019000000003', async () => ({ areaHa: 4999.99 }));
  assert.equal(result.resolvable, true);
  assert.equal(result.requiresFiscalReview, false);
});

// P1-02/P1-03 -- cierra CATX-LEGACY-SPECIAL-REVIEW-GUARD-001: antes este
// caso (predio legacy o no encontrado) devolvía `false` interpretado como
// "no requiere revisión fiscal" y el checkout avanzaba igual (fail-open).
// Ahora "no hay datos" bloquea el checkout directamente -- nunca se
// confunde con "no hay riesgo".
test('resolveCheckoutPredioEligibility) sin datos de predio (predio legacy o no encontrado) -> resolvable=false, el checkout DEBE bloquear', async () => {
  const result = await resolveCheckoutPredioEligibility('legacy:v1:12345', async () => null);
  assert.deepEqual(result, {
    resolvable: false,
    requiresFiscalReview: false,
    canonicalAreaHa: null,
    reason: 'PREDIO_DATA_UNAVAILABLE',
  });
});

// Red de seguridad fail-closed (P1-03, punto 4): el contrato real de
// resolvePredioDataForDelivery nunca produce un areaHa no finito cuando el
// predio existe (ver comentario en catastroxPayments.js) -- pero un
// resolvePredioData inyectado (como en este test) sí puede devolver
// cualquier cosa, así que esta rama SÍ es alcanzable a través del
// parámetro de inyección de dependencia. Nunca se interpreta como "área
// ordinaria" -- siempre bloquea, igual que "sin datos".
test('resolveCheckoutPredioEligibility) área no finita (NaN/undefined/null/string) -> resolvable=false, fail-closed, nunca lanza', async () => {
  for (const areaHa of [NaN, undefined, null, 'no-es-un-numero']) {
    const result = await resolveCheckoutPredioEligibility('185920003000000080019000000004', async () => ({ areaHa }));
    assert.deepEqual(
      result,
      { resolvable: false, requiresFiscalReview: false, canonicalAreaHa: null, reason: 'PREDIO_DATA_UNAVAILABLE' },
      String(areaHa),
    );
  }
});

test('resolveCheckoutPredioEligibility) usa por defecto resolvePredioDataForDelivery (sin segundo argumento) -- no lanza aunque no haya DB configurada para este canonicalPredioId inválido', async () => {
  // canonicalPredioId con formato inválido (no 30 dígitos) -> resolvePredioDataForDelivery
  // devuelve null sin tocar la base de datos (mismo guard que ya prueba
  // catastroxCanonicalPredio.test.js) -- confirma que el parámetro por
  // defecto está bien cableado, y que el resultado por defecto también
  // bloquea (resolvable=false), no solo "no lanza".
  await assert.doesNotReject(() => resolveCheckoutPredioEligibility('formato-invalido'));
  const result = await resolveCheckoutPredioEligibility('formato-invalido');
  assert.equal(result.resolvable, false);
  assert.equal(result.reason, 'PREDIO_DATA_UNAVAILABLE');
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
