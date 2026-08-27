-- Rollback de 0009_potrero_ciclo_real_pastoreo.sql -- aditiva pura, así
-- que el rollback elimina únicamente los objetos creados por ella. NO
-- afecta agx.predios, agx.potreros (salvo retirar la UNIQUE de 3 columnas
-- agregada), agx.potrero_recomendaciones_pastoreo,
-- agx.potrero_contextos_agroclimaticos, agx.catalogo_categorias_productivas
-- (salvo retirar la FK entrante), PostGIS, agx_owner/agx_app ni
-- legacy/CatastroX.

-- Extensión de agx.potrero_recomendaciones_descanso -- retirar primero
-- (depende de agx.potrero_ciclos_pastoreo).
drop index if exists agx.potrero_recomendaciones_descanso_un_ciclo_idx;
alter table if exists agx.potrero_recomendaciones_descanso
  drop constraint if exists potrero_descansos_ciclo_pastoreo_fkey;
alter table if exists agx.potrero_recomendaciones_descanso
  drop column if exists ciclo_pastoreo_id;

-- agx.potrero_ciclo_eventos.
drop policy if exists potrero_ciclo_eventos_tenant_isolation on agx.potrero_ciclo_eventos;
revoke select, insert on agx.potrero_ciclo_eventos from agx_app;
revoke usage, select on sequence agx.potrero_ciclo_eventos_evento_id_seq from agx_app;

alter table if exists agx.potrero_ciclo_eventos
  drop constraint if exists potrero_ciclo_eventos_ciclo_potrero_organizacion_fkey;
alter table if exists agx.potrero_ciclo_eventos
  drop constraint if exists potrero_ciclo_eventos_potrero_organizacion_fkey;

drop table if exists agx.potrero_ciclo_eventos;

-- agx.potrero_ciclos_pastoreo.
drop policy if exists potrero_ciclos_pastoreo_tenant_isolation on agx.potrero_ciclos_pastoreo;
revoke select, insert on agx.potrero_ciclos_pastoreo from agx_app;
revoke update (estado, fecha_salida_real, motivo_cancelacion) on agx.potrero_ciclos_pastoreo from agx_app;
revoke usage, select on sequence agx.potrero_ciclos_pastoreo_ciclo_id_seq from agx_app;

alter table if exists agx.potrero_ciclos_pastoreo
  drop constraint if exists potrero_ciclos_pastoreo_potrero_predio_organizacion_fkey;
alter table if exists agx.potrero_ciclos_pastoreo
  drop constraint if exists potrero_ciclos_id_potrero_organizacion_unique;
alter table if exists agx.potrero_ciclos_pastoreo
  drop constraint if exists potrero_ciclos_pastoreo_recomendacion_pastoreo_fkey;
alter table if exists agx.potrero_ciclos_pastoreo
  drop constraint if exists potrero_ciclos_pastoreo_recomendacion_descanso_plan_fkey;
alter table if exists agx.potrero_ciclos_pastoreo
  drop constraint if exists potrero_ciclos_pastoreo_contexto_fkey;
alter table if exists agx.potrero_ciclos_pastoreo
  drop constraint if exists potrero_ciclos_pastoreo_categoria_fkey;

drop table if exists agx.potrero_ciclos_pastoreo;

-- Guardrail 1: retirar la UNIQUE de 3 columnas agregada sobre agx.potreros.
alter table if exists agx.potreros
  drop constraint if exists potreros_id_predio_organizacion_unique;
