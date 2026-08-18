-- Rollback de 0002_predio_operational_fields.sql -- aditiva pura, así que
-- el rollback es igual de simple: eliminar la columna nueva y limpiar el
-- comentario agregado a la columna preexistente (el comentario no tiene
-- "rollback" real -- simplemente se retira, la columna en sí no cambia).
comment on column agx.predios.area_total_ha is null;

alter table agx.predios drop column if exists observaciones;
