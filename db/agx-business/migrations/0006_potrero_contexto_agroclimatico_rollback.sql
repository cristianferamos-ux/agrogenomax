-- Rollback de 0006_potrero_contexto_agroclimatico.sql -- aditiva pura,
-- así que el rollback elimina únicamente los objetos creados por ella.
-- NO afecta agx.predios, agx.potreros, PostGIS, agx_owner/agx_app ni
-- legacy/CatastroX.

drop policy if exists potrero_contextos_tenant_isolation on agx.potrero_contextos_agroclimaticos;
revoke select, insert on agx.potrero_contextos_agroclimaticos from agx_app;
revoke usage, select on sequence agx.potrero_contextos_agroclimaticos_contexto_id_seq from agx_app;

alter table if exists agx.potrero_contextos_agroclimaticos
  drop constraint if exists potrero_contextos_potrero_organizacion_fkey;
alter table if exists agx.potrero_contextos_agroclimaticos
  drop constraint if exists potrero_contextos_predio_organizacion_fkey;

drop table if exists agx.potrero_contextos_agroclimaticos;
