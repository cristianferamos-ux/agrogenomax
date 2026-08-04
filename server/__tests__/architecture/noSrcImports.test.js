// HOTFIX RAILWAY (CATX-DELIVERY-001): producción falló con ERR_MODULE_NOT_FOUND
// porque catastroxPdfGenerator.js importaba en tiempo de ejecución desde
// src/ -- Railway instala/ejecuta solo server/ (npm ci --prefix server,
// npm --prefix server start), la imagen runtime nunca garantiza que exista
// nada fuera de server/. Una simulación de runtime aislado (solo server/
// copiado a un directorio limpio) reveló un SEGUNDO caso real del mismo
// problema: server/config/env.js y server/security/corsPolicy.js
// importaban shared/security/corsPolicy.js (hermano de server/, tampoco
// garantizado) -- mitigado con server/security/corsPolicyCore.js (copia).
//
// Por eso esta prueba es deliberadamente más amplia que "solo /src/": falla
// si CUALQUIER import relativo de CUALQUIER archivo .js bajo server/
// (excluyendo __tests__) resuelve a una ruta FUERA de server/ -- por ruta
// real ya resuelta, no por conteo de "../", así que cubre cualquier
// profundidad y cualquier carpeta hermana futura (src/, shared/, scripts/,
// etc.), no solo las ya conocidas.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_ROOT = path.resolve(REPO_ROOT, 'server');

const IMPORT_RE = /(?:import\s+[^'"]*?from\s+|import\s*\(\s*|export\s+[^'"]*?from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g;

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) out.push(full);
  }
  return out;
}

test('ningún archivo bajo server/ importa (en tiempo de ejecución) desde fuera de server/', () => {
  const files = listJsFiles(SERVER_ROOT);
  assert.ok(files.length > 20, 'la lista de archivos server/ parece incompleta -- revisar listJsFiles');

  const violations = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(content))) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue; // solo imports relativos -- paquetes npm no aplican
      const resolved = path.resolve(path.dirname(file), spec);
      if (resolved !== SERVER_ROOT && !resolved.startsWith(SERVER_ROOT + path.sep)) {
        violations.push(`${path.relative(REPO_ROOT, file)} -> "${spec}" (resuelve a ${path.relative(REPO_ROOT, resolved)}, fuera de server/)`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `server/ no puede importar nada fuera de server/ en tiempo de ejecución (Railway solo instala server/):\n${violations.join('\n')}`,
  );
});
