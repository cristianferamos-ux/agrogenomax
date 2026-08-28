-- SPRINT-3D9.3 -- LIGA DESCANSO <-> SNAPSHOT REAL VIGENTE
--
-- Parte 3 de 3 de SPRINT-3D9.3. Aditiva pura. Ancla cada descanso
-- generado por el pipeline REAL pressure a la versión EXACTA del
-- snapshot que usó para calcular -- nunca "el snapshot más reciente en
-- el momento de leer" (mismo principio anti-contaminación ya aplicado en
-- 3D9.2 para recomendacion_pastoreo_id). NULL para descansos PLANIFICADOS
-- o generados en PLAN_FALLBACK (la inmensa mayoría del histórico, y
-- cualquier ciclo sin evidencia real suficiente) -- fuente_presion vive en
-- parametros_fuente_json (sin columna nueva, mismo criterio que el resto
-- de la trazabilidad de esa fila).
--
-- Requiere 0000-0015 ya aplicados.

alter table agx.potrero_recomendaciones_descanso add column if not exists lote_real_version_id bigint;

comment on column agx.potrero_recomendaciones_descanso.lote_real_version_id is
  'SPRINT-3D9.3: versión EXACTA de agx.potrero_ciclo_lote_real_versiones que este descanso usó como fuente científica REAL -- NULL cuando el descanso es PLANIFICADO o se generó en PLAN_FALLBACK (evidencia real insuficiente). fuente_presion (REAL/PLAN_FALLBACK) vive en parametros_fuente_json, no como columna.';

-- FK de 4 columnas -- garantiza que lote_real_version_id realmente
-- pertenece al MISMO ciclo (ciclo_pastoreo_id, ya existente desde 0009),
-- potrero y organización que esta fila de descanso. Nullable: si
-- cualquiera de las 4 columnas es NULL (caso normal de un descanso
-- PLANIFICADO o PLAN_FALLBACK), la FK no se evalúa.
alter table agx.potrero_recomendaciones_descanso
  add constraint potrero_descansos_lote_real_version_fkey
  foreign key (lote_real_version_id, ciclo_pastoreo_id, potrero_id, organizacion_id)
  references agx.potrero_ciclo_lote_real_versiones (snapshot_id, ciclo_id, potrero_id, organizacion_id);

create index potrero_recomendaciones_descanso_lote_real_version_idx
  on agx.potrero_recomendaciones_descanso (lote_real_version_id)
  where lote_real_version_id is not null;
