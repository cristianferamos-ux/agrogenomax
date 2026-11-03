import { fileURLToPath } from 'node:url';
import { requireAnimalesIntegrationEnv } from './animales-integration-env.mjs';
import { runTestFiles } from './test-runner.mjs';

// FASE 4A: integración real de reproducción bovina (0026) contra la misma
// base desechable que la suite de animales. FASE 4C: + tablero reproductivo
// de la organización (estados/alertas en SQL y paridad con el modelo JS).
// FASE 4D: + analítica reproductiva. Exige 0026 aplicada: los tests se auto-omiten sin ella y aquí una omisión
// es un fallo.
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
try {
  await requireAnimalesIntegrationEnv();
  process.exitCode = await runTestFiles([
    'server/services/__tests__/reproduccionIntegration.test.js',
    'server/services/__tests__/reproduccionTableroIntegration.test.js',
    'server/services/__tests__/reproduccionAnaliticaIntegration.test.js',
  ], { requiredPasses: {
    'server/services/__tests__/reproduccionIntegration.test.js': 36,
    'server/services/__tests__/reproduccionTableroIntegration.test.js': 14,
    'server/services/__tests__/reproduccionAnaliticaIntegration.test.js': 14,
  } });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
