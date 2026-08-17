// UX-SESSION-FIX-001: pruebas arquitectónicas (análisis de texto fuente) --
// mismo patrón que ganaderiaAdminCrearCuentaArchitecture.test.js. Este repo
// no tiene jsdom/testing-library configurado para render real de
// componentes React en `test:node` -- se sigue la convención existente.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPONENTS_DIR = path.resolve(__dirname, '..');

const sidebarSource = fs.readFileSync(path.join(COMPONENTS_DIR, 'GanaderiaSidebar.jsx'), 'utf8');

function stripComments(source) {
  return source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// ---------------------------------------------------------------------
// 1. Consume el contexto de sesión
// ---------------------------------------------------------------------

test('GanaderiaSidebar.jsx: consume el contexto de sesión de Ganadería (useGanaderiaAuthOptional, variante que nunca lanza en /qr/:codigo, la única ruta de GanaderiaApp sin <GanaderiaAuthProvider>)', () => {
  assert.match(sidebarSource, /useGanaderiaAuthOptional/);
  assert.match(sidebarSource, /from\s+'\.\.\/auth\/GanaderiaAuthContext\.jsx'/);
});

// ---------------------------------------------------------------------
// 2-3. Identidad visible
// ---------------------------------------------------------------------

test('GanaderiaSidebar.jsx: muestra cuenta.nombre (con fallback a cuenta.email)', () => {
  assert.match(sidebarSource, /cuenta\?\.nombre\s*\?\?\s*cuenta\?\.email/);
});

test('GanaderiaSidebar.jsx: muestra organizacionActiva.nombre', () => {
  assert.match(sidebarSource, /organizacionActiva\?\.nombre/);
});

test('GanaderiaSidebar.jsx: nunca muestra el organizacionId (UUID) en el bloque de identidad', () => {
  const codeOnly = stripComments(sidebarSource);
  const accountBlock = codeOnly.match(/\{auth \? \([\s\S]*?\) : null\}/)?.[0] ?? '';
  assert.ok(accountBlock, 'debe existir el bloque condicional de identidad/logout');
  assert.doesNotMatch(accountBlock, /organizacionId/);
});

// ---------------------------------------------------------------------
// 4. Traducción de rol
// ---------------------------------------------------------------------

test('GanaderiaSidebar.jsx: traduce owner -> Propietario (y no altera el valor real del backend, solo la presentación)', () => {
  assert.match(sidebarSource, /owner:\s*'Propietario'/);
  assert.match(sidebarSource, /rolLabel\(organizacionActiva\.rol\)/);
});

// ---------------------------------------------------------------------
// 5. Botón Cerrar sesión
// ---------------------------------------------------------------------

test('GanaderiaSidebar.jsx: existe el botón "Cerrar sesión"', () => {
  assert.match(sidebarSource, /className="gan-dash-sidebar-logout"/);
  assert.match(sidebarSource, /'Cerrar sesión'/);
});

// ---------------------------------------------------------------------
// 6-10. Logout reutiliza exactamente el patrón de GanaderiaAdminShell.jsx
// ---------------------------------------------------------------------

test('GanaderiaSidebar.jsx: obtiene un token CSRF fresco antes del logout (mismo patrón que GanaderiaAdminShell.jsx)', () => {
  assert.match(sidebarSource, /fetchCsrfToken/);
  assert.match(sidebarSource, /const csrfToken = await fetchCsrfToken\(\);/);
});

test('GanaderiaSidebar.jsx: hace POST a /api/ganaderia/auth/logout -- ningún endpoint nuevo', () => {
  assert.match(sidebarSource, /fetch\('\/api\/ganaderia\/auth\/logout',/);
  assert.match(sidebarSource, /method:\s*'POST'/);
  assert.match(sidebarSource, /'X-CSRF-Token':\s*csrfToken/);
});

test('GanaderiaSidebar.jsx: usa credentials: "include" en el logout', () => {
  assert.match(sidebarSource, /credentials:\s*'include'/);
});

test('GanaderiaSidebar.jsx: llama refresh() del AuthContext después de un logout exitoso, antes de navegar', () => {
  const codeOnly = stripComments(sidebarSource);
  const successBlock = codeOnly.match(/await refresh\(\);[\s\S]{0,80}navigate\('\/ganaderia\/login'/)?.[0] ?? '';
  assert.ok(successBlock, 'refresh() debe preceder a la navegación tras logout exitoso');
});

test('GanaderiaSidebar.jsx: navega a /ganaderia/login con replace:true tras logout exitoso', () => {
  assert.match(sidebarSource, /navigate\('\/ganaderia\/login',\s*\{\s*replace:\s*true\s*\}\)/);
});

// ---------------------------------------------------------------------
// 11. Sin doble submit
// ---------------------------------------------------------------------

test('GanaderiaSidebar.jsx: handleLogout corta temprano si loggingOut=true, y el botón queda disabled mientras tanto', () => {
  assert.match(sidebarSource, /if\s*\(loggingOut\)\s*return;/);
  assert.match(sidebarSource, /className="gan-dash-sidebar-logout"\s+onClick=\{handleLogout\}\s+disabled=\{loggingOut\}/);
});

// ---------------------------------------------------------------------
// 12. Error de logout visible
// ---------------------------------------------------------------------

test('GanaderiaSidebar.jsx: un logout fallido (response no-ok o excepción de red) muestra un mensaje discreto y NUNCA navega al login sin confirmación del backend', () => {
  const codeOnly = stripComments(sidebarSource);
  assert.match(codeOnly, /className="gan-dash-sidebar-account-error"/);
  assert.match(sidebarSource, /'No fue posible cerrar la sesión\. Intenta nuevamente\.'/);
  assert.match(sidebarSource, /'No fue posible conectar con el servicio\. Intenta nuevamente\.'/);

  // El `if (!response.ok)` retorna ANTES de refresh()/navigate() -- nunca
  // navega sin que el backend confirme el logout.
  const failureBranch = codeOnly.match(/if\s*\(!response\.ok\)\s*\{[\s\S]{0,160}?\}/)?.[0] ?? '';
  assert.ok(failureBranch, 'debe existir la rama de fallo de response.ok');
  assert.doesNotMatch(failureBranch, /navigate\(/);
});

// ---------------------------------------------------------------------
// Regresión: no toca la cookie HttpOnly desde JS, no crea un segundo
// sistema de logout distinto al ya auditado.
// ---------------------------------------------------------------------

test('GanaderiaSidebar.jsx: nunca manipula document.cookie -- la cookie de sesión es HttpOnly, solo el backend puede limpiarla', () => {
  const codeOnly = stripComments(sidebarSource);
  assert.doesNotMatch(codeOnly, /document\.cookie/);
});
