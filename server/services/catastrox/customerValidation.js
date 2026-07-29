// Validación pura del formulario de comprador (Bloque 2 del pedido) -- sin
// red, sin base de datos. Mismo estilo que validateCadastralCodeInput en
// server/routes/catastrox.js: lanza un Error con status/publicCode/
// publicMessage, nunca deja pasar datos parcialmente válidos.

export const CATASTROX_CUSTOMER_TYPES = Object.freeze(['natural', 'juridica']);

// Tipos de documento colombianos -- lista cerrada, ampliable si CRH lo
// requiere, nunca un valor libre sin validar.
export const CATASTROX_DOCUMENT_TYPES = Object.freeze(['CC', 'CE', 'NIT', 'PASAPORTE', 'TI']);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Construido con String.fromCharCode (nunca bytes de control literales en
// el código fuente) -- detecta saltos de línea/tabs/DEL que podrían usarse
// para inyección en correos/logs/CSV de facturación.
const CONTROL_CHAR_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
);
const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const MAX_DOCUMENT_LENGTH = 20;
const MIN_DOCUMENT_LENGTH = 4;
const MAX_ADDRESS_LENGTH = 240;
const MAX_PHONE_LENGTH = 30;
const MAX_PLACE_LENGTH = 120;

function fail(publicCode, publicMessage, field) {
  const error = new Error(publicMessage);
  error.status = 400;
  error.publicCode = publicCode;
  error.publicMessage = publicMessage;
  if (field) error.field = field;
  return error;
}

function requireNonEmptyString(value, { field, maxLength, minLength = 1, code }) {
  const normalized = String(value ?? '').trim();
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw fail(code, `El campo "${field}" es obligatorio y debe tener entre ${minLength} y ${maxLength} caracteres.`, field);
  }
  // Rechaza caracteres de control (incluye saltos de línea/tabs que
  // podrían usarse para inyección en correos/logs/CSV de facturación).
  if (CONTROL_CHAR_PATTERN.test(normalized)) {
    throw fail(code, `El campo "${field}" contiene caracteres no permitidos.`, field);
  }
  return normalized;
}

/**
 * Valida y normaliza el formulario completo de comprador+facturación.
 * Nunca confía en timestamps de consentimiento enviados por el cliente --
 * privacyConsentAccepted/termsAccepted son booleanos; los timestamps los
 * fija el backend en el momento de la validación.
 *
 * @param {Record<string, unknown>} body
 */
export function validateCustomerInput(body) {
  const rawCustomerType = String(body?.customerType || '').trim().toLowerCase();
  if (!CATASTROX_CUSTOMER_TYPES.includes(rawCustomerType)) {
    throw fail('INVALID_CUSTOMER_TYPE', 'El tipo de comprador debe ser "natural" o "juridica".', 'customerType');
  }
  const customerType = rawCustomerType === 'natural' ? 'NATURAL' : 'JURIDICA';

  let firstName = null;
  let lastName = null;
  let legalName = null;

  if (customerType === 'NATURAL') {
    firstName = requireNonEmptyString(body?.firstName, { field: 'firstName', maxLength: MAX_NAME_LENGTH, code: 'INVALID_FIRST_NAME' });
    lastName = requireNonEmptyString(body?.lastName, { field: 'lastName', maxLength: MAX_NAME_LENGTH, code: 'INVALID_LAST_NAME' });
  } else {
    legalName = requireNonEmptyString(body?.legalName, { field: 'legalName', maxLength: MAX_NAME_LENGTH, code: 'INVALID_LEGAL_NAME' });
  }

  const documentType = String(body?.documentType || '').trim().toUpperCase();
  if (!CATASTROX_DOCUMENT_TYPES.includes(documentType)) {
    throw fail(
      'INVALID_DOCUMENT_TYPE',
      `El tipo de documento debe ser uno de: ${CATASTROX_DOCUMENT_TYPES.join(', ')}.`,
      'documentType',
    );
  }

  const documentNumberRaw = String(body?.documentNumber || '').trim().replace(/[\s.-]+/g, '');
  if (
    documentNumberRaw.length < MIN_DOCUMENT_LENGTH ||
    documentNumberRaw.length > MAX_DOCUMENT_LENGTH ||
    !/^[A-Za-z0-9]+$/.test(documentNumberRaw)
  ) {
    throw fail(
      'INVALID_DOCUMENT_NUMBER',
      `El número de documento debe ser alfanumérico, entre ${MIN_DOCUMENT_LENGTH} y ${MAX_DOCUMENT_LENGTH} caracteres.`,
      'documentNumber',
    );
  }

  const email = String(body?.email || '').trim().toLowerCase();
  const emailConfirmation = String(body?.emailConfirmation || '').trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw fail('INVALID_EMAIL', 'El correo electrónico no tiene un formato válido.', 'email');
  }
  if (email !== emailConfirmation) {
    throw fail('EMAIL_CONFIRMATION_MISMATCH', 'El correo y su confirmación no coinciden.', 'emailConfirmation');
  }

  const phone = requireNonEmptyString(body?.phone, { field: 'phone', maxLength: MAX_PHONE_LENGTH, minLength: 6, code: 'INVALID_PHONE' });

  const countryCode = String(body?.countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw fail('INVALID_COUNTRY_CODE', 'El país debe indicarse como código ISO de 2 letras (ej. CO).', 'countryCode');
  }

  const department = requireNonEmptyString(body?.department, { field: 'department', maxLength: MAX_PLACE_LENGTH, code: 'INVALID_DEPARTMENT' });
  const city = requireNonEmptyString(body?.city, { field: 'city', maxLength: MAX_PLACE_LENGTH, code: 'INVALID_CITY' });
  const address = requireNonEmptyString(body?.address, { field: 'address', maxLength: MAX_ADDRESS_LENGTH, minLength: 4, code: 'INVALID_ADDRESS' });

  if (body?.privacyConsentAccepted !== true) {
    throw fail('PRIVACY_CONSENT_REQUIRED', 'Debe aceptar la política de tratamiento de datos.', 'privacyConsentAccepted');
  }
  if (body?.termsAccepted !== true) {
    throw fail('TERMS_NOT_ACCEPTED', 'Debe aceptar los términos de compra.', 'termsAccepted');
  }
  if (body?.deliveryAuthorizationAccepted !== true) {
    throw fail(
      'DELIVERY_AUTHORIZATION_REQUIRED',
      'Debe autorizar el envío de entregables y documentos al correo indicado.',
      'deliveryAuthorizationAccepted',
    );
  }

  return {
    customerType,
    firstName,
    lastName,
    legalName,
    documentType,
    documentNumber: documentNumberRaw,
    email,
    phone,
    countryCode,
    department,
    city,
    address,
  };
}
