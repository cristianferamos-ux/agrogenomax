import { fileURLToPath } from 'node:url';
import { requireAnimalesIntegrationEnv } from './animales-integration-env.mjs';
import { runTestFiles } from './test-runner.mjs';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
try {
  await requireAnimalesIntegrationEnv();
  process.exitCode = await runTestFiles([
    'server/services/__tests__/animalesSchemaIntegration.test.js',
    'server/services/__tests__/animalesRepositoryIntegration.test.js',
    'server/services/__tests__/qrInventarioIntegration.test.js',
    'server/services/__tests__/syncPullIntegration.test.js',
    'server/services/__tests__/animalPesajesIntegration.test.js',
    'server/services/__tests__/reporteProductivoIntegration.test.js',
  ], { requiredPasses: {
    'server/services/__tests__/animalesSchemaIntegration.test.js': 24,
    'server/services/__tests__/animalesRepositoryIntegration.test.js': 27,
    'server/services/__tests__/qrInventarioIntegration.test.js': 26,
    'server/services/__tests__/syncPullIntegration.test.js': 3,
    'server/services/__tests__/animalPesajesIntegration.test.js': 14,
    'server/services/__tests__/reporteProductivoIntegration.test.js': 5,
  } });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
