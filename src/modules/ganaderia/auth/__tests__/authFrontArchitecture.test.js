// AUTH-FRONT-001: pruebas arquitectónicas (análisis de texto fuente, no en
// tiempo de ejecución) -- mismo patrón ya usado en este repositorio para
// verificar garantías de control de flujo en componentes React sin montar
// un DOM (ver src/modules/catastrox/pages/__tests__/
// catastroxFiscalReviewArchitecture.test.js, server/__tests__/
// architecture/noSrcImports.test.js). No hay jsdom/testing-library en este
// proyecto -- se analiza el código fuente directamente como texto, igual
// que el resto de la suite frontend existente.
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
const guardSource = fs.readFileSync(path.join(AUTH_DIR, 'RequireGanaderiaAuth.jsx'), 'utf8');
const orgRequiredSource = fs.readFileSync(path.join(AUTH_DIR, 'OrganizacionRequerida.jsx'), 'utf8');
const loginSource = fs.readFileSync(path.join(GANADERIA_DIR, 'pages', 'GanaderiaLogin.jsx'), 'utf8');
const accessSource = fs.readFileSync(path.join(GANADERIA_DIR, 'pages', 'GanaderiaAccess.jsx'), 'utf8');
const ganaderiaAppSource = fs.readFileSync(path.join(GANADERIA_DIR, 'GanaderiaApp.jsx'), 'utf8');
const ganaderiaApiSource = fs.readFileSync(path.join(GANADERIA_DIR, 'api', 'ganaderiaApi.js'), 'utf8');

// Varios comentarios explicativos de este propio lote citan literalmente
// los términos que las pruebas de abajo buscan prohibir (documentando la
// intención, p. ej. "nunca usa localStorage") -- para no generar falsos
// positivos por texto de comentario, se elimina el comentario antes de
// buscar en el CÓDIGO real.
function stripComments(source) {
  return source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// ---------------------------------------------------------------------
// §3 -- Botón de acceso
// ---------------------------------------------------------------------

test('GanaderiaAccess.jsx: "Ingresar a mi cuenta" navega a /ganaderia/login, no a /ganaderia/dashboard', () => {
  const primaryBlockMatch = accessSource.match(/primary=\{\{[\s\S]*?label: 'Ingresar a mi cuenta',[\s\S]*?to: '([^']+)'/);
  assert.ok(primaryBlockMatch, 'debe existir el botón "Ingresar a mi cuenta"');
  assert.equal(primaryBlockMatch[1], '/ganaderia/login');
});

test('GanaderiaAccess.jsx: "Cuenta Demo" sigue apuntando a /ganaderia/demo (no tocado)', () => {
  assert.match(accessSource, /label: 'Entrar a la demo', to: '\/ganaderia\/demo'/);
});

test('GanaderiaAccess.jsx: "Planes y precios" sigue apuntando a /ganaderia/planes (no tocado)', () => {
  assert.match(accessSource, /primary=\{\{ label: 'Ver planes', to: '\/ganaderia\/planes' \}\}/);
});

test('GanaderiaAccess.jsx: "Recuperar acceso" apunta a la ruta pública dedicada, no a proximamente/:modulo (ahora privada)', () => {
  const secondaryBlockMatch = accessSource.match(/secondary=\{\{[\s\S]*?to: '([^']+)'/);
  assert.ok(secondaryBlockMatch);
  assert.equal(secondaryBlockMatch[1], '/ganaderia/recuperar-acceso');
});

// ---------------------------------------------------------------------
// §13 -- Clasificación de rutas en App.jsx
// ---------------------------------------------------------------------

// JSX real: cada <Route .../> aquí es self-closing (element={...} inline),
// no <Route>...</Route> -- se extrae el bloque completo de la ruta
// partiendo el archivo en cada apertura "<Route" y localizando el bloque
// cuyo `path` coincide, en vez de intentar balancear JSX con una sola
// expresión regular.
function findRouteBlock(source, routePath) {
  const blocks = source.split(/(?=<Route\b)/);
  return blocks.find((block) => block.includes(`path="${routePath}"`));
}

test('App.jsx: existe una ruta explícita /ganaderia/login (no cae en el catch-all /ganaderia/*)', () => {
  assert.match(appSource, /path="\/ganaderia\/login"/);
});

test('App.jsx: /ganaderia/login NO está envuelta en RequireGanaderiaAuth (debe ser pública)', () => {
  const loginRouteBlock = findRouteBlock(appSource, '/ganaderia/login');
  assert.ok(loginRouteBlock);
  assert.ok(!loginRouteBlock.includes('RequireGanaderiaAuth'));
  assert.ok(loginRouteBlock.includes('GanaderiaAuthProvider'), 'debe seguir dentro del provider (para poder redirigir si ya hay sesión)');
});

test('App.jsx: /ganaderia/dashboard está envuelta en RequireGanaderiaAuth', () => {
  const dashRouteBlock = findRouteBlock(appSource, '/ganaderia/dashboard');
  assert.ok(dashRouteBlock);
  assert.ok(dashRouteBlock.includes('RequireGanaderiaAuth'));
});

test('App.jsx: /ganaderia/* (GanaderiaApp -- predios/potreros/animales/etc.) está envuelta en RequireGanaderiaAuth', () => {
  const wildcardRouteBlock = findRouteBlock(appSource, '/ganaderia/*');
  assert.ok(wildcardRouteBlock);
  assert.ok(wildcardRouteBlock.includes('RequireGanaderiaAuth'));
});

test('App.jsx: /qr/:codigo permanece pública -- NO envuelta en RequireGanaderiaAuth (uso público por QR físico)', () => {
  const qrRouteMatch = appSource.match(/<Route path="\/qr\/:codigo"[^/]*\/>/);
  assert.ok(qrRouteMatch, 'debe existir la ruta /qr/:codigo tal cual (self-closing, sin guard)');
  assert.ok(!qrRouteMatch[0].includes('RequireGanaderiaAuth'));
});

test('App.jsx: /ganaderia/acceso, /ganaderia/demo, /ganaderia/planes, /ganaderia/recuperar-acceso permanecen públicas (sin RequireGanaderiaAuth)', () => {
  for (const routePath of ['/ganaderia/acceso', '/ganaderia/demo', '/ganaderia/planes', '/ganaderia/recuperar-acceso']) {
    const match = appSource.match(new RegExp(`<Route path="${routePath.replace(/\//g, '\\/')}"[^/]*\\/>`));
    assert.ok(match, `debe existir la ruta ${routePath}`);
    assert.ok(!match[0].includes('RequireGanaderiaAuth'), `${routePath} no debe requerir sesión`);
  }
});

// ---------------------------------------------------------------------
// §4/§12 -- Login público, sin layout operativo privado
// ---------------------------------------------------------------------

const PRIVATE_OPERATIONAL_LABELS = [
  'Registro de Predio',
  'Registro de Potreros',
  'Mis animales',
  'Registro de Animales',
  'Escanear QR',
  'Ficha Animal',
  'Pesajes',
  'Vacunaciones',
  'Tratamientos',
  'Reproducción',
  'Genética',
  'Reportes',
];

test('GanaderiaLogin.jsx: NUNCA importa GanaderiaShell ni GanaderiaSidebar (layout operativo privado)', () => {
  assert.ok(!/^import .*GanaderiaShell/m.test(loginSource));
  assert.ok(!/^import .*GanaderiaSidebar/m.test(loginSource));
  assert.ok(!loginSource.includes('<GanaderiaShell') && !loginSource.includes('<GanaderiaSidebar'));
});

test('GanaderiaLogin.jsx: no contiene ninguna de las etiquetas del sidebar operativo privado', () => {
  for (const label of PRIVATE_OPERATIONAL_LABELS) {
    assert.ok(!loginSource.includes(label), `GanaderiaLogin.jsx no debe mostrar "${label}"`);
  }
});

test('GanaderiaLogin.jsx: muestra título, correo, contraseña, botón Ingresar, Recuperar acceso y volver a acceso', () => {
  assert.match(loginSource, /AgroGenomaX Ganadería Inteligente/);
  assert.match(loginSource, /type="email"/);
  assert.match(loginSource, /type="password"/);
  assert.match(loginSource, />\s*Ingresar\s*<|Ingresando/);
  assert.match(loginSource, /Recuperar acceso/);
  assert.match(loginSource, /Volver a la pantalla de acceso/);
});

// ---------------------------------------------------------------------
// §5 -- Sin signup
// ---------------------------------------------------------------------

test('GanaderiaLogin.jsx: no ofrece crear cuenta/registro/signup', () => {
  for (const forbidden of ['Crear cuenta', 'Regístrate', 'Registrarse', 'Sign up', 'Signup', 'Registro de cuenta']) {
    assert.ok(!loginSource.includes(forbidden), `no debe contener "${forbidden}"`);
  }
});

// ---------------------------------------------------------------------
// §6 -- Login real: same-origin, credentials include, sin storage de token
// ---------------------------------------------------------------------

test('GanaderiaLogin.jsx: hace POST a /api/ganaderia/auth/login (relativo, same-origin, nunca una URL absoluta de Railway)', () => {
  assert.match(loginSource, /fetch\('\/api\/ganaderia\/auth\/login'/);
  assert.ok(!/https?:\/\/.*railway/i.test(loginSource), 'no debe llamar directamente a Railway');
});

test('GanaderiaLogin.jsx: la llamada de login usa credentials: "include" (cookie HttpOnly server-side)', () => {
  const fetchBlock = loginSource.match(/fetch\('\/api\/ganaderia\/auth\/login'[\s\S]*?\}\);/);
  assert.ok(fetchBlock);
  assert.match(fetchBlock[0], /credentials:\s*'include'/);
});

test('GanaderiaLogin.jsx: nunca escribe el token/sesión en localStorage/sessionStorage/document.cookie (código real, sin contar comentarios)', () => {
  const code = stripComments(loginSource);
  assert.ok(!code.includes('localStorage'));
  assert.ok(!code.includes('sessionStorage'));
  assert.ok(!code.includes('document.cookie'));
});

test('GanaderiaAuthContext.jsx: GET /session usa credentials include y nunca toca localStorage/sessionStorage (código real, sin contar comentarios)', () => {
  assert.match(authContextSource, /fetch\(`\$\{AUTH_BASE\}\/session`/);
  assert.match(authContextSource, /credentials:\s*'include'/);
  const code = stripComments(authContextSource);
  assert.ok(!code.includes('localStorage'));
  assert.ok(!code.includes('sessionStorage'));
});

// ---------------------------------------------------------------------
// §7 -- Semántica de errores, sin enumeración de cuentas
// ---------------------------------------------------------------------

test('GanaderiaLogin.jsx: 401 siempre muestra el mismo mensaje genérico, nunca expone el código real del backend (código real, sin contar comentarios)', () => {
  assert.match(loginSource, /Correo o contraseña incorrectos\./);
  const code = stripComments(loginSource);
  for (const leaky of ['cuenta_no_encontrada', 'sin_password', 'password_incorrecta', 'cuenta_inactiva', 'INVALID_CREDENTIALS']) {
    assert.ok(!code.includes(leaky), `no debe filtrar el código interno "${leaky}" al usuario`);
  }
});

test('GanaderiaLogin.jsx: 429 muestra un mensaje de límite de intentos', () => {
  assert.match(loginSource, /status === 429/);
  assert.match(loginSource, /Demasiados intentos/i);
});

// ---------------------------------------------------------------------
// §8 -- Estados de sesión explícitos, fuente de verdad backend
// ---------------------------------------------------------------------

test('GanaderiaAuthContext.jsx: expone exactamente los 4 estados requeridos', () => {
  for (const state of ["'loading'", "'anonymous'", "'authenticated_without_org'", "'authenticated'"]) {
    assert.ok(authContextSource.includes(state), `debe existir el estado ${state}`);
  }
});

test('GanaderiaAuthContext.jsx: el estado inicial es "loading", nunca "authenticated" por defecto', () => {
  assert.match(authContextSource, /useState\('loading'\)/);
});

// ---------------------------------------------------------------------
// §9 -- Guard privado: orden de ramas (sin flash de contenido privado)
// ---------------------------------------------------------------------

test('RequireGanaderiaAuth.jsx: la rama "loading" aparece ANTES que la rama "anonymous", que aparece ANTES que el render de children', () => {
  const loadingIndex = guardSource.indexOf("status === 'loading'");
  const anonymousIndex = guardSource.indexOf("status === 'anonymous'");
  const childrenIndex = guardSource.lastIndexOf('return children');
  assert.ok(loadingIndex > -1 && anonymousIndex > -1 && childrenIndex > -1);
  assert.ok(
    loadingIndex < anonymousIndex && anonymousIndex < childrenIndex,
    'orden de evaluación debe ser loading -> anonymous -> children (early return en cada rama, nunca fallthrough)',
  );
});

test('RequireGanaderiaAuth.jsx: la rama loading y la rama anonymous retornan explícitamente (early return), no continúan al render privado', () => {
  const loadingBlock = guardSource.match(/if \(status === 'loading'\) \{([\s\S]*?)\n  \}/);
  assert.ok(loadingBlock);
  assert.match(loadingBlock[1], /return \(/);

  const anonymousBlock = guardSource.match(/if \(status === 'anonymous'\) \{\s*return <Navigate/);
  assert.ok(anonymousBlock, 'la rama anonymous debe retornar <Navigate> inmediatamente');
});

test('RequireGanaderiaAuth.jsx: redirige a /ganaderia/login con replace (nunca deja la entrada privada en el historial)', () => {
  assert.match(guardSource, /<Navigate to="\/ganaderia\/login" replace \/>/);
});

// ---------------------------------------------------------------------
// §10 -- Sesión sin organización
// ---------------------------------------------------------------------

test('RequireGanaderiaAuth.jsx: authenticated_without_org NO renderiza directamente children (dashboard) -- renderiza OrganizacionRequerida', () => {
  const orgBlock = guardSource.match(/if \(status === 'authenticated_without_org'\) \{([\s\S]*?)\n  \}/);
  assert.ok(orgBlock);
  assert.match(orgBlock[1], /<OrganizacionRequerida/);
  assert.ok(!orgBlock[1].includes('children'));
});

test('OrganizacionRequerida.jsx: llama a POST /api/ganaderia/auth/organizacion (contrato real, sin inventar otro endpoint)', () => {
  assert.match(orgRequiredSource, /fetch\('\/api\/ganaderia\/auth\/organizacion'/);
  assert.match(orgRequiredSource, /credentials:\s*'include'/);
});

// ---------------------------------------------------------------------
// AUTH-FRONT-001 STAGING GATE §1 -- CSRF: contrato real auditado en
// server/security/ganaderiaSession.js (createRequireGanaderiaCsrf) --
// POST /organizacion y POST /logout EXIGEN X-CSRF-Token; POST /login y
// POST /password/set explícitamente NO (no hay sesión todavía).
// ---------------------------------------------------------------------

test('GanaderiaAuthContext.jsx: expone fetchCsrfToken() contra GET /api/ganaderia/auth/csrf (credentials include)', () => {
  assert.match(authContextSource, /export async function fetchCsrfToken/);
  assert.match(authContextSource, /fetch\(`\$\{AUTH_BASE\}\/csrf`/);
});

test('OrganizacionRequerida.jsx: obtiene un CSRF token fresco y lo envía como X-CSRF-Token en POST /organizacion', () => {
  assert.match(orgRequiredSource, /fetchCsrfToken/);
  const postBlock = orgRequiredSource.match(/fetch\('\/api\/ganaderia\/auth\/organizacion'[\s\S]*?\}\);/);
  assert.ok(postBlock);
  assert.match(postBlock[0], /'X-CSRF-Token':\s*csrfToken/);
});

test('GanaderiaLogin.jsx: POST /login NO envía X-CSRF-Token (contrato real -- sin sesión previa, no aplica)', () => {
  const loginFetchBlock = loginSource.match(/fetch\('\/api\/ganaderia\/auth\/login'[\s\S]*?\}\);/);
  assert.ok(loginFetchBlock);
  assert.ok(!loginFetchBlock[0].includes('X-CSRF-Token'));
});

// ---------------------------------------------------------------------
// §11 -- Usuario ya autenticado visita /login
// ---------------------------------------------------------------------

test('GanaderiaLogin.jsx: si ya está authenticated o authenticated_without_org, redirige (solo tras resolver sesión real, nunca durante loading)', () => {
  // AGX-ADMIN-001: el bloque ahora bifurca por rolInterno antes del
  // redirect a dashboard -- se valida que la condición de entrada siga
  // siendo exactamente la misma (solo tras resolver un status
  // autenticado) y que /ganaderia/dashboard siga siendo el destino final
  // para cualquier cuenta que no sea super_admin.
  const guardMatch = loginSource.match(
    /if \(status === 'authenticated' \|\| status === 'authenticated_without_org'\) \{([\s\S]*?)\n {2}\}/,
  );
  assert.ok(guardMatch, 'debe existir el bloque de redirect condicionado al status ya resuelto');
  assert.match(guardMatch[1], /Navigate to="\/ganaderia\/dashboard" replace/);
});

// ---------------------------------------------------------------------
// §2 -- No se tocó el contrato de backend
// ---------------------------------------------------------------------

test('server/routes/ganaderiaAuth.js: el contrato core de AUTH-001/BFF-001 sigue intacto (AGX-ADMIN-001 solo añadió tipoAcceso/rolInterno, sin tocar login/session/rate-limit)', () => {
  const backendAuthSource = fs.readFileSync(
    path.join(SRC_DIR, '..', 'server', 'routes', 'ganaderiaAuth.js'),
    'utf8',
  );
  // No es una prueba de diff -- documenta el contrato exacto que el
  // frontend asume, para detectar drift futuro si alguien cambia el
  // backend sin actualizar este archivo de referencia.
  assert.match(backendAuthSource, /router\.post\('\/login'/);
  assert.match(backendAuthSource, /router\.get\('\/session'/);
  assert.match(backendAuthSource, /error: 'INVALID_CREDENTIALS'/);
  assert.match(backendAuthSource, /error: 'TOO_MANY_ATTEMPTS'/);
});

// ---------------------------------------------------------------------
// Demo intacto -- no debe importar nada del auth frontend nuevo
// ---------------------------------------------------------------------

test('GanaderiaDemo.jsx no importa GanaderiaAuthContext/RequireGanaderiaAuth (Demo aislado, no tocado)', () => {
  const demoSource = fs.readFileSync(path.join(GANADERIA_DIR, 'pages', 'GanaderiaDemo.jsx'), 'utf8');
  assert.ok(!demoSource.includes('GanaderiaAuthContext'));
  assert.ok(!demoSource.includes('RequireGanaderiaAuth'));
});

// ---------------------------------------------------------------------
// ganaderiaApi.js: credentials include (necesario para que las llamadas
// de datos reales lleven la cookie de sesión tras el login)
// ---------------------------------------------------------------------

test('ganaderiaApi.js: request() envía credentials: "include" en cada fetch', () => {
  assert.match(ganaderiaApiSource, /credentials:\s*'include'/);
});

// ---------------------------------------------------------------------
// GanaderiaApp.jsx: proximamente/:modulo sigue existiendo para otros
// módulos futuros privados (Reportes, etc.) -- recuperar-acceso ya no
// depende de esta ruta genérica.
// ---------------------------------------------------------------------

test('GanaderiaApp.jsx conserva la ruta proximamente/:modulo para módulos privados futuros (no se retiró)', () => {
  assert.match(ganaderiaAppSource, /path="proximamente\/:modulo"/);
});

// ---------------------------------------------------------------------
// UX-TENANT-AUTOSELECT-001: OrganizacionRequerida.jsx auto-selecciona con
// exactamente 1 organización disponible, reutilizando el flujo manual ya
// auditado (mismo endpoint, mismo CSRF, mismo refresh).
// ---------------------------------------------------------------------

test('UX-TENANT-AUTOSELECT-001 1: con 0 organizaciones, el useEffect de auto-select no dispara nada (isSingleOrg=false)', () => {
  assert.match(orgRequiredSource, /const isSingleOrg = organizacionesDisponibles\.length === 1;/);
  const effectBlock = orgRequiredSource.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[isSingleOrg\]\);/)?.[0] ?? '';
  assert.ok(effectBlock, 'debe existir el useEffect de auto-select');
  assert.match(effectBlock, /if \(!isSingleOrg\) return;/);
});

test('UX-TENANT-AUTOSELECT-001 2: con 1 organización, el useEffect llama seleccionarOrganizacion con esa única organizacionId', () => {
  const effectBlock = orgRequiredSource.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[isSingleOrg\]\);/)?.[0] ?? '';
  assert.match(effectBlock, /seleccionarOrganizacion\(organizacionesDisponibles\[0\]\.organizacionId\)/);
});

test('UX-TENANT-AUTOSELECT-001 3: el auto-select reutiliza la MISMA función seleccionarOrganizacion que el selector manual -- no hay una segunda implementación', () => {
  const codeOnly = stripComments(orgRequiredSource);
  const matches = codeOnly.match(/async function seleccionarOrganizacion/g) ?? [];
  assert.equal(matches.length, 1, 'solo debe existir una definición de seleccionarOrganizacion');
  assert.match(codeOnly, /onClick=\{\(\) => seleccionarOrganizacion\(org\.organizacionId\)\}/);
});

test('UX-TENANT-AUTOSELECT-001 4-5: la misma función (auto-select y manual) usa CSRF y credentials include -- contrato sin cambios', () => {
  assert.match(orgRequiredSource, /fetchCsrfToken/);
  const postBlock = orgRequiredSource.match(/fetch\('\/api\/ganaderia\/auth\/organizacion'[\s\S]*?\}\);/)?.[0] ?? '';
  assert.match(postBlock, /'X-CSRF-Token':\s*csrfToken/);
  assert.match(postBlock, /credentials:\s*'include'/);
});

test('UX-TENANT-AUTOSELECT-001 6: refresh() se llama tras un POST /organizacion exitoso, tanto en auto-select como en selección manual', () => {
  const codeOnly = stripComments(orgRequiredSource);
  const seleccionarBody = codeOnly.match(/async function seleccionarOrganizacion[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.ok(seleccionarBody, 'debe existir el cuerpo de seleccionarOrganizacion');
  const notOkIndex = seleccionarBody.indexOf('if (!response.ok)');
  const refreshIndex = seleccionarBody.indexOf('await refresh();');
  assert.ok(notOkIndex >= 0 && refreshIndex >= 0 && notOkIndex < refreshIndex, 'refresh() debe aparecer después de la rama de fallo (que retorna temprano)');
});

test('UX-TENANT-AUTOSELECT-001 7: durante el auto-select no se muestra el selector -- se reemplaza por un mensaje mínimo, sin la lista de organizaciones', () => {
  const codeOnly = stripComments(orgRequiredSource);
  const autoSelectRenderBlock = codeOnly.match(/if \(isSingleOrg && !error\) \{[\s\S]*?\n {2}\}/)?.[0] ?? '';
  assert.ok(autoSelectRenderBlock, 'debe existir el bloque de render exclusivo del auto-select');
  assert.match(autoSelectRenderBlock, /Preparando tu cuenta\.\.\./);
  assert.doesNotMatch(autoSelectRenderBlock, /gan-org-required-list/);
  // Ese bloque debe evaluarse ANTES del selector manual (return temprano).
  const selectorIndex = codeOnly.indexOf('gan-org-required-list');
  const autoSelectIndex = codeOnly.indexOf('isSingleOrg && !error');
  assert.ok(autoSelectIndex >= 0 && selectorIndex >= 0 && autoSelectIndex < selectorIndex);
});

test('UX-TENANT-AUTOSELECT-001 8: con 2+ organizaciones (isSingleOrg=false), se sigue renderizando el selector manual normal', () => {
  assert.match(orgRequiredSource, /organizacionesDisponibles\.length === 0 \? \(/);
  assert.match(orgRequiredSource, /organizacionesDisponibles\.map\(\(org\) => \(/);
});

test('UX-TENANT-AUTOSELECT-001 9: un fallo de auto-select nunca reintenta solo -- guarda por ref (una sola vez por montaje) y el useEffect solo depende de isSingleOrg (no de error/selectingId, que cambian en cada intento)', () => {
  const codeOnly = stripComments(orgRequiredSource);
  assert.match(codeOnly, /const autoSelectAttemptedRef = useRef\(false\);/);
  const effectBlock = codeOnly.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[isSingleOrg\]\);/)?.[0] ?? '';
  assert.match(effectBlock, /if \(autoSelectAttemptedRef\.current\) return;/);
  assert.match(effectBlock, /autoSelectAttemptedRef\.current = true;/);
  // La dependencia del efecto es SOLO isSingleOrg -- setError/setSelectingId
  // (que sí cambian durante el intento) no están en el arreglo de
  // dependencias, así que no pueden re-disparar el efecto.
  assert.doesNotMatch(orgRequiredSource, /\}, \[isSingleOrg, error/);
  assert.doesNotMatch(orgRequiredSource, /\}, \[isSingleOrg, selectingId/);
});

test('UX-TENANT-AUTOSELECT-001 10: un super_admin nunca llega a OrganizacionRequerida -- GanaderiaAuthContext.jsx resuelve su status directo a "authenticated" ANTES de evaluar organizacionActiva', () => {
  const deriveStatusBody = authContextSource.match(/function deriveStatus\(sessionPayload\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(deriveStatusBody, 'debe existir deriveStatus()');
  const superAdminIndex = deriveStatusBody.indexOf("rolInterno === 'super_admin'");
  const orgCheckIndex = deriveStatusBody.indexOf('!sessionPayload.organizacionActiva');
  assert.ok(superAdminIndex >= 0 && orgCheckIndex >= 0 && superAdminIndex < orgCheckIndex, 'el chequeo de super_admin debe evaluarse antes que organizacionActiva, así nunca resuelve a authenticated_without_org');
});
