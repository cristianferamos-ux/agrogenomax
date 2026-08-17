-- FIX/GANADERIA-SPRINT-2-CLIENT-PROVISIONING
--
-- PRECONDICIÓN DE PRODUCCIÓN: server/routes/ganaderiaAdmin.js (POST
-- /api/ganaderia/admin/clientes) necesita que agx_auth (el rol con el que
-- el backend se conecta a Postgres-AGX) pueda INSERT en agx.organizaciones,
-- agx.cuentas y agx.membresias. Confirmado por auditoría read-only contra
-- producción (2026-08-17, informe Sprint 2 sección B/N): agx_auth tiene
-- HOY solo SELECT en organizaciones/membresias y SELECT+UPDATE en
-- cuentas -- sin este grant, la transacción de POST /clientes falla con
-- "permission denied" en el primer INSERT.
--
-- NO se aplicó a producción en Sprint 2 (fuera de alcance explícito de
-- ese sprint -- "NO ejecutar migraciones"). Debe aplicarse ANTES de que
-- el endpoint pueda usarse contra Postgres-AGX real, con el mismo
-- protocolo de auditoría/backup/prechecks/postchecks ya usado para
-- 0001_organizaciones_membresias_auth.sql.
--
-- Aditiva pura: solo amplía privilegios de un rol ya existente sobre
-- tablas ya existentes -- ningún DDL de esquema, ninguna tabla/columna
-- nueva, ningún dato tocado. No otorga UPDATE ni DELETE (el flujo de
-- provisionamiento de Sprint 2 solo necesita INSERT en las 3 tablas;
-- ampliar más allá de eso sería un grant excesivo no auditado, mismo
-- criterio que 0001 aplicó al NO copiar el INSERT/UPDATE excesivo de
-- staging sobre membresias).

grant insert on agx.organizaciones to agx_auth;
grant insert on agx.cuentas to agx_auth;
grant insert on agx.membresias to agx_auth;
