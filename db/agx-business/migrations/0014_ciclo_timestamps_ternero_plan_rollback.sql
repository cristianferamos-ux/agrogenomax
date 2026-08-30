-- Rollback de 0014_ciclo_timestamps_ternero_plan.sql -- restaura
-- exactamente el estado dejado por 0011 (grant columnar de 8 columnas,
-- sin ingreso_real_at/salida_real_at/ternero_al_pie).

alter table agx.potrero_recomendaciones_pastoreo drop column if exists ternero_al_pie;

revoke update on agx.potrero_ciclos_pastoreo from agx_app;
grant update (
  estado,
  fecha_salida_real,
  motivo_cancelacion,
  fecha_ingreso_real,
  categoria_id,
  numero_animales_real,
  peso_promedio_real_kg,
  motivo_anulacion
) on agx.potrero_ciclos_pastoreo to agx_app;

alter table agx.potrero_ciclos_pastoreo drop column if exists salida_real_at;
alter table agx.potrero_ciclos_pastoreo drop column if exists ingreso_real_at;
