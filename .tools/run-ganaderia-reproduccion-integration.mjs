import { fileURLToPath } from 'node:url';
import { requireAnimalesIntegrationEnv } from './animales-integration-env.mjs';
import { runTestFiles } from './test-runner.mjs';

// FASE 4A: integración real de reproducción bovina (0026) contra la misma
// base desechable que la suite de animales. Exige 0026 aplicada: el test se
// auto-omite sin ella y aquí una omisión es un fallo.
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
try {
  await requireAnimalesIntegrationEnv();
  process.exitCode = await runTestFiles([
    'server/services/__tests__/reproduccionIntegration.test.js',
  ], { requiredPasses: {
    'server/services/__tests__/reproduccionIntegration.test.js': 35,
  } });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
