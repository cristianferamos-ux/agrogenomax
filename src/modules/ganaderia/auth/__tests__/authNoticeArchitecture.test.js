// SPRINT-3D10.5 F3b: gates de arquitectura del aviso global de sesión y del
// logout resiliente. Tests por código fuente (el repo no tiene jsdom).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.resolve(__dirname, '..');
const GANADERIA_DIR = path.resolve(AUTH_DIR, '..');
const SRC_DIR = path.resolve(GANADERIA_DIR, '..', '..');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const noticeCode = stripComments(read(path.join(AUTH_DIR, 'GanaderiaAuthNotice.jsx')));
const contextCode = stripComments(read(path.join(AUTH_DIR, 'GanaderiaAuthContext.jsx')));
const modelCode = stripComments(read(path.join(AUTH_DIR, 'ganaderiaAuthUiModel.js')));
const sidebarCode = stripComments(read(path.join(GANADERIA_DIR, 'components', 'GanaderiaSidebar.jsx')));
const adminShellCode = stripComments(read(path.join(GANADERIA_DIR, 'admin', 'GanaderiaAdminShell.jsx')));
// Sin stripComments: `path="/ganaderia/*"` contiene "/*" y se confundiría
// con un comentario de bloque. El regex exige `path="..."`, así que los
// comentarios JSX no interfieren.
const appSource = read(path.join(SRC_DIR, 'App.jsx'));

// A. Topología: justificación del CTA con transición local explícita.
test('topología: todas las rutas de Ganadería montan GanaderiaAuthProvider como raíz del element (misma posición -> instancia reutilizada al navegar)', () => {
  for (const route of ['/ganaderia/login', '/ganaderia/dashboard', '/ganaderia/admin', '/ganaderia/*']) {
    const escaped = route.replace(/[/*]/g, (c) => `\\${c}`);
    const block = appSource.match(new RegExp(`path="${escaped}"\\s*element=\\{\\s*<([A-Za-z]+)`));
    assert.ok(block, `ruta ${route} no encontrada`);
    assert.equal(block[1], 'GanaderiaAuthProvider', route);
  }
});

// 3/4/5 -- el componente respeta `dismissible` del modelo.
test('GanaderiaAuthNotice: el botón Cerrar solo existe si content.dismissible', () => {
  assert.match(noticeCode, /\{content\.dismissible \? \(\s*<button[^>]*onClick=\{onDismiss\}/);
  assert.match(noticeCode, /role="alert"/);
});

// 6 -- CTA SESSION_EXPIRED: estado local coherente ANTES de navegar.
test('GanaderiaAuthNotice: CTA LOGIN llama onEndSession() antes de navigate(/ganaderia/login); RELOAD recarga', () => {
  const fn = noticeCode.match(/function handleCta\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(fn, /if \(content\.cta === AUTH_NOTICE_CTA\.LOGIN\) \{\s*onEndSession\(\);\s*navigate\('\/ganaderia\/login', \{ replace: true \}\);\s*return;\s*\}/);
  assert.match(fn, /window\.location\.reload\(\);/);
});

test('GanaderiaAuthNotice: sin navegación fuera del CTA (ningún Navigate ni useEffect)', () => {
  assert.equal((noticeCode.match(/navigate\(/g) || []).length, 1);
  assert.doesNotMatch(noticeCode, /<Navigate|useEffect/);
});

test('GanaderiaAuthNotice: no importa APIs de negocio ni el cliente HTTP', () => {
  const imports = [...noticeCode.matchAll(/^import (?:[\s\S]*? from )?'([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['../styles/ganaderia-auth-notice.css', './ganaderiaAuthUiModel.js', 'react-router-dom'].sort());
});

// 7 -- emitir un aviso NUNCA redirige, refresca ni hace logout.
test('Provider: el listener de la señal solo actualiza el aviso vía nextAuthNotice (sin refresh/navigate/logout)', () => {
  const listener = contextCode.match(/subscribeAuthNotice\(\(kind\) => \{[\s\S]*?\}\);/)?.[0] ?? '';
  assert.ok(listener, 'listener no encontrado');
  assert.match(listener, /if \(!shouldAcceptAuthNotice\(statusRef\.current\)\) return;/);
  assert.match(listener, /setAuthNotice\(\(current\) => nextAuthNotice\(current, kind\)\);/);
  assert.doesNotMatch(listener, /refresh|navigate|logout|setStatus|setSession/i);
  assert.doesNotMatch(contextCode, /useNavigate|<Navigate/);
});

// 8 -- subscribe/unsubscribe.
test('Provider: se suscribe en un useEffect de montaje y devuelve el cleanup de subscribeAuthNotice', () => {
  assert.match(contextCode, /useEffect\(\(\) => \{\s*return subscribeAuthNotice\(\(kind\) => \{[\s\S]*?\}\);\s*\}, \[\]\);/);
});

test('Provider: endSessionLocally deja status anonymous, session null y aviso null (sin red)', () => {
  const fn = contextCode.match(/const endSessionLocally = useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/)?.[0] ?? '';
  assert.match(fn, /statusRef\.current = 'anonymous';/);
  assert.match(fn, /setSession\(null\);/);
  assert.match(fn, /setStatus\('anonymous'\);/);
  assert.match(fn, /setAuthNotice\(null\);/);
  assert.doesNotMatch(fn, /fetch|refresh|logout/i);
  assert.match(contextCode, /endSessionLocally,\s*\}\),/);
});

test('Provider: una sesión resuelta de nuevo (refresh) limpia el aviso', () => {
  const fn = contextCode.match(/const refresh = useCallback\(async \(\) => \{[\s\S]*?\}, \[\]\);/)?.[0] ?? '';
  assert.equal((fn.match(/setAuthNotice\(null\);/g) || []).length, 2);
});

test('Provider: renderiza un único GanaderiaAuthNotice con el aviso, dismiss y endSessionLocally', () => {
  assert.equal((contextCode.match(/<GanaderiaAuthNotice /g) || []).length, 1);
  assert.match(contextCode, /<GanaderiaAuthNotice notice=\{authNotice\} onDismiss=\{dismissNotice\} onEndSession=\{endSessionLocally\} \/>/);
});

// 14/15 -- Sidebar y AdminShell delegan en performGanaderiaLogout.
for (const [name, code, setter] of [
  ['GanaderiaSidebar.jsx', sidebarCode, 'setLogoutError'],
  ['GanaderiaAdminShell.jsx', adminShellCode, 'setError'],
]) {
  test(`${name}: delega en performGanaderiaLogout + resolveLogoutUiAction, sin fetchCsrfToken/fetch/refresh`, () => {
    assert.match(code, /const outcome = await performGanaderiaLogout\(\);\s*const action = resolveLogoutUiAction\(outcome\);/);
    assert.match(code, new RegExp(`if \\(!action\\.endSession\\) \\{\\s*${setter}\\(action\\.message\\);\\s*setLoggingOut\\(false\\);\\s*return;\\s*\\}\\s*endSessionLocally\\(\\);\\s*navigate\\('\\/ganaderia\\/login', \\{ replace: true \\}\\);`));
    assert.doesNotMatch(code, /fetchCsrfToken/);
    assert.doesNotMatch(code, /\bfetch\(/);
    assert.doesNotMatch(code, /refresh\(\)/);
  });
}

// 16/17 -- GanaderiaLogin intacto, sin return path.
test('sin return path: ningún archivo de auth/ usa location.state/from/returnTo/redirectTo', () => {
  for (const file of fs.readdirSync(AUTH_DIR).filter((f) => /\.(js|jsx)$/.test(f))) {
    const code = stripComments(read(path.join(AUTH_DIR, file)));
    assert.doesNotMatch(code, /location\.state|returnTo|redirectTo|state: \{ from/, file);
  }
  const loginCode = stripComments(read(path.join(GANADERIA_DIR, 'pages', 'GanaderiaLogin.jsx')));
  assert.doesNotMatch(loginCode, /location\.state|returnTo|redirectTo/);
});

test('modelo de UI: JS puro, sin React/window', () => {
  assert.doesNotMatch(modelCode, /from 'react'|\bwindow\b|\bdocument\b/);
});
