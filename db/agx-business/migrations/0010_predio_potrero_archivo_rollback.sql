-- Rollback de 0010_predio_potrero_archivo.sql -- aditiva pura, así que el
-- rollback elimina únicamente los objetos creados por ella. Restaura el
-- grant DELETE original de agx.predios/agx.potreros (mismo estado previo
-- a 0010 -- ver 0001/0003).

-- agx.potrero_archivo_eventos.
drop policy if exists potrero_archivo_eventos_tenant_isolation on agx.potrero_archivo_eventos;
revoke select, insert on agx.potrero_archivo_eventos from agx_app;
revoke usage, select on sequence agx.potrero_archivo_eventos_evento_id_seq from agx_app;
alter table if exists agx.potrero_archivo_eventos
  drop constraint if exists potrero_archivo_eventos_potrero_organizacion_fkey;
drop table if exists agx.potrero_archivo_eventos;

-- agx.predio_archivo_eventos.
drop policy if exists predio_archivo_eventos_tenant_isolation on agx.predio_archivo_eventos;
revoke select, insert on agx.predio_archivo_eventos from agx_app;
revoke usage, select on sequence agx.predio_archivo_eventos_evento_id_seq from agx_app;
alter table if exists agx.predio_archivo_eventos
  drop constraint if exists predio_archivo_eventos_predio_organizacion_fkey;
drop table if exists agx.predio_archivo_eventos;

-- Restaurar el grant DELETE original (estado previo a 0010).
grant delete on agx.predios to agx_app;
grant delete on agx.potreros to agx_app;

-- agx.potreros -- columnas current-state.
alter table if exists agx.potreros
  drop constraint if exists potreros_estado_consistency_check;
alter table if exists agx.potreros
  drop constraint if exists potreros_estado_check;
alter table if exists agx.potreros drop column if exists motivo_archivado;
alter table if exists agx.potreros drop column if exists archivado_por;
alter table if exists agx.potreros drop column if exists archivado_at;
alter table if exists agx.potreros drop column if exists estado;

-- agx.predios -- columnas current-state.
alter table if exists agx.predios
  drop constraint if exists predios_estado_consistency_check;
alter table if exists agx.predios
  drop constraint if exists predios_estado_check;
alter table if exists agx.predios drop column if exists motivo_archivado;
alter table if exists agx.predios drop column if exists archivado_por;
alter table if exists agx.predios drop column if exists archivado_at;
alter table if exists agx.predios drop column if exists estado;
