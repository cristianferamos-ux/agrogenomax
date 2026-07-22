import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildLookupId } from '../catastrox.js';

const LOOKUP_ID_PATTERN = /^cx-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(currentDir, '..', 'catastrox.js');
const source = readFileSync(sourcePath, 'utf8');

test('buildLookupId devuelve un UUID v4 con prefijo cx-', () => {
  const id = buildLookupId();
  assert.match(id, LOOKUP_ID_PATTERN);
});

test('buildLookupId genera identificadores únicos en 10000 llamadas', () => {
  const seen = new Set();
  for (let i = 0; i < 10000; i += 1) {
    seen.add(buildLookupId());
  }
  assert.strictEqual(seen.size, 10000);
});

test('buildLookupId es compatible con encodeURIComponent y claves de Map', () => {
  const id = buildLookupId();

  assert.strictEqual(encodeURIComponent(id), id);

  const store = new Map();
  store.set(id, { value: 'ok' });
  assert.strictEqual(store.has(id), true);
  assert.deepStrictEqual(store.get(id), { value: 'ok' });
});

test('regresión: buildLookupId no usa Date.now ni Math.random', () => {
  const match = source.match(/export function buildLookupId\(\)\s*{([\s\S]*?)\n}/);
  assert.ok(match, 'no se encontró la función buildLookupId en el archivo fuente');

  const body = match[1];
  assert.doesNotMatch(body, /Date\.now/);
  assert.doesNotMatch(body, /Math\.random/);
  assert.match(body, /randomUUID/);
});

test('regresión: /advanced/lookup no permite que el cliente elija lookupId', () => {
  const start = source.indexOf("router.post('/advanced/lookup'");
  assert.ok(start !== -1, 'no se encontró la ruta /advanced/lookup');

  const end = source.indexOf("router.get('/audit/resolver-shadow'", start);
  assert.ok(end !== -1, 'no se encontró el final de la ruta /advanced/lookup');

  const handlerSource = source.slice(start, end);

  assert.doesNotMatch(handlerSource, /req\.body\?\.lookup_id/);
  assert.doesNotMatch(handlerSource, /req\.body\?\.routeId/);
  assert.doesNotMatch(handlerSource, /req\.body\.lookup_id/);
  assert.doesNotMatch(handlerSource, /req\.body\.routeId/);
  assert.doesNotMatch(handlerSource, /requestedLookupId/);
  assert.match(handlerSource, /const lookupId = buildLookupId\(\);/);
});

test('regresión: CLEAN_FULL_RESULT_BY_POINT_QUERY usa $3 y no interpola CATASTROX_ORIGEN_NACIONAL_PROJ', () => {
  const start = source.indexOf('const CLEAN_FULL_RESULT_BY_POINT_QUERY');
  assert.ok(start !== -1, 'no se encontró CLEAN_FULL_RESULT_BY_POINT_QUERY');

  const end = source.indexOf('const LEGACY_FULL_RESULT_QUERY', start);
  assert.ok(end !== -1, 'no se encontró el final de CLEAN_FULL_RESULT_BY_POINT_QUERY');

  const queryBlock = source.slice(start, end);

  assert.doesNotMatch(queryBlock, /\$\{CATASTROX_ORIGEN_NACIONAL_PROJ\}/);
  assert.match(queryBlock, /\$3/);
});
