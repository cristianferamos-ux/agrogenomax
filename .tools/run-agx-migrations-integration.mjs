#!/usr/bin/env node
// HARDENING PRE-SANIDAD (PR A) -- `npm run test:agx-migrations-integration`.
// Levanta clusters Docker desechables (PostGIS 16 para Business,
// PostgreSQL 18 para Auth, mismas versiones mayores que producción), corre
// la integración real del runner y los destruye. Una omisión es un fallo.
//
// FASE 5A.1a: la integración de 0028 (migración real posterior al ledger)
// usa su PROPIO cluster Business: los roles (agx_app, agx_owner...) son
// globales del cluster y 0000 fija la contraseña de agx_app en cada
// construcción, así que dos archivos en paralelo sobre el mismo cluster se
// pisarían.
import { fileURLToPath } from 'node:url';
import { startCluster, stopCluster } from './agx-docker-pg.mjs';
import { runTestFiles } from './test-runner.mjs';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const FILE = '.tools/integration/agxMigrateIntegration.test.mjs';
const FILE_0028 = '.tools/integration/agxBusiness0028Integration.test.mjs';
let business;
let auth;
let business0028;
try {
  business = await startCluster('business', 'mig-business');
  auth = await startCluster('auth', 'mig-auth');
  business0028 = await startCluster('business', 'mig-0028');
  process.env.AGX_MIG_BUSINESS_ADMIN_URL = business.adminUrl();
  process.env.AGX_MIG_AUTH_ADMIN_URL = auth.adminUrl();
  process.env.AGX_MIG_0028_BUSINESS_ADMIN_URL = business0028.adminUrl();
  // psql del propio contenedor (16 en Business, 18 en Auth) para pruebas de semántica de psql.
  process.env.AGX_MIG_BUSINESS_CONTAINER = business.name;
  process.env.AGX_MIG_AUTH_CONTAINER = auth.name;
  process.exitCode = await runTestFiles([FILE, FILE_0028], { requiredPasses: { [FILE]: 26, [FILE_0028]: 31 } });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  stopCluster(business);
  stopCluster(auth);
  stopCluster(business0028);
}
