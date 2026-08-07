// CATX-FISCAL-PROTECTION-001: guarda de regresión del bug raíz -- durante
// meses CATASTROX_STATUS no tenía las claves REVISION_ESPECIAL ni
// POSIBLE_PREDIO_FISCAL, así que CATASTROX_STATUS.REVISION_ESPECIAL
// evaluaba a `undefined` en CatastroXStatusBadge.jsx, CatastroXMap.jsx y
// REQUIRES_ADVISOR_STATES de CatastroXPackagePage.jsx -- un predio de gran
// extensión nunca era reconocido como tal y podía seguir hasta la compra
// automática. Esta prueba falla si alguna clave vuelve a faltar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATASTROX_FISCAL_REVIEW_AREA_HA_THRESHOLD, CATASTROX_STATUS } from '../catastroxMockData.js';

test('CATASTROX_STATUS) las 8 claves esperadas existen y ninguna es undefined', () => {
  const expectedKeys = [
    'IDENTIFICADO',
    'INCONSISTENCIA',
    'FISCAL',
    'NO_PREDIO_INDIVIDUALIZADO',
    'SIN_COBERTURA_CATASTRAL',
    'PENDIENTE_VALIDACION',
    'REVISION_ESPECIAL',
    'POSIBLE_PREDIO_FISCAL',
  ];
  expectedKeys.forEach((key) => {
    assert.equal(typeof CATASTROX_STATUS[key], 'string', `CATASTROX_STATUS.${key} debe ser un string, nunca undefined`);
    assert.ok(CATASTROX_STATUS[key].length > 0, `CATASTROX_STATUS.${key} no puede ser cadena vacía`);
  });
});

test('CATASTROX_STATUS) REVISION_ESPECIAL y POSIBLE_PREDIO_FISCAL coinciden con los literales ya usados en catastroxContact.js/CatastroXResultPage.jsx', () => {
  // Estos valores literales ('REVISION_ESPECIAL', 'POSIBLE_PREDIO_FISCAL')
  // ya se usaban como strings sueltos en varios archivos antes de esta
  // corrección -- el enum debe coincidir exactamente, nunca inventar un
  // valor distinto.
  assert.equal(CATASTROX_STATUS.REVISION_ESPECIAL, 'REVISION_ESPECIAL');
  assert.equal(CATASTROX_STATUS.POSIBLE_PREDIO_FISCAL, 'POSIBLE_PREDIO_FISCAL');
});

test('CATASTROX_STATUS) todas las claves tienen valores únicos (ninguna colisiona con otra)', () => {
  const values = Object.values(CATASTROX_STATUS);
  assert.equal(new Set(values).size, values.length, 'no debe haber dos claves con el mismo valor string');
});

test('CATASTROX_FISCAL_REVIEW_AREA_HA_THRESHOLD) es 5000 -- misma regla ya usada en CatastroXResultPage.jsx, replicada en server/routes/catastroxPayments.js y server/routes/catastrox.js', () => {
  assert.equal(CATASTROX_FISCAL_REVIEW_AREA_HA_THRESHOLD, 5000);
});
