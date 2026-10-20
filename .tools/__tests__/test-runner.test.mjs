import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

function run(mode, strict) {
  const env = { ...process.env, AGX_RUNNER_FIXTURE: mode };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['.tools/__tests__/fixtures/run-case.mjs', ...(strict ? ['--strict'] : [])], {
    encoding: 'utf8', timeout: 15000, env,
  });
}
for (const strict of [false, true]) {
  for (const mode of ['pass', 'fail', 'skip', 'todo', 'dynamic-skip', 'fail-todo', 'suite-skip', 'empty']) {
    test(`${strict ? 'estricto' : 'general'}: ${mode}`, () => {
      const result = run(mode, strict);
      assert.equal(result.error, undefined);
      assert.equal(result.status, mode === 'fail' || (strict && mode !== 'pass') ? 1 : 0, result.stderr + result.stdout);
    });
  }
}
test('manifiesto general: conserva los 187 archivos existentes, sin duplicados', () => {
  const files = JSON.parse(fs.readFileSync('.tools/node-test-files.json', 'utf8'));
  assert.equal(files.length, 187);
  assert.equal(new Set(files).size, files.length);
  for (const file of files) assert.ok(fs.existsSync(file), file);
});

test('archivo inexistente: no puede devolver éxito', () => {
  const result = spawnSync(
    process.execPath,
    ['--test', '.tools/__tests__/fixtures/archivo-inexistente-3d11.test.mjs'],
    { encoding: 'utf8', timeout: 15000 },
  );
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
});

test('ejecutor: manifiesto vacío es rechazado', async () => {
  const { runTestFiles } = await import('../test-runner.mjs');
  await assert.rejects(
    runTestFiles([]),
    /manifiesto de pruebas.*vacío/i,
  );
});