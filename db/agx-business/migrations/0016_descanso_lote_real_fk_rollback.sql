-- Rollback de 0016_descanso_lote_real_fk.sql.

drop index if exists agx.potrero_recomendaciones_descanso_lote_real_version_idx;
alter table agx.potrero_recomendaciones_descanso drop constraint if exists potrero_descansos_lote_real_version_fkey;
alter table agx.potrero_recomendaciones_descanso drop column if exists lote_real_version_id;
