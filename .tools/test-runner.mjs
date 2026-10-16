import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import fs from 'node:fs';

// Files go directly to Node's process-isolated runner, never through a shell.
export async function runTestFiles(files, { requiredPasses = {}, output = process.stdout } = {}) {
  if (!Array.isArray(files) || !files.length) {
    throw new Error('El manifiesto de pruebas está vacío.');
  }
  for (const file of files) {
    if (typeof file !== 'string' || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`Archivo de pruebas inexistente o inválido: ${String(file)}`);
    }
  }
  const required = new Map(Object.entries(requiredPasses).map(([file, minimum]) => [path.resolve(file), minimum]));
  const passed = new Map();
  let failed = false;
  let omitted = false;
  const stream = run({ files, isolation: 'process', concurrency: true });
  stream.on('test:fail', (event) => {
    if (!event.todo) failed = true;
    if (event.skip || event.todo) omitted = true;
  });
  stream.on('test:pass', (event) => {
    if (event.skip || event.todo) omitted = true;
    else if (event.details.type === 'test' && event.file) {
      const file = path.resolve(event.file);
      // Node reports an empty file as a passing test named after its path.
      if (path.resolve(event.name) !== file) passed.set(file, (passed.get(file) ?? 0) + 1);
    }
  });
  try {
    await pipeline(stream.compose(spec), output, { end: false });
  } catch {
    console.error('Error de infraestructura o reporte durante la ejecución de pruebas.');
    return 1;
  }
  if (required.size && omitted) {
    console.error('Integración obligatoria: no se permiten pruebas ni suites omitidas (skip/todo).');
    failed = true;
  }
  for (const [file, minimum] of required) {
    if ((passed.get(file) ?? 0) < minimum) {
      console.error(`Integración obligatoria: ${path.basename(file)} requiere al menos ${minimum} pruebas aprobadas.`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}
