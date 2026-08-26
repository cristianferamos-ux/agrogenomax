-- Rollback de 0008_potrero_descanso_reentrada.sql -- aditiva pura, así que
-- el rollback elimina únicamente los objetos creados por ella. NO afecta
-- agx.predios, agx.potreros, agx.potrero_fichas_productivas,
-- agx.potrero_contextos_agroclimaticos, agx.potrero_recomendaciones_pastoreo
-- (salvo retirar la UNIQUE ancla agregada), PostGIS, agx_owner/agx_app ni
-- legacy/CatastroX.

drop policy if exists potrero_descansos_tenant_isolation on agx.potrero_recomendaciones_descanso;
revoke select, insert on agx.potrero_recomendaciones_descanso from agx_app;
revoke usage, select on sequence agx.potrero_recomendaciones_descanso_descanso_id_seq from agx_app;

alter table if exists agx.potrero_recomendaciones_descanso
  drop constraint if exists potrero_descansos_ficha_potrero_organizacion_fkey;
alter table if exists agx.potrero_recomendaciones_descanso
  drop constraint if exists potrero_descansos_contexto_potrero_organizacion_fkey;
alter table if exists agx.potrero_recomendaciones_descanso
  drop constraint if exists potrero_descansos_recomendacion_potrero_organizacion_fkey;
alter table if exists agx.potrero_recomendaciones_descanso
  drop constraint if exists potrero_descansos_previous_potrero_organizacion_fkey;
alter table if exists agx.potrero_recomendaciones_descanso
  drop constraint if exists potrero_descansos_id_potrero_organizacion_unique;
alter table if exists agx.potrero_recomendaciones_descanso
  drop constraint if exists potrero_descansos_potrero_organizacion_fkey;
alter table if exists agx.potrero_recomendaciones_descanso
  drop constraint if exists potrero_descansos_predio_organizacion_fkey;

drop table if exists agx.potrero_recomendaciones_descanso;

alter table if exists agx.potrero_recomendaciones_pastoreo
  drop constraint if exists potrero_recomendaciones_id_potrero_organizacion_unique;

-- HARDENING TERRITORIAL: caché de climatología local.
drop policy if exists potrero_climatologias_tenant_isolation on agx.potrero_climatologias_agroclimaticas;
revoke select, insert on agx.potrero_climatologias_agroclimaticas from agx_app;
revoke usage, select on sequence agx.potrero_climatologias_agroclimaticas_climatologia_id_seq from agx_app;

alter table if exists agx.potrero_climatologias_agroclimaticas
  drop constraint if exists potrero_climatologias_potrero_organizacion_fkey;
alter table if exists agx.potrero_climatologias_agroclimaticas
  drop constraint if exists potrero_climatologias_predio_organizacion_fkey;

drop table if exists agx.potrero_climatologias_agroclimaticas;
