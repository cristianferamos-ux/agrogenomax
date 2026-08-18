// SPRINT-3C1.2 §1/§3: guarda de entrada del script dedicado
// `npm run test:ganaderia-predios-integration`. A diferencia de
// `npm run test:node` (donde esta misma suite se auto-omite si la DB de
// prueba no está configurada, para no romper el pipeline general), este
// script existe específicamente para correr los tests reales de
// Postgres/PostGIS de "Mis Predios" -- si alguien lo invoca sin la base
// desechable configurada, debe fallar de forma clara y explícita, nunca
// omitirse en silencio (eso ocultaría que la suite simplemente no corrió).
//
// Lee EXCLUSIVAMENTE AGX_BUSINESS_DATABASE_URL_TEST -- nunca
// AGX_BUSINESS_DATABASE_URL (esa es la variable de producción/runtime
// real). No importa ningún módulo del servidor, no contiene ningún
// hostname/contraseña/connection string real.
if (!process.env.AGX_BUSINESS_DATABASE_URL_TEST) {
  console.error('AGX_BUSINESS_DATABASE_URL_TEST is required for real integration tests.');
  console.error('Ver db/agx-business/migrations/README.md para levantar el Postgres/PostGIS desechable.');
  process.exit(1);
}
