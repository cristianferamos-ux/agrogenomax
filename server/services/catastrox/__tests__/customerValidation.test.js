import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCustomerInput } from '../customerValidation.js';

function buildValidInput(overrides = {}) {
  return {
    customerType: 'natural',
    firstName: 'Ana',
    lastName: 'Gomez',
    documentType: 'CC',
    documentNumber: '1032456789',
    email: 'ana@example.com',
    emailConfirmation: 'ana@example.com',
    phone: '3001234567',
    countryCode: 'CO',
    department: 'Caqueta',
    city: 'Florencia',
    address: 'Calle 1 # 2-3',
    privacyConsentAccepted: true,
    termsAccepted: true,
    deliveryAuthorizationAccepted: true,
    ...overrides,
  };
}

test('acepta un formulario válido de persona natural y normaliza los campos', () => {
  const result = validateCustomerInput(buildValidInput({ email: 'Ana@Example.COM', emailConfirmation: 'ana@example.com' }));
  assert.equal(result.customerType, 'NATURAL');
  assert.equal(result.email, 'ana@example.com');
  assert.equal(result.documentType, 'CC');
  assert.equal(result.legalName, null);
});

test('acepta persona jurídica con legalName, sin exigir firstName/lastName', () => {
  const result = validateCustomerInput(
    buildValidInput({ customerType: 'juridica', legalName: 'CRH Soluciones SAS', firstName: undefined, lastName: undefined }),
  );
  assert.equal(result.customerType, 'JURIDICA');
  assert.equal(result.legalName, 'CRH Soluciones SAS');
  assert.equal(result.firstName, null);
});

test('persona natural sin firstName/lastName -> rechazado', () => {
  assert.throws(
    () => validateCustomerInput(buildValidInput({ firstName: '' })),
    (error) => error.publicCode === 'INVALID_FIRST_NAME',
  );
});

test('persona jurídica sin legalName -> rechazado', () => {
  assert.throws(
    () => validateCustomerInput(buildValidInput({ customerType: 'juridica' })),
    (error) => error.publicCode === 'INVALID_LEGAL_NAME',
  );
});

test('customerType inválido -> rechazado', () => {
  assert.throws(
    () => validateCustomerInput(buildValidInput({ customerType: 'empresa' })),
    (error) => error.publicCode === 'INVALID_CUSTOMER_TYPE',
  );
});

test('tipo de documento fuera de la lista cerrada -> rechazado', () => {
  assert.throws(
    () => validateCustomerInput(buildValidInput({ documentType: 'RUT' })),
    (error) => error.publicCode === 'INVALID_DOCUMENT_TYPE',
  );
});

test('documentNumber se normaliza (espacios/puntos/guiones) antes de validar longitud', () => {
  const result = validateCustomerInput(buildValidInput({ documentNumber: '10.324-567 89' }));
  assert.equal(result.documentNumber, '1032456789');
});

test('documentNumber demasiado corto -> rechazado', () => {
  assert.throws(
    () => validateCustomerInput(buildValidInput({ documentNumber: '12' })),
    (error) => error.publicCode === 'INVALID_DOCUMENT_NUMBER',
  );
});

test('correo con formato inválido -> rechazado', () => {
  assert.throws(
    () => validateCustomerInput(buildValidInput({ email: 'no-es-un-correo', emailConfirmation: 'no-es-un-correo' })),
    (error) => error.publicCode === 'INVALID_EMAIL',
  );
});

test('correo y confirmación que no coinciden -> rechazado (EMAIL_CONFIRMATION_MISMATCH)', () => {
  assert.throws(
    () => validateCustomerInput(buildValidInput({ emailConfirmation: 'otro@example.com' })),
    (error) => error.publicCode === 'EMAIL_CONFIRMATION_MISMATCH',
  );
});

test('código de país fuera de formato ISO de 2 letras -> rechazado', () => {
  assert.throws(
    () => validateCustomerInput(buildValidInput({ countryCode: 'COL' })),
    (error) => error.publicCode === 'INVALID_COUNTRY_CODE',
  );
});

test('sin aceptar política de tratamiento de datos -> rechazado', () => {
  assert.throws(
    () => validateCustomerInput(buildValidInput({ privacyConsentAccepted: false })),
    (error) => error.publicCode === 'PRIVACY_CONSENT_REQUIRED',
  );
});

test('sin aceptar términos de compra -> rechazado', () => {
  assert.throws(
    () => validateCustomerInput(buildValidInput({ termsAccepted: false })),
    (error) => error.publicCode === 'TERMS_NOT_ACCEPTED',
  );
});

test('sin autorizar el envío de entregables por correo -> rechazado', () => {
  assert.throws(
    () => validateCustomerInput(buildValidInput({ deliveryAuthorizationAccepted: false })),
    (error) => error.publicCode === 'DELIVERY_AUTHORIZATION_REQUIRED',
  );
});

test('caracteres de control en un campo de texto -> rechazado (protección contra inyección en correos/logs)', () => {
  assert.throws(
    () => validateCustomerInput(buildValidInput({ firstName: 'Ana\nInjected-Header: x' })),
    (error) => error.publicCode === 'INVALID_FIRST_NAME',
  );
});

test('ningún campo lanza una excepción no controlada (siempre Error con publicCode)', () => {
  const cases = [{}, { customerType: 'natural' }, null, undefined];
  for (const input of cases) {
    assert.throws(() => validateCustomerInput(input), (error) => typeof error.publicCode === 'string');
  }
});
