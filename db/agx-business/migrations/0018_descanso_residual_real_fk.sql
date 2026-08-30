-- SPRINT-3D9.4 -- LIGA DESCANSO <-> RESIDUAL REAL VIGENTE
--
-- Aditiva pura, mismo patrón exacto que 0016 (liga descanso <-> snapshot
-- de lote real). Ancla cada descanso generado por "aplicar-a-descanso" a
-- la versión EXACTA del residual real que usó -- nunca "el residual más
-- reciente en el momento de leer". NULL para descansos con
-- fuente_remanente=ESTIMADO (la inmensa mayoría, incluyendo todo el
-- histórico anterior a 3D9.4) o generados en PLAN_FALLBACK.
--
-- fuente_remanente vive como columna dedicada (a diferencia de
-- fuente_presion, que vive en parametros_fuente_json) porque 3D9.4
-- necesita poder detectar en una consulta directa -- sin parsear JSON --
-- qué descansos dependen de qué residual, para invalidarlos en cascada si
-- el residual que los sustenta se anula o queda temporalmente
-- incompatible tras una corrección del ciclo.
--
-- Requiere 0000-0017 ya aplicados.

alter table agx.potrero_recomendaciones_descanso add column if not exists residual_real_version_id bigint;
alter table agx.potrero_recomendaciones_descanso add column if not exists fuente_remanente varchar(10);

comment on column agx.potrero_recomendaciones_descanso.residual_real_version_id is
  'SPRINT-3D9.4: versión EXACTA de agx.potrero_ciclo_residuales_reales_versiones que este descanso usó al aplicar el remanente MEDIDO -- NULL cuando fuente_remanente es ESTIMADO o NULL (histórico anterior a 3D9.4, sin backfill).';
comment on column agx.potrero_recomendaciones_descanso.fuente_remanente is
  'SPRINT-3D9.4: ESTIMADO (remanente proyectado por el pipeline REAL de 3D9.3) o MEDIDO (remanente de un residual real aplicado explícitamente). NULL en históricos anteriores a 3D9.4 -- nunca inferido retroactivamente.';

alter table agx.potrero_recomendaciones_descanso
  add constraint potrero_recomendaciones_descanso_fuente_remanente_check
  check (fuente_remanente is null or fuente_remanente in ('ESTIMADO', 'MEDIDO'));

-- FK de 4 columnas -- garantiza que residual_real_version_id pertenece al
-- MISMO ciclo/potrero/organización que esta fila de descanso. Nullable:
-- si cualquiera de las 4 columnas es NULL (caso normal ESTIMADO/histórico),
-- la FK no se evalúa.
alter table agx.potrero_recomendaciones_descanso
  add constraint potrero_descansos_residual_real_version_fkey
  foreign key (residual_real_version_id, ciclo_pastoreo_id, potrero_id, organizacion_id)
  references agx.potrero_ciclo_residuales_reales_versiones (residual_id, ciclo_id, potrero_id, organizacion_id);

create index potrero_recomendaciones_descanso_residual_real_version_idx
  on agx.potrero_recomendaciones_descanso (residual_real_version_id)
  where residual_real_version_id is not null;
