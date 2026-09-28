-- Rollback de 0020_potrero_recomendacion_carga_automatica.sql.
--
-- Aditiva pura -- ninguna fila existente fue modificada por la migracion
-- original (todas las columnas nuevas nacieron NULL), por lo que el
-- rollback es un DROP directo sin ninguna dependencia de datos.

alter table agx.potrero_recomendaciones_pastoreo
  drop constraint if exists potrero_recomendaciones_modo_consistency_check,
  drop constraint if exists potrero_recomendaciones_motivo_duracion_check,
  drop constraint if exists potrero_recomendaciones_dias_permanencia_check,
  drop constraint if exists potrero_recomendaciones_modo_calculo_check;

alter table agx.potrero_recomendaciones_pastoreo
  drop column if exists occupation_policy_version,
  drop column if exists motivo_duracion,
  drop column if exists dias_permanencia_recomendada,
  drop column if exists modo_calculo,
  drop column if exists fecha_ingreso_prevista;
