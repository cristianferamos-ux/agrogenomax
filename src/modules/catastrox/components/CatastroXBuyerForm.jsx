import { useState } from 'react';

// Duplicado intencional (mismo valor) de
// server/services/catastrox/customerValidation.js -- misma convención que
// CATASTROX_PAYMENT_PACKAGE_PRICES_COP_CENTS en paymentOrderTransitions.js:
// el frontend nunca importa código de server/ (no es parte del bundle de
// Vite), así que la lista cerrada se repite aquí solo para UX. La
// validación real y única autoritativa sigue siendo la del backend.
const CUSTOMER_TYPES = [
  { value: 'natural', label: 'Persona natural' },
  { value: 'juridica', label: 'Persona jurídica' },
];

const DOCUMENT_TYPES = ['CC', 'CE', 'NIT', 'PASAPORTE', 'TI'];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Construido con String.fromCharCode -- nunca bytes de control literales en
// el código fuente (mismo criterio que el backend, ver
// customerValidation.js), para detectar intentos de inyección en
// correos/logs antes de enviar al servidor.
const CONTROL_CHAR_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
);

const EMPTY_FORM = {
  customerType: 'natural',
  firstName: '',
  lastName: '',
  legalName: '',
  documentType: 'CC',
  documentNumber: '',
  email: '',
  emailConfirmation: '',
  phone: '',
  countryCode: 'CO',
  department: '',
  city: '',
  address: '',
  privacyConsentAccepted: false,
  termsAccepted: false,
  deliveryAuthorizationAccepted: false,
};

function hasControlChars(value) {
  return CONTROL_CHAR_PATTERN.test(String(value || ''));
}

function validateForUx(form) {
  const errors = {};

  if (form.customerType === 'natural') {
    if (!form.firstName.trim() || hasControlChars(form.firstName)) errors.firstName = 'Ingrese un nombre válido.';
    if (!form.lastName.trim() || hasControlChars(form.lastName)) errors.lastName = 'Ingrese un apellido válido.';
  } else {
    if (!form.legalName.trim() || hasControlChars(form.legalName)) errors.legalName = 'Ingrese la razón social.';
  }

  if (!DOCUMENT_TYPES.includes(form.documentType)) errors.documentType = 'Seleccione un tipo de documento.';

  const documentNumberNormalized = form.documentNumber.trim().replace(/[\s.-]+/g, '');
  if (documentNumberNormalized.length < 4 || documentNumberNormalized.length > 20 || !/^[A-Za-z0-9]+$/.test(documentNumberNormalized)) {
    errors.documentNumber = 'Documento inválido (solo letras y números, entre 4 y 20 caracteres).';
  }

  const email = form.email.trim().toLowerCase();
  const emailConfirmation = form.emailConfirmation.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    errors.email = 'Ingrese un correo electrónico válido.';
  } else if (email !== emailConfirmation) {
    errors.emailConfirmation = 'El correo y su confirmación no coinciden.';
  }

  if (form.phone.trim().length < 6 || hasControlChars(form.phone)) errors.phone = 'Ingrese un teléfono válido.';
  if (!/^[A-Za-z]{2}$/.test(form.countryCode.trim())) errors.countryCode = 'Use el código ISO de 2 letras (ej. CO).';
  if (!form.department.trim() || hasControlChars(form.department)) errors.department = 'Ingrese el departamento.';
  if (!form.city.trim() || hasControlChars(form.city)) errors.city = 'Ingrese el municipio o ciudad.';
  if (form.address.trim().length < 4 || hasControlChars(form.address)) errors.address = 'Ingrese una dirección válida.';

  if (!form.privacyConsentAccepted) errors.privacyConsentAccepted = 'Debe aceptar la política de tratamiento de datos.';
  if (!form.termsAccepted) errors.termsAccepted = 'Debe aceptar los términos de compra.';
  if (!form.deliveryAuthorizationAccepted) {
    errors.deliveryAuthorizationAccepted = 'Debe autorizar el envío de entregables al correo registrado.';
  }

  return errors;
}

/**
 * Formulario del comprador (Bloque 3 del pedido). Nunca persiste nada en
 * localStorage/sessionStorage -- vive solo en estado de React, y se
 * descarta por completo (ver CatastroXPackagePage) cuando el flujo termina
 * o se cancela. No se prellena desde query params: `initialEmail`/etc. no
 * existen a propósito.
 */
export default function CatastroXBuyerForm({ onSubmit, onCancel, isSubmitting = false, submitError = null }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function handleSubmit(event) {
    event.preventDefault();
    const validationErrors = validateForUx(form);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;

    const documentNumberNormalized = form.documentNumber.trim().replace(/[\s.-]+/g, '');

    onSubmit({
      customerType: form.customerType,
      firstName: form.customerType === 'natural' ? form.firstName.trim() : undefined,
      lastName: form.customerType === 'natural' ? form.lastName.trim() : undefined,
      legalName: form.customerType === 'juridica' ? form.legalName.trim() : undefined,
      documentType: form.documentType,
      documentNumber: documentNumberNormalized,
      email: form.email.trim().toLowerCase(),
      emailConfirmation: form.emailConfirmation.trim().toLowerCase(),
      phone: form.phone.trim(),
      countryCode: form.countryCode.trim().toUpperCase(),
      department: form.department.trim(),
      city: form.city.trim(),
      address: form.address.trim(),
      privacyConsentAccepted: form.privacyConsentAccepted,
      termsAccepted: form.termsAccepted,
      deliveryAuthorizationAccepted: form.deliveryAuthorizationAccepted,
    });
  }

  return (
    <form className="catastrox-card catastrox-form" onSubmit={handleSubmit} autoComplete="on">
      <div className="catastrox-section-heading">
        <span>Datos del comprador</span>
        <h2>Complete sus datos para continuar con la compra</h2>
      </div>

      <label className="catastrox-field">
        <span>Tipo de comprador</span>
        <select
          value={form.customerType}
          onChange={(event) => updateField('customerType', event.target.value)}
        >
          {CUSTOMER_TYPES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {form.customerType === 'natural' ? (
        <>
          <label className="catastrox-field">
            <span>Nombres</span>
            <input
              autoComplete="given-name"
              value={form.firstName}
              onChange={(event) => updateField('firstName', event.target.value)}
            />
            {errors.firstName ? <small className="catastrox-field-error">{errors.firstName}</small> : null}
          </label>
          <label className="catastrox-field">
            <span>Apellidos</span>
            <input
              autoComplete="family-name"
              value={form.lastName}
              onChange={(event) => updateField('lastName', event.target.value)}
            />
            {errors.lastName ? <small className="catastrox-field-error">{errors.lastName}</small> : null}
          </label>
        </>
      ) : (
        <label className="catastrox-field is-full">
          <span>Razón social</span>
          <input
            autoComplete="organization"
            value={form.legalName}
            onChange={(event) => updateField('legalName', event.target.value)}
          />
          {errors.legalName ? <small className="catastrox-field-error">{errors.legalName}</small> : null}
        </label>
      )}

      <label className="catastrox-field">
        <span>Tipo de documento</span>
        <select value={form.documentType} onChange={(event) => updateField('documentType', event.target.value)}>
          {DOCUMENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>
      <label className="catastrox-field">
        <span>Número de documento</span>
        <input
          autoComplete="off"
          value={form.documentNumber}
          onChange={(event) => updateField('documentNumber', event.target.value)}
        />
        {errors.documentNumber ? <small className="catastrox-field-error">{errors.documentNumber}</small> : null}
      </label>

      <label className="catastrox-field">
        <span>Correo electrónico</span>
        <input
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={(event) => updateField('email', event.target.value)}
        />
        {errors.email ? <small className="catastrox-field-error">{errors.email}</small> : null}
      </label>
      <label className="catastrox-field">
        <span>Confirmar correo electrónico</span>
        <input
          type="email"
          autoComplete="email"
          value={form.emailConfirmation}
          onChange={(event) => updateField('emailConfirmation', event.target.value)}
          onPaste={(event) => event.preventDefault()}
        />
        {errors.emailConfirmation ? <small className="catastrox-field-error">{errors.emailConfirmation}</small> : null}
      </label>

      <label className="catastrox-field">
        <span>Teléfono</span>
        <input
          type="tel"
          autoComplete="tel"
          value={form.phone}
          onChange={(event) => updateField('phone', event.target.value)}
        />
        {errors.phone ? <small className="catastrox-field-error">{errors.phone}</small> : null}
      </label>
      <label className="catastrox-field">
        <span>País (ISO, ej. CO)</span>
        <input
          autoComplete="country"
          maxLength={2}
          value={form.countryCode}
          onChange={(event) => updateField('countryCode', event.target.value.toUpperCase())}
        />
        {errors.countryCode ? <small className="catastrox-field-error">{errors.countryCode}</small> : null}
      </label>

      <label className="catastrox-field">
        <span>Departamento</span>
        <input
          autoComplete="address-level1"
          value={form.department}
          onChange={(event) => updateField('department', event.target.value)}
        />
        {errors.department ? <small className="catastrox-field-error">{errors.department}</small> : null}
      </label>
      <label className="catastrox-field">
        <span>Municipio o ciudad</span>
        <input
          autoComplete="address-level2"
          value={form.city}
          onChange={(event) => updateField('city', event.target.value)}
        />
        {errors.city ? <small className="catastrox-field-error">{errors.city}</small> : null}
      </label>
      <label className="catastrox-field is-full">
        <span>Dirección</span>
        <input
          autoComplete="street-address"
          value={form.address}
          onChange={(event) => updateField('address', event.target.value)}
        />
        {errors.address ? <small className="catastrox-field-error">{errors.address}</small> : null}
      </label>

      <label className="catastrox-checkbox-row is-full">
        <input
          type="checkbox"
          checked={form.termsAccepted}
          onChange={(event) => updateField('termsAccepted', event.target.checked)}
        />
        <span>Acepto los términos de compra de CatastroX.</span>
      </label>
      {errors.termsAccepted ? <small className="catastrox-field-error is-full">{errors.termsAccepted}</small> : null}

      <label className="catastrox-checkbox-row is-full">
        <input
          type="checkbox"
          checked={form.privacyConsentAccepted}
          onChange={(event) => updateField('privacyConsentAccepted', event.target.checked)}
        />
        <span>Acepto la política de tratamiento de datos personales.</span>
      </label>
      {errors.privacyConsentAccepted ? (
        <small className="catastrox-field-error is-full">{errors.privacyConsentAccepted}</small>
      ) : null}

      <label className="catastrox-checkbox-row is-full">
        <input
          type="checkbox"
          checked={form.deliveryAuthorizationAccepted}
          onChange={(event) => updateField('deliveryAuthorizationAccepted', event.target.checked)}
        />
        <span>Autorizo el envío de mis entregables y documentos al correo registrado.</span>
      </label>
      {errors.deliveryAuthorizationAccepted ? (
        <small className="catastrox-field-error is-full">{errors.deliveryAuthorizationAccepted}</small>
      ) : null}

      {submitError ? (
        <div className="catastrox-inline-panel is-full">
          <strong>No fue posible registrar sus datos</strong>
          <span>{submitError}</span>
        </div>
      ) : null}

      <div className="catastrox-action-row is-full">
        <button type="submit" className="catastrox-button" disabled={isSubmitting}>
          {isSubmitting ? 'Enviando...' : 'Continuar'}
        </button>
        <button type="button" className="catastrox-button is-ghost" onClick={onCancel} disabled={isSubmitting}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
