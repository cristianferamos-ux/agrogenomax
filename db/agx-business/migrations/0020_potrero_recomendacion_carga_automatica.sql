-- SPRINT-3D10.4 -- FASE 1 del motor de carga recomendada (3D10.1-3D10.3.1):
-- prepara agx.potrero_recomendaciones_pastoreo para distinguir
-- recomendaciones MANUALES (numero_animales como input humano, flujo
-- existente desde 0007) de recomendaciones AUTOMATICAS (numero_animales
-- calculado por el motor v1, FASE 2 -- todavia no implementado en esta
-- migracion).
--
-- Aditiva pura:
-- - Las 5 columnas nuevas son NULL-ables sin excepcion.
-- - Filas anteriores a esta migracion quedan con TODAS las columnas
--   nuevas en NULL -- incluido modo_calculo. NO se ejecuta ningun UPDATE,
--   NO hay DEFAULT que las convierta en 'MANUAL' -- modo_calculo=NULL
--   significa explicitamente "fila anterior a esta migracion, modo
--   desconocido por diseno", nunca se infiere retroactivamente (mismo
--   criterio que ternero_al_pie en 0014).
-- - A partir de esta migracion, todo INSERT nuevo debe fijar modo_calculo
--   explicitamente ('MANUAL' o 'AUTOMATICO') a nivel de aplicacion -- la
--   columna sigue siendo NULL-able en el esquema porque forzar NOT NULL
--   exigiria un DEFAULT o un backfill sobre el historico, ambos prohibidos.
--
-- numero_animales NO se duplica: sigue siendo la unica columna del valor
-- final del lote (input humano en modo MANUAL, output del motor en modo
-- AUTOMATICO) -- modo_calculo es el discriminador de trazabilidad, no un
-- valor paralelo.
--
-- Requiere 0000-0019 ya aplicados.

alter table agx.potrero_recomendaciones_pastoreo add column if not exists fecha_ingreso_prevista date;
alter table agx.potrero_recomendaciones_pastoreo add column if not exists modo_calculo varchar(20);
alter table agx.potrero_recomendaciones_pastoreo add column if not exists dias_permanencia_recomendada smallint;
alter table agx.potrero_recomendaciones_pastoreo add column if not exists motivo_duracion varchar(30);
alter table agx.potrero_recomendaciones_pastoreo add column if not exists occupation_policy_version varchar(40);

alter table agx.potrero_recomendaciones_pastoreo
  add constraint potrero_recomendaciones_modo_calculo_check
  check (modo_calculo is null or modo_calculo in ('MANUAL', 'AUTOMATICO'));

alter table agx.potrero_recomendaciones_pastoreo
  add constraint potrero_recomendaciones_dias_permanencia_check
  check (dias_permanencia_recomendada is null or dias_permanencia_recomendada in (2, 3));

alter table agx.potrero_recomendaciones_pastoreo
  add constraint potrero_recomendaciones_motivo_duracion_check
  check (motivo_duracion is null or motivo_duracion in ('TARGET_3_DAYS', 'FALLBACK_MIN_2_DAYS'));

-- Consistencia biconditional: AUTOMATICO exige las 4 columnas del motor
-- pobladas (incluida fecha_ingreso_prevista, input obligatorio de ese
-- camino); cualquier otro valor (incluido NULL historico) exige que las 3
-- columnas propias del motor (dias/motivo/policy_version) permanezcan
-- NULL -- nunca se etiquetan campos de "modo automatico" sobre una fila
-- MANUAL o historica.
alter table agx.potrero_recomendaciones_pastoreo
  add constraint potrero_recomendaciones_modo_consistency_check
  check (
    (modo_calculo = 'AUTOMATICO'
      and dias_permanencia_recomendada is not null
      and motivo_duracion is not null
      and occupation_policy_version is not null
      and fecha_ingreso_prevista is not null)
    or
    (modo_calculo is distinct from 'AUTOMATICO'
      and dias_permanencia_recomendada is null
      and motivo_duracion is null
      and occupation_policy_version is null)
  );

comment on column agx.potrero_recomendaciones_pastoreo.fecha_ingreso_prevista is
  'SPRINT-3D10.4: fecha PREVISTA de ingreso (PLAN, date, sin hora) -- input obligatorio unicamente del motor automatico (FASE 2). NUNCA se copia a fecha_ingreso_real/ingreso_real_at de agx.potrero_ciclos_pastoreo -- PLAN y REAL permanecen separados. NULL en filas anteriores a esta migracion y en filas MANUAL.';
comment on column agx.potrero_recomendaciones_pastoreo.modo_calculo is
  'MANUAL = numero_animales fue input humano (flujo existente desde 0007). AUTOMATICO = numero_animales fue calculado por el motor v1 de carga recomendada (FASE 2). NULL = fila anterior a esta migracion, modo desconocido por diseno -- nunca inferido retroactivamente.';
comment on column agx.potrero_recomendaciones_pastoreo.dias_permanencia_recomendada is
  'SPRINT-3D10.4: duracion de la politica de ocupacion (2 o 3 dias, ver occupation_policy_version) aplicada por el motor automatico -- NUNCA derivada de dias_ocupacion_estimados/floor. Solo poblada cuando modo_calculo=AUTOMATICO.';
comment on column agx.potrero_recomendaciones_pastoreo.motivo_duracion is
  'SPRINT-3D10.4: TARGET_3_DAYS (rama normal) o FALLBACK_MIN_2_DAYS (bajo forraje, piso de politica). Solo poblada cuando modo_calculo=AUTOMATICO.';
comment on column agx.potrero_recomendaciones_pastoreo.occupation_policy_version is
  'SPRINT-3D10.4: version de la politica cientifica de dias de ocupacion (independiente de motor_version, que versiona la formula de biomasa/demanda) -- permite evolucionar cada pieza de ciencia por separado. Solo poblada cuando modo_calculo=AUTOMATICO.';
