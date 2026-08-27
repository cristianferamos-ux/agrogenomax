-- Rollback de 0013_potrero_evaluacion_reingreso.sql -- aditiva pura.

drop policy if exists potrero_evaluaciones_reingreso_tenant_isolation on agx.potrero_evaluaciones_reingreso;
revoke select, insert on agx.potrero_evaluaciones_reingreso from agx_app;
revoke usage, select on sequence agx.potrero_evaluaciones_reingreso_evaluacion_id_seq from agx_app;

alter table if exists agx.potrero_evaluaciones_reingreso
  drop constraint if exists potrero_evaluaciones_reingreso_ficha_fkey;
alter table if exists agx.potrero_evaluaciones_reingreso
  drop constraint if exists potrero_evaluaciones_reingreso_descanso_ciclo_fkey;
alter table if exists agx.potrero_evaluaciones_reingreso
  drop constraint if exists potrero_evaluaciones_reingreso_ciclo_fkey;
alter table if exists agx.potrero_evaluaciones_reingreso
  drop constraint if exists potrero_evaluaciones_reingreso_potrero_organizacion_fkey;

drop table if exists agx.potrero_evaluaciones_reingreso;
