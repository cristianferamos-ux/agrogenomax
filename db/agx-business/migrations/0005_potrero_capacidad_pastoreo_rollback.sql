-- Rollback de 0005_potrero_capacidad_pastoreo.sql -- aditiva pura, así
-- que el rollback elimina únicamente los objetos creados por ella. NO
-- afecta agx.predios, agx.potreros, agx.potrero_fichas_productivas (más
-- allá de la UNIQUE ancla agregada por la forward), PostGIS, agx_owner/
-- agx_app ni legacy/CatastroX.
--
-- Orden: tabla nueva primero (política, grants, FKs, tabla), luego la
-- UNIQUE ancla agregada sobre agx.potrero_fichas_productivas (debe
-- soltarse después de que ninguna FK dependa de ella).

drop policy if exists potrero_calculos_tenant_isolation on agx.potrero_calculos_pastoreo;
revoke select, insert on agx.potrero_calculos_pastoreo from agx_app;
revoke usage, select on sequence agx.potrero_calculos_pastoreo_calculo_id_seq from agx_app;

alter table if exists agx.potrero_calculos_pastoreo
  drop constraint if exists potrero_calculos_ficha_potrero_organizacion_fkey;
alter table if exists agx.potrero_calculos_pastoreo
  drop constraint if exists potrero_calculos_potrero_organizacion_fkey;
alter table if exists agx.potrero_calculos_pastoreo
  drop constraint if exists potrero_calculos_predio_organizacion_fkey;

drop table if exists agx.potrero_calculos_pastoreo;

alter table if exists agx.potrero_fichas_productivas
  drop constraint if exists potrero_fichas_id_potrero_organizacion_unique;
