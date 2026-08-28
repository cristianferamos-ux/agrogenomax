-- SPRINT-3D9.3 -- TIMESTAMPS REALES DEL CICLO + SIMETRÍA PLAN (ternero al pie)
--
-- Parte 1 de 3 de SPRINT-3D9.3 (REAL PRESSURE). Aditiva pura, sin
-- backfill de ningún tipo -- NULL en filas existentes significa
-- explícitamente "dato no disponible", nunca se infiere.
--
-- A) agx.potrero_ciclos_pastoreo gana ingreso_real_at/salida_real_at
--    (timestamptz) -- fuente OPERACIONAL de duración precisa, distinta y
--    complementaria de fecha_ingreso_real/fecha_salida_real (date, que se
--    mantienen intactas para compatibilidad/presentación/día de negocio
--    America/Bogota). Nunca se reemplazan ni se migran destructivamente.
--
-- B) agx.potrero_recomendaciones_pastoreo gana ternero_al_pie -- único
--    input científico transitorio de computeRecomendacionPastoreo() que
--    la auditoría 3D9.3 confirmó NO persistido ni siquiera en PLAN (ya
--    viaja end-to-end desde el cliente hasta el motor, solo faltaba la
--    columna). Histórico: NULL = dato no disponible, NUNCA backfill a
--    false.
--
-- Requiere 0000-0013 ya aplicados.

-- =======================================================================
-- A) Timestamps reales del ciclo.
-- =======================================================================
alter table agx.potrero_ciclos_pastoreo add column if not exists ingreso_real_at timestamptz;
alter table agx.potrero_ciclos_pastoreo add column if not exists salida_real_at timestamptz;

comment on column agx.potrero_ciclos_pastoreo.ingreso_real_at is
  'SPRINT-3D9.3: instante PRECISO de ingreso (servidor) -- fuente OPERACIONAL de duración real, complementaria de fecha_ingreso_real (date, América/Bogotá, sin cambios). NULL en ciclos creados antes de 3D9.3 -- nunca se infiere retroactivamente. Nunca aportado por el cliente.';
comment on column agx.potrero_ciclos_pastoreo.salida_real_at is
  'SPRINT-3D9.3: instante PRECISO de salida (servidor) -- junto con ingreso_real_at permite calcular permanencia real en horas/fracción de día, sin asumir 24h ni redondear a días completos. NULL mientras el ciclo sigue EN_CURSO, y en ciclos anteriores a 3D9.3.';

-- Grant columnar -- se reemplaza el grant completo (mismo criterio de
-- 0011: "una única fuente de verdad de qué columnas son mutables") para
-- incorporar los dos timestamps nuevos, necesarios para que FASE A' de
-- corregirCicloPastoreo pueda sincronizar el timestamp operacional junto
-- con la fecha DATE derivada (ver diseño 3D9.3, sección "corrección
-- temporal"). Ninguna columna de origen/identidad se vuelve mutable.
revoke update on agx.potrero_ciclos_pastoreo from agx_app;
grant update (
  estado,
  fecha_salida_real,
  motivo_cancelacion,
  fecha_ingreso_real,
  categoria_id,
  numero_animales_real,
  peso_promedio_real_kg,
  motivo_anulacion,
  ingreso_real_at,
  salida_real_at
) on agx.potrero_ciclos_pastoreo to agx_app;

-- =======================================================================
-- B) Simetría PLAN -- ternero_al_pie.
-- =======================================================================
alter table agx.potrero_recomendaciones_pastoreo add column if not exists ternero_al_pie boolean;

comment on column agx.potrero_recomendaciones_pastoreo.ternero_al_pie is
  'SPRINT-3D9.3: input transitorio de computeRecomendacionPastoreo() (degrada nivel_confianza, nunca suma demanda) que hasta ahora nunca se persistía, ni siquiera en PLAN -- gap cerrado para reproducibilidad futura del cálculo. NULL en filas anteriores a este cambio = dato no disponible, NUNCA backfill a false. agx.potrero_recomendaciones_pastoreo es append-only (0007) -- esta columna hereda el mismo grant SELECT/INSERT, sin UPDATE.';
