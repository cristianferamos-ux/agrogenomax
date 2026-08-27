-- Rollback de 0012_potrero_descanso_version_invalidacion.sql -- restaura
-- el índice único original de 0009. Falla intencionalmente si existe más
-- de una versión no invalidada por ciclo, o si algún ciclo tiene más de
-- una fila (el índice original no lo permite) -- nunca se descarta
-- silenciosamente una versión histórica.

drop table if exists agx.potrero_descanso_invalidaciones;

alter table if exists agx.potrero_recomendaciones_descanso
  drop constraint if exists potrero_descansos_id_ciclo_potrero_organizacion_unique;

drop index if exists agx.potrero_recomendaciones_descanso_un_ciclo_version_idx;

create unique index potrero_recomendaciones_descanso_un_ciclo_idx
  on agx.potrero_recomendaciones_descanso (ciclo_pastoreo_id)
  where ciclo_pastoreo_id is not null;

alter table if exists agx.potrero_recomendaciones_descanso
  drop constraint if exists potrero_descansos_version_check;
alter table if exists agx.potrero_recomendaciones_descanso drop column if exists version;
