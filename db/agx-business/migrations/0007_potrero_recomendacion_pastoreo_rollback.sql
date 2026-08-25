-- Rollback de 0007_potrero_recomendacion_pastoreo.sql -- aditiva pura, así
-- que el rollback elimina únicamente los objetos creados por ella. NO
-- afecta agx.predios, agx.potreros, agx.potrero_fichas_productivas,
-- agx.potrero_contextos_agroclimaticos (salvo retirar la UNIQUE ancla
-- agregada), agx.potrero_calculos_pastoreo, PostGIS, agx_owner/agx_app ni
-- legacy/CatastroX.

drop policy if exists potrero_recomendaciones_tenant_isolation on agx.potrero_recomendaciones_pastoreo;
revoke select, insert on agx.potrero_recomendaciones_pastoreo from agx_app;
revoke usage, select on sequence agx.potrero_recomendaciones_pastoreo_recomendacion_id_seq from agx_app;

alter table if exists agx.potrero_recomendaciones_pastoreo
  drop constraint if exists potrero_recomendaciones_ficha_potrero_organizacion_fkey;
alter table if exists agx.potrero_recomendaciones_pastoreo
  drop constraint if exists potrero_recomendaciones_contexto_potrero_organizacion_fkey;
alter table if exists agx.potrero_recomendaciones_pastoreo
  drop constraint if exists potrero_recomendaciones_categoria_fkey;
alter table if exists agx.potrero_recomendaciones_pastoreo
  drop constraint if exists potrero_recomendaciones_potrero_organizacion_fkey;
alter table if exists agx.potrero_recomendaciones_pastoreo
  drop constraint if exists potrero_recomendaciones_predio_organizacion_fkey;

drop table if exists agx.potrero_recomendaciones_pastoreo;

alter table if exists agx.potrero_contextos_agroclimaticos
  drop constraint if exists potrero_contextos_id_potrero_organizacion_unique;

drop policy if exists catalogo_categorias_read on agx.catalogo_categorias_productivas;
revoke select on agx.catalogo_categorias_productivas from agx_app;
revoke usage, select on sequence agx.catalogo_categorias_productivas_categoria_id_seq from agx_app;

drop table if exists agx.catalogo_categorias_productivas;
