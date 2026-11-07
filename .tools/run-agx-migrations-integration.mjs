#!/usr/bin/env node
// HARDENING PRE-SANIDAD (PR A) -- `npm run test:agx-migrations-integration`.
// Levanta dos clusters Docker desechables (PostGIS 16 para Business,
// PostgreSQL 18 para Auth, mismas versiones mayores que producción), corre
// la integración real del runner y los destruye. Una omisión es un fallo.
import { fileURLToPath } from 'node:url';
import { startCluster, stopCluster } from './agx-docker-pg.mjs';
import { runTestFiles } from './test-runner.mjs';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const FILE = '.tools/integration/agxMigrateIntegration.test.mjs';
let business;
let auth;
try {
  business = await startCluster('business', 'mig-business');
  auth = await startCluster('auth', 'mig-auth');
  process.env.AGX_MIG_BUSINESS_ADMIN_URL = business.adminUrl();
  process.env.AGX_MIG_AUTH_ADMIN_URL = auth.adminUrl();
  process.exitCode = await runTestFiles([FILE], { requiredPasses: { [FILE]: 16 } });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  stopCluster(business);
  stopCluster(auth);
}
