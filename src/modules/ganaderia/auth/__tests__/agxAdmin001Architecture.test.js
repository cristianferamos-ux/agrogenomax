// AGX-ADMIN-001: pruebas arquitectónicas (análisis de texto fuente) --
// mismo patrón que authFrontArchitecture.test.js. Cubre §12: identidad
// interna super_admin_agx, ruteo /ganaderia/admin, aislamiento del shell
// administrativo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.resolve(__dirname, '..');
const GANADERIA_DIR = path.resolve(AUTH_DIR, '..');
const SRC_DIR = path.resolve(GANADERIA_DIR, '..', '..');

const appSource = fs.readFileSync(path.join(SRC_DIR, 'App.jsx'), 'utf8');
const authContextSource = fs.readFileSync(path.join(AUTH_DIR, 'GanaderiaAuthContext.jsx'), 'utf8');
const requireAuthSource = fs.readFileSync(path.join(AUTH_DIR, 'RequireGanaderiaAuth.jsx'), 'utf8');
const requireSuperAdminSource = fs.readFileSync(path.join(AUTH_DIR, 'RequireGanaderiaSuperAdmin.jsx'), 'utf8');
const loginSource = fs.readFileSync(path.join(GANADERIA_DIR, 'pages', 'GanaderiaLogin.jsx'), 'utf8');
const adminShellSource = fs.readFileSync(path.join(GANADERIA_DIR, 'admin', 'GanaderiaAdminShell.jsx'), 'utf8');
const ganaderiaAuthRouteSource = fs.readFileSync(
  path.resolve(SRC_DIR, '..', 'server', 'routes', 'ganaderiaAuth.js'),
  'utf8',
);

function stripComments(source) {
  return source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// ---------------------------------------------------------------------
// §3 -- Nunca autorización por comparación de identidad frontend
// ---------------------------------------------------------------------

test('RequireGanaderiaSuperAdmin.jsx: nunca compara email/nombre/username -- decide solo por rolInterno backend-derived', () => {
  const codeOnly = stripComments(requireSuperAdminSource);
  assert.doesNotMatch(codeOnly, /email\s*===/);
  assert.doesNotMatch(codeOnly, /nombre\s*===/);
  assert.doesNotMatch(codeOnly, /username/i);
  assert.doesNotMatch(codeOnly, /localStorage/);
  assert.match(codeOnly, /rolInterno/);
});

// ---------------------------------------------------------------------
// §7/§12 -- Guard de /ganaderia/admin
// ---------------------------------------------------------------------

test('RequireGanaderiaSuperAdmin.jsx: anónimo -> redirect a /ganaderia/login', () => {
  assert.match(requireSuperAdminSource, /status === 'anonymous'[\s\S]*?Navigate to="\/ganaderia\/login" replace/);
});

test('RequireGanaderiaSuperAdmin.jsx: loading aparece antes que cualquier decisión de autorización (anti-flash)', () => {
  const loadingIndex = requireSuperAdminSource.indexOf("status === 'loading'");
  const anonymousIndex = requireSuperAdminSource.indexOf("status === 'anonymous'");
  const rolCheckIndex = requireSuperAdminSource.indexOf("rolInterno !== 'super_admin'");
  assert.ok(loadingIndex > -1 && anonymousIndex > -1 && rolCheckIndex > -1);
  assert.ok(loadingIndex < anonymousIndex);
  assert.ok(anonymousIndex < rolCheckIndex);
});

test('RequireGanaderiaSuperAdmin.jsx: cualquier rolInterno distinto de super_admin (cliente, soporte, operaciones) -> redirect a /ganaderia/dashboard, nunca renderiza children primero', () => {
  assert.match(requireSuperAdminSource, /rolInterno !== 'super_admin'[\s\S]*?Navigate to="\/ganaderia\/dashboard" replace/);
  // El return de children debe ser la ÚLTIMA línea ejecutable -- todas las
  // ramas de redirect ya retornaron antes.
  const childrenIndex = requireSuperAdminSource.lastIndexOf('return children');
  const rolCheckIndex = requireSuperAdminSource.indexOf("rolInterno !== 'super_admin'");
  assert.ok(childrenIndex > rolCheckIndex);
});

// ---------------------------------------------------------------------
// §6/§10 -- RequireGanaderiaAuth redirige al super_admin fuera de rutas cliente
// ---------------------------------------------------------------------

test('RequireGanaderiaAuth.jsx: rolInterno=super_admin en cualquier ruta cliente (dashboard/predios/potreros/etc.) -> redirect a /ganaderia/admin', () => {
  assert.match(requireAuthSource, /rolInterno === 'super_admin'[\s\S]*?Navigate to="\/ganaderia\/admin" replace/);
});

test('RequireGanaderiaAuth.jsx: el chequeo de super_admin ocurre DESPUÉS de resolver loading/anonymous/authenticated_without_org -- nunca antes', () => {
  const loadingIndex = requireAuthSource.indexOf("status === 'loading'");
  const anonymousIndex = requireAuthSource.indexOf("status === 'anonymous'");
  const withoutOrgIndex = requireAuthSource.indexOf("status === 'authenticated_without_org'");
  const superAdminIndex = requireAuthSource.indexOf("rolInterno === 'super_admin'");
  assert.ok(loadingIndex < anonymousIndex);
  assert.ok(anonymousIndex < withoutOrgIndex);
  assert.ok(withoutOrgIndex < superAdminIndex);
});

// ---------------------------------------------------------------------
// §6/§11 -- GanaderiaLogin.jsx ruteo post-login
// ---------------------------------------------------------------------

test('GanaderiaLogin.jsx: usuario ya autenticado como super_admin que visita /login -> redirect a /ganaderia/admin', () => {
  assert.match(loginSource, /rolInterno === 'super_admin'[\s\S]{0,80}Navigate to="\/ganaderia\/admin" replace/);
});

test('GanaderiaLogin.jsx: login exitoso usa el payload FRESCO de refresh() para decidir destino, nunca el rolInterno stale del render anterior', () => {
  const codeOnly = stripComments(loginSource);
  assert.match(codeOnly, /const freshSession = await refresh\(\)/);
  assert.match(codeOnly, /freshSession\?\.rolInterno === 'super_admin'/);
});

// ---------------------------------------------------------------------
// §9 -- Aislamiento del shell administrativo
// ---------------------------------------------------------------------

test('GanaderiaAdminShell.jsx: NUNCA importa GanaderiaShell/GanaderiaSidebar (sidebar operativo de cliente)', () => {
  assert.doesNotMatch(adminShellSource, /GanaderiaShell/);
  assert.doesNotMatch(adminShellSource, /GanaderiaSidebar/);
});

test('GanaderiaAdminShell.jsx: no contiene ninguna etiqueta de módulo operativo de cliente (Predios/Potreros/Animales/Pesajes/Vacunaciones/Tratamientos/Reproducción)', () => {
  const codeOnly = stripComments(adminShellSource);
  const forbiddenLabels = ['Registro de Predio', 'Registro de Potreros', 'Registro de Animales', 'Pesajes', 'Vacunaciones', 'Tratamientos', 'Reproducción', 'Escanear QR'];
  for (const label of forbiddenLabels) {
    assert.doesNotMatch(codeOnly, new RegExp(label));
  }
});

test('GanaderiaAdminShell.jsx: expone los 4 módulos placeholder requeridos + cerrar sesión, sin implementar su lógica', () => {
  for (const label of ['Clientes / organizaciones', 'Crear cuenta', 'Activaciones pendientes', 'Cuentas existentes']) {
    assert.match(adminShellSource, new RegExp(label));
  }
  assert.match(adminShellSource, /Cerrar sesión/);
});

test('GanaderiaAdminShell.jsx: logout hace POST real a /api/ganaderia/auth/logout con X-CSRF-Token (mismo contrato real, nunca un endpoint inventado)', () => {
  const codeOnly = stripComments(adminShellSource);
  assert.match(codeOnly, /fetch\('\/api\/ganaderia\/auth\/logout'/);
  assert.match(codeOnly, /'X-CSRF-Token':\s*csrfToken/);
  assert.match(codeOnly, /credentials:\s*'include'/);
});

// ---------------------------------------------------------------------
// App.jsx -- ruteo
// ---------------------------------------------------------------------

test('App.jsx: existe una ruta /ganaderia/admin envuelta en RequireGanaderiaSuperAdmin, nunca en RequireGanaderiaAuth', () => {
  const adminBlockMatch = appSource.match(/path="\/ganaderia\/admin"[\s\S]*?\/>/);
  assert.ok(adminBlockMatch, 'debe existir la ruta /ganaderia/admin');
  assert.match(adminBlockMatch[0], /RequireGanaderiaSuperAdmin/);
  assert.doesNotMatch(adminBlockMatch[0], /RequireGanaderiaAuth[^S]/);
});

// ---------------------------------------------------------------------
// Contrato backend -- solo lectura, referencia (server/routes/ganaderiaAuth.js)
// ---------------------------------------------------------------------

test('server/routes/ganaderiaAuth.js: /session deriva tipoAcceso/rolInterno desde resolveInternalRole (staff_crh), nunca desde el body de la request', () => {
  assert.match(ganaderiaAuthRouteSource, /resolveInternalRole\(identity\.cuentaId\)/);
  assert.doesNotMatch(stripComments(ganaderiaAuthRouteSource), /req\.body\.rolInterno/);
  assert.doesNotMatch(stripComments(ganaderiaAuthRouteSource), /req\.body\.tipoAcceso/);
});

test('server/routes/ganaderiaAuth.js: la rama interna se resuelve ANTES de listOrganizacionesDisponibles -- un super_admin nunca cae en la rama "sin organización" de cliente', () => {
  const internalIndex = ganaderiaAuthRouteSource.indexOf('resolveInternalRole(identity.cuentaId)');
  const orgListIndex = ganaderiaAuthRouteSource.indexOf('listOrganizacionesDisponibles(identity.cuentaId)');
  assert.ok(internalIndex > -1 && orgListIndex > -1);
  assert.ok(internalIndex < orgListIndex);
});

test('GanaderiaAuthContext.jsx: un super_admin resuelve directo a status "authenticated" -- nunca "authenticated_without_org" (nunca ve OrganizacionRequerida)', () => {
  const codeOnly = stripComments(authContextSource);
  assert.match(codeOnly, /rolInterno === 'super_admin'\) return 'authenticated'/);
});
