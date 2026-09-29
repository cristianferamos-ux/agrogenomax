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

// SPRINT-3D10.5 F3b: el POST /auth/logout con CSRF + credentials include
// vive ahora en performGanaderiaLogout (auth/ganaderiaAuthedRequest.js,
// cubierto por ganaderiaAuthedRequest.test.js). El sidebar solo delega.
test('GanaderiaSidebar.jsx: delega el logout en performGanaderiaLogout, sin fetchCsrfToken ni fetch propio', () => {
  const codeOnly = stripComments(sidebarSource);
  assert.match(codeOnly, /import \{ performGanaderiaLogout \} from '\.\.\/auth\/ganaderiaAuthedRequest\.js';/);
  assert.match(codeOnly, /const outcome = await performGanaderiaLogout\(\);/);
  assert.match(codeOnly, /const action = resolveLogoutUiAction\(outcome\);/);
  assert.doesNotMatch(codeOnly, /fetchCsrfToken/);
  assert.doesNotMatch(codeOnly, /\bfetch\(/);
});

test('GanaderiaSidebar.jsx: termina la sesión LOCALMENTE (endSessionLocally) antes de navegar al login', () => {
  const codeOnly = stripComments(sidebarSource);
  const successBlock = codeOnly.match(/endSessionLocally\(\);\s*navigate\('\/ganaderia\/login'/)?.[0] ?? '';
  assert.ok(successBlock, 'endSessionLocally() debe preceder a la navegación tras logout');
  assert.doesNotMatch(codeOnly, /refresh\(\)/);
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

test('GanaderiaSidebar.jsx: un logout no confirmado (CSRF_REJECTED/NETWORK_ERROR/FAILED) muestra el mensaje del modelo y NUNCA navega ni termina la sesión local', () => {
  const codeOnly = stripComments(sidebarSource);
  assert.match(codeOnly, /className="gan-dash-sidebar-account-error"/);
  // El `if (!action.endSession)` retorna ANTES de endSessionLocally()/navigate().
  const failureBranch = codeOnly.match(/if\s*\(!action\.endSession\)\s*\{[\s\S]{0,160}?\}/)?.[0] ?? '';
  assert.ok(failureBranch, 'debe existir la rama de logout no confirmado');
  assert.match(failureBranch, /setLogoutError\(action\.message\);/);
  assert.match(failureBranch, /setLoggingOut\(false\);/);
  assert.match(failureBranch, /return;/);
  assert.doesNotMatch(failureBranch, /navigate\(|endSessionLocally/);
});

// ---------------------------------------------------------------------
// Regresión: no toca la cookie HttpOnly desde JS, no crea un segundo
// sistema de logout distinto al ya auditado.
// ---------------------------------------------------------------------

test('GanaderiaSidebar.jsx: nunca manipula document.cookie -- la cookie de sesión es HttpOnly, solo el backend puede limpiarla', () => {
  const codeOnly = stripComments(sidebarSource);
  assert.doesNotMatch(codeOnly, /document\.cookie/);
});
