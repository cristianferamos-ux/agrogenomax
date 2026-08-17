// FIX/GANADERIA-SPRINT-2-CLIENT-PROVISIONING §16 (12-16): pruebas
// arquitectónicas (análisis de texto fuente) -- mismo patrón que
// agxAdmin001Architecture.test.js / authFrontArchitecture.test.js. Este
// repo no tiene jsdom/testing-library configurado para render real de
// componentes React en `test:node` -- se sigue la convención existente.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_DIR = path.resolve(__dirname, '..');

const shellSource = fs.readFileSync(path.join(ADMIN_DIR, 'GanaderiaAdminShell.jsx'), 'utf8');
const crearCuentaSource = fs.readFileSync(path.join(ADMIN_DIR, 'GanaderiaAdminCrearCuenta.jsx'), 'utf8');

function stripComments(source) {
  return source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// ---------------------------------------------------------------------
// 12. La tarjeta "Crear cuenta" navega
// ---------------------------------------------------------------------

test('GanaderiaAdminShell.jsx: el módulo "Crear cuenta" define `to` y navega, ya no es un placeholder deshabilitado', () => {
  assert.match(shellSource, /label:\s*'Crear cuenta'[\s\S]{0,120}to:\s*'\/ganaderia\/admin\/crear-cuenta'/);
});

test('GanaderiaAdminShell.jsx: solo los módulos con `to` se renderizan como <button> navegable, el resto conserva el badge "Próximamente"', () => {
  assert.match(shellSource, /to\s*\?\s*\(/);
  assert.match(shellSource, /onClick=\{\(\)\s*=>\s*navigate\(to\)\}/);
  assert.match(shellSource, /gan-admin-card-badge/);
});

// ---------------------------------------------------------------------
// 13. El formulario valida los campos mínimos
// ---------------------------------------------------------------------

test('GanaderiaAdminCrearCuenta.jsx: nombreOrganizacion, nombreResponsable y email son required; identificadorFiscal es opcional', () => {
  const nombreOrgField = crearCuentaSource.match(/name="nombreOrganizacion"[\s\S]{0,80}/)?.[0] ?? '';
  const nombreRespField = crearCuentaSource.match(/name="nombreResponsable"[\s\S]{0,80}/)?.[0] ?? '';
  const emailField = crearCuentaSource.match(/name="email"[\s\S]{0,120}/)?.[0] ?? '';
  const identificadorField = crearCuentaSource.match(/name="identificadorFiscal"[\s\S]{0,80}/)?.[0] ?? '';

  assert.match(nombreOrgField, /required/);
  assert.match(nombreRespField, /required/);
  assert.match(emailField, /required/);
  assert.doesNotMatch(identificadorField, /required/);
});

test('GanaderiaAdminCrearCuenta.jsx: nunca envía el campo `rol`, `estado`, `cuentaId`, `organizacionId` ni `password_hash` en el body -- server-side los fija todos', () => {
  const codeOnly = stripComments(crearCuentaSource);
  const bodyBlock = codeOnly.match(/body:\s*JSON\.stringify\(\{[\s\S]*?\}\),/)?.[0] ?? '';
  assert.doesNotMatch(bodyBlock, /\brol\b\s*:/);
  assert.doesNotMatch(bodyBlock, /\bestado\b\s*:/);
  assert.doesNotMatch(bodyBlock, /\bcuentaId\b\s*:/);
  assert.doesNotMatch(bodyBlock, /\borganizacionId\b\s*:/);
  assert.doesNotMatch(bodyBlock, /password_hash/);
});

// ---------------------------------------------------------------------
// 14. Sin doble submit
// ---------------------------------------------------------------------

test('GanaderiaAdminCrearCuenta.jsx: handleSubmit corta temprano si submitting=true, y el botón queda disabled mientras tanto', () => {
  assert.match(crearCuentaSource, /if\s*\(submitting\)\s*return;/);
  assert.match(crearCuentaSource, /className="gan-login-submit"\s+disabled=\{submitting\}/);
});

// ---------------------------------------------------------------------
// 15. Éxito
// ---------------------------------------------------------------------

test('GanaderiaAdminCrearCuenta.jsx: éxito muestra el mensaje exacto pedido, nunca el token', () => {
  assert.match(
    crearCuentaSource,
    /Cuenta provisionada\. Se envió el enlace de activación al correo del cliente\./,
  );
  const codeOnly = stripComments(crearCuentaSource);
  assert.doesNotMatch(codeOnly, /rawToken/);
  assert.doesNotMatch(codeOnly, /body\.token/);
});

// ---------------------------------------------------------------------
// 16. Error 409
// ---------------------------------------------------------------------

test('GanaderiaAdminCrearCuenta.jsx: 409 muestra el mensaje funcional exacto pedido', () => {
  assert.match(
    crearCuentaSource,
    /status === 409[\s\S]{0,40}return 'Ya existe una cuenta asociada a este correo\.'/,
  );
});

// ---------------------------------------------------------------------
// MICROAUDITORÍA (6-8): semántica emailDelivered true/false
// ---------------------------------------------------------------------

test('MICROAUDITORÍA 6: emailDelivered true -> mensaje de envío exitoso', () => {
  assert.match(
    crearCuentaSource,
    /emailDelivered \? SUCCESS_MESSAGE : SUCCESS_EMAIL_FAILED_MESSAGE/,
  );
  assert.match(
    crearCuentaSource,
    /const SUCCESS_MESSAGE = 'Cuenta provisionada\. Se envió el enlace de activación al correo del cliente\.'/,
  );
});

test('MICROAUDITORÍA 7: emailDelivered false -> mensaje de advertencia exacto pedido', () => {
  assert.match(
    crearCuentaSource,
    /const SUCCESS_EMAIL_FAILED_MESSAGE =\s*\n?\s*'Cuenta creada, pero no pudimos enviar el correo de activación\. No vuelvas a crear la cuenta; podrás reenviar la activación posteriormente\.'/,
  );
});

test('MICROAUDITORÍA 8: emailDelivered false sigue siendo la rama de ÉXITO (submitted=true), nunca la rama de error -- no reintenta ni limpia el formulario como si hubiera fallado la creación', () => {
  const codeOnly = stripComments(crearCuentaSource);
  // El booleano se lee del body de una respuesta 2xx (dentro de la rama
  // que ya pasó `if (!response.ok)`), nunca dispara `setErrorMessage`.
  const setEmailDeliveredBlock = codeOnly.match(/setEmailDelivered\([\s\S]{0,60}\);[\s\S]{0,80}setSubmitted\(true\);/)?.[0] ?? '';
  assert.ok(setEmailDeliveredBlock, 'setEmailDelivered debe preceder a setSubmitted(true) en la misma rama de éxito');
  assert.doesNotMatch(setEmailDeliveredBlock, /setErrorMessage/);
});

test('GanaderiaAdminCrearCuenta.jsx: usa fetchCsrfToken + credentials include, mismo patrón que el resto del panel admin', () => {
  assert.match(crearCuentaSource, /fetchCsrfToken/);
  assert.match(crearCuentaSource, /credentials:\s*'include'/);
  assert.match(crearCuentaSource, /'X-CSRF-Token':\s*csrfToken/);
});

// ---------------------------------------------------------------------
// HOTFIX E2E-001 (ajuste UX): 5xx real vs. excepción de red/fetch
// ---------------------------------------------------------------------

test('HOTFIX E2E-001 UX 1: response.status >= 500 muestra el mensaje de error de servidor exacto pedido, no el genérico de red', () => {
  assert.match(
    crearCuentaSource,
    /const SERVER_ERROR_MESSAGE =\s*\n?\s*'Ocurrió un error al crear la cuenta\. No vuelvas a intentarlo hasta verificar el estado\.'/,
  );
  const resolveErrorMessageBody = crearCuentaSource.match(/function resolveErrorMessage[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(resolveErrorMessageBody, /if \(status >= 500\) return SERVER_ERROR_MESSAGE;/);
  // La rama 5xx debe evaluarse ANTES del fallback genérico -- si no, un 500
  // real nunca alcanzaría SERVER_ERROR_MESSAGE.
  const serverErrorIndex = resolveErrorMessageBody.indexOf('status >= 500');
  const fallbackIndex = resolveErrorMessageBody.indexOf('return GENERIC_NETWORK_MESSAGE;');
  assert.ok(serverErrorIndex >= 0 && fallbackIndex >= 0 && serverErrorIndex < fallbackIndex);
});

test('HOTFIX E2E-001 UX 2: una excepción real de fetch/red (catch) sigue mostrando GENERIC_NETWORK_MESSAGE, nunca SERVER_ERROR_MESSAGE', () => {
  const codeOnly = stripComments(crearCuentaSource);
  const catchBlock = codeOnly.match(/\} catch \{[\s\S]{0,150}?\n {4}\}/)?.[0] ?? '';
  assert.ok(catchBlock, 'debe existir el bloque catch de handleSubmit');
  assert.match(catchBlock, /setErrorMessage\(GENERIC_NETWORK_MESSAGE\)/);
  assert.doesNotMatch(catchBlock, /SERVER_ERROR_MESSAGE/);
});

test('HOTFIX E2E-001 UX 3: 409 no fue tocado por este ajuste -- sigue mostrando el mensaje funcional exacto previo', () => {
  const resolveErrorMessageBody = crearCuentaSource.match(/function resolveErrorMessage[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(
    resolveErrorMessageBody,
    /status === 409[\s\S]{0,40}return 'Ya existe una cuenta asociada a este correo\.'/,
  );
});

test('HOTFIX E2E-001 UX 4: el flujo de éxito (SUCCESS_MESSAGE/SUCCESS_EMAIL_FAILED_MESSAGE) queda intacto -- este ajuste solo toca resolveErrorMessage', () => {
  assert.match(
    crearCuentaSource,
    /const SUCCESS_MESSAGE = 'Cuenta provisionada\. Se envió el enlace de activación al correo del cliente\.'/,
  );
  assert.match(crearCuentaSource, /emailDelivered \? SUCCESS_MESSAGE : SUCCESS_EMAIL_FAILED_MESSAGE/);
});
