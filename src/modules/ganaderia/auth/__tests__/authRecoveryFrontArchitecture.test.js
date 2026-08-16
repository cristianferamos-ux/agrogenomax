// AUTH-RECOVERY-002 §10/§11/§13: pruebas arquitectónicas (análisis de texto
// fuente, no en tiempo de ejecución) -- mismo patrón que authFrontArchitecture.test.js
// (no hay jsdom/testing-library en este proyecto).
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
const recoverySource = fs.readFileSync(path.join(GANADERIA_DIR, 'pages', 'GanaderiaRecuperarAcceso.jsx'), 'utf8');
const resetSource = fs.readFileSync(path.join(GANADERIA_DIR, 'pages', 'GanaderiaRestablecerContrasena.jsx'), 'utf8');

function stripComments(source) {
  return source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

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

// ---------------------------------------------------------------------
// Rutas públicas en App.jsx
// ---------------------------------------------------------------------

test('App.jsx: /ganaderia/recuperar-acceso es pública (sin RequireGanaderiaAuth ni GanaderiaAuthProvider)', () => {
  const match = appSource.match(/<Route path="\/ganaderia\/recuperar-acceso"[^/]*\/>/);
  assert.ok(match, 'debe existir la ruta /ganaderia/recuperar-acceso tal cual (self-closing, sin guard)');
  assert.ok(!match[0].includes('RequireGanaderiaAuth'));
});

test('App.jsx: existe /ganaderia/restablecer-contrasena, pública, sin RequireGanaderiaAuth', () => {
  const match = appSource.match(/<Route path="\/ganaderia\/restablecer-contrasena"[^/]*\/>/);
  assert.ok(match, 'debe existir la ruta /ganaderia/restablecer-contrasena tal cual (self-closing, sin guard)');
  assert.ok(!match[0].includes('RequireGanaderiaAuth'));
});

// ---------------------------------------------------------------------
// GanaderiaRecuperarAcceso.jsx -- §10
// ---------------------------------------------------------------------

test('GanaderiaRecuperarAcceso.jsx: NUNCA importa GanaderiaShell ni GanaderiaSidebar (layout operativo privado)', () => {
  assert.ok(!/^import .*GanaderiaShell/m.test(recoverySource));
  assert.ok(!/^import .*GanaderiaSidebar/m.test(recoverySource));
});

test('GanaderiaRecuperarAcceso.jsx: no contiene ninguna etiqueta del sidebar operativo privado', () => {
  for (const label of PRIVATE_OPERATIONAL_LABELS) {
    assert.ok(!recoverySource.includes(label), `no debe mostrar "${label}"`);
  }
});

test('GanaderiaRecuperarAcceso.jsx: formulario funcional -- campo de correo, botón, POST a /api/ganaderia/auth/recovery/request', () => {
  assert.match(recoverySource, /type="email"/);
  assert.match(recoverySource, /Enviar enlace de recuperación/);
  assert.match(recoverySource, /\/api\/ganaderia\/auth\/recovery\/request/);
  assert.match(recoverySource, /method:\s*'POST'/);
});

test('GanaderiaRecuperarAcceso.jsx: previene doble envío mientras hay una solicitud en curso (disabled={submitting})', () => {
  assert.match(recoverySource, /disabled=\{submitting\}/);
});

test('GanaderiaRecuperarAcceso.jsx: mensaje de éxito es el genérico anti-enumeración exacto', () => {
  assert.match(
    recoverySource,
    /Si existe una cuenta asociada a ese correo, te enviaremos instrucciones para recuperar el acceso\./,
  );
});

test('GanaderiaRecuperarAcceso.jsx: nunca referencia códigos internos de existencia de cuenta (cuenta_no_encontrada, cuenta_inactiva, etc.)', () => {
  const codeOnly = stripComments(recoverySource);
  assert.doesNotMatch(codeOnly, /cuenta_no_encontrada|cuenta_inactiva|CUENTA_NO_ENCONTRADA/);
});

test('GanaderiaRecuperarAcceso.jsx: incluye enlace de vuelta a /ganaderia/login', () => {
  assert.match(recoverySource, /to="\/ganaderia\/login"/);
  assert.match(recoverySource, /Volver a iniciar sesión/);
});

// ---------------------------------------------------------------------
// GanaderiaRestablecerContrasena.jsx -- §11/§13
// ---------------------------------------------------------------------

test('GanaderiaRestablecerContrasena.jsx: NUNCA importa GanaderiaShell ni GanaderiaSidebar', () => {
  assert.ok(!/^import .*GanaderiaShell/m.test(resetSource));
  assert.ok(!/^import .*GanaderiaSidebar/m.test(resetSource));
});

test('GanaderiaRestablecerContrasena.jsx: lee el token desde la query string (useSearchParams), no desde props/rutas anidadas', () => {
  assert.match(resetSource, /useSearchParams/);
  assert.match(resetSource, /searchParams\.get\('token'\)/);
});

test('GanaderiaRestablecerContrasena.jsx: dos campos de contraseña, valida coincidencia y longitud en cliente', () => {
  const passwordFields = resetSource.match(/type="password"/g) ?? [];
  assert.equal(passwordFields.length, 2, 'debe haber exactamente dos campos type="password"');
  assert.match(resetSource, /newPassword\.length < PASSWORD_MIN_LENGTH|newPassword\.length > PASSWORD_MAX_LENGTH/);
  assert.match(resetSource, /newPassword !== confirmPassword/);
  assert.match(resetSource, /Las contraseñas no coinciden/);
});

test('GanaderiaRestablecerContrasena.jsx: el backend sigue siendo la única autoridad -- valores del cliente coinciden con passwordPolicy.js (15/128)', () => {
  assert.match(resetSource, /PASSWORD_MIN_LENGTH = 15/);
  assert.match(resetSource, /PASSWORD_MAX_LENGTH = 128/);
});

test('GanaderiaRestablecerContrasena.jsx: reutiliza POST /api/ganaderia/auth/password/set -- NO existe ningún otro endpoint de reset', () => {
  const matches = resetSource.match(/fetch\('([^']+)'/g) ?? [];
  assert.equal(matches.length, 1, 'debe hacer exactamente una llamada fetch');
  assert.match(resetSource, /fetch\('\/api\/ganaderia\/auth\/password\/set'/);
});

test('GanaderiaRestablecerContrasena.jsx: 401 del backend produce el mensaje genérico exacto de enlace inválido/expirado', () => {
  assert.match(resetSource, /Este enlace de recuperación no es válido o ha expirado\./);
  assert.match(resetSource, /response\.status === 401/);
});

test('GanaderiaRestablecerContrasena.jsx: token inválido/expirado ofrece "Solicitar un nuevo enlace" hacia /ganaderia/recuperar-acceso', () => {
  assert.match(resetSource, /Solicitar un nuevo enlace/);
  assert.match(resetSource, /to="\/ganaderia\/recuperar-acceso"/);
});

test('GanaderiaRestablecerContrasena.jsx: ausencia de token en la URL se trata igual que token inválido (sin llamar al backend)', () => {
  assert.match(resetSource, /if \(!token \|\| invalidToken\)/);
});

test('GanaderiaRestablecerContrasena.jsx: éxito muestra enlace "Ir a iniciar sesión", nunca auto-login (sin Set-Cookie/navigate automático)', () => {
  assert.match(resetSource, /Ir a iniciar sesión/);
  assert.match(resetSource, /to="\/ganaderia\/login"/);
  const codeOnly = stripComments(resetSource);
  assert.doesNotMatch(codeOnly, /useNavigate/, 'no debe redirigir automáticamente tras el éxito -- el usuario decide cuándo ir a login');
});

test('GanaderiaRestablecerContrasena.jsx: nunca importa GanaderiaAuthContext/useGanaderiaAuth -- esta pantalla no depende de sesión', () => {
  assert.ok(!/GanaderiaAuthContext|useGanaderiaAuth/.test(resetSource));
});
