-- SPRINT-3D8-DESCANSO-REENTRADA
--
-- Motor de descanso y reentrada: a partir de una recomendación automática
-- de pastoreo YA GUARDADA (0007), la ficha productiva y el contexto
-- agroclimático más reciente del potrero, calcula un RANGO de días de
-- descanso (nunca un número falso-preciso), la fecha estimada de próxima
-- entrada y las condiciones mínimas de reingreso. Aditiva pura sobre
-- 0001-0007 -- NO los modifica, salvo anclar una UNIQUE compuesta
-- adicional sobre agx.potrero_recomendaciones_pastoreo (mismo patrón que
-- las anclas de 0003/0004/0005/0007 sobre sus respectivos padres).
--
-- REGLA DE DOMINIO: ORGANIZACIÓN -> PREDIO -> POTRERO -> FICHA PRODUCTIVA
-- (+ CONTEXTO AGROCLIMÁTICO opcional) -> RECOMENDACIÓN DE PASTOREO
-- GUARDADA -> RECOMENDACIÓN DE DESCANSO. Una recomendación de descanso
-- NUNCA existe desacoplada de la recomendación de pastoreo real sobre la
-- que se apoya.
--
-- MODELO HISTÓRICO: cada POST create crea una fila NUEVA en
-- agx.potrero_recomendaciones_descanso -- nunca se actualiza ni
-- sobrescribe una recomendación de descanso existente (mismo criterio que
-- 0005/0006/0007).
--
-- Requiere 0000/0001/0002/0003/0004/0005/0006/0007 ya aplicados.
-- Nunca ejecutar contra Railway/producción sin autorización explícita
-- separada.

-- =======================================================================
-- Ancla adicional sobre agx.potrero_recomendaciones_pastoreo -- mismo
-- criterio que la UNIQUE (ficha_id, potrero_id, organizacion_id) de 0005 y
-- (contexto_id, potrero_id, organizacion_id) de 0007: permite que la FK
-- compuesta de agx.potrero_recomendaciones_descanso hacia esta tabla
-- verifique a nivel de integridad referencial que recomendacion_pastoreo_id
-- realmente pertenece al potrero_id/organizacion_id declarados.
-- =======================================================================
alter table agx.potrero_recomendaciones_pastoreo
  add constraint potrero_recomendaciones_id_potrero_organizacion_unique
  unique (recomendacion_id, potrero_id, organizacion_id);

-- =======================================================================
-- agx.potrero_recomendaciones_descanso -- histórico append-only de
-- recomendaciones de descanso/reentrada por potrero (§13/§21 del sprint).
-- =======================================================================
create table agx.potrero_recomendaciones_descanso (
  descanso_id bigserial primary key,
  organizacion_id uuid not null,
  predio_id bigint not null,
  potrero_id bigint not null,
  ficha_id bigint not null,
  contexto_id bigint,
  recomendacion_pastoreo_id bigint not null,

  -- HARDENING DINÁMICO: recomendación de descanso INMEDIATAMENTE anterior
  -- de este mismo potrero (si existe) -- permite reconstruir que un
  -- recálculo es un recálculo, no una fila aislada (§19/§24 del
  -- hardening). Nullable -- la primera recomendación de un potrero no
  -- tiene predecesora. Ancla FK compuesta agregada más abajo.
  previous_descanso_id bigint,

  -- Input mínimo adicional del cliente (§11/§12/§19 del sprint): fecha
  -- prevista/real de ingreso del lote al potrero. NUNCA sustituida
  -- silenciosamente por "hoy" (§12: "No inventar 'hoy' silenciosamente").
  fecha_inicio_pastoreo date not null,

  -- CALCULADO server-side (§11 del sprint) = fecha_inicio_pastoreo +
  -- dias_ocupacion_recomendados de la recomendación de pastoreo referenciada
  -- (recompuesto vía computeRemnantDerivatives, nunca aceptado del cliente).
  fecha_salida_estimada date not null,

  -- RANGO de descanso (§1/§8 del sprint) -- nunca un único valor
  -- falso-preciso. "recomendado" es un punto dentro del rango, nunca su
  -- promedio matemático forzado.
  dias_descanso_min integer not null,
  dias_descanso_max integer not null,
  dias_descanso_recomendado integer not null,

  fecha_reingreso_min date not null,
  fecha_reingreso_max date not null,
  fecha_reingreso_recomendada date not null,

  nivel_confianza varchar(10) not null,

  -- HARDENING DINÁMICO §7: clasificación agroclimática determinística que
  -- produjo el ajuste dinámico de este cálculo -- NUNCA scoring opaco,
  -- siempre uno de los 5 valores documentados en agroClimateAssessment.js.
  agroclimate_status varchar(30) not null,

  -- Condiciones mínimas de reentrada (§9 del sprint) -- array de códigos +
  -- detalle legible (altura mínima si hay dato de pastura específica,
  -- confirmar con nuevo aforo siempre). Nunca solo "vuelva en N días".
  condiciones_reentrada_json jsonb not null default '[]',

  -- Trazabilidad completa (§16 del sprint): baseline de pastura aplicado,
  -- fuente del baseline (DIRECT/ADAPTED/FALLBACK), reglas climáticas
  -- aplicadas, ajuste de presión de pastoreo (arquitectura preparada,
  -- v1 nunca debería activarse si el motor de pastoreo se respeta),
  -- ficha/contexto/recomendación de pastoreo de origen, versión del motor.
  parametros_fuente_json jsonb not null default '{}',

  -- HARDENING DINÁMICO §7/§13: lista ORDENADA de códigos de regla
  -- explícita aplicada por el clasificador agroclimático (p.ej.
  -- RULE_DROUGHT_PERSISTENT, RULE_SOIL_MOISTURE_LOW) -- auditable,
  -- reconstruible desde parametros_fuente_json pero persistido también
  -- como columna propia para consultas/reportes directos sin parsear JSON.
  applied_rules_json jsonb not null default '[]',

  -- SPRINT §14 del sprint: cada fila histórica sabe con qué versión del
  -- motor fue calculada -- una recomendación antigua NUNCA se reinterpreta
  -- silenciosamente bajo reglas nuevas.
  motor_version varchar(40) not null,

  created_at timestamptz not null default now(),

  constraint potrero_descansos_confianza_check
    check (nivel_confianza in ('ALTA', 'MEDIA', 'BAJA')),
  constraint potrero_descansos_agroclimate_status_check
    check (agroclimate_status in ('FAVORABLE', 'NORMAL', 'RESTRICTIVE', 'SEVERELY_RESTRICTIVE', 'INSUFFICIENT_DATA')),
  constraint potrero_descansos_fecha_salida_check
    check (fecha_salida_estimada >= fecha_inicio_pastoreo),
  constraint potrero_descansos_dias_min_check
    check (dias_descanso_min >= 0 and dias_descanso_min <= 180),
  constraint potrero_descansos_dias_max_check
    check (dias_descanso_max >= 0 and dias_descanso_max <= 180),
  constraint potrero_descansos_dias_recomendado_check
    check (dias_descanso_recomendado >= 0 and dias_descanso_recomendado <= 180),
  constraint potrero_descansos_dias_orden_check
    check (dias_descanso_min <= dias_descanso_recomendado and dias_descanso_recomendado <= dias_descanso_max),
  constraint potrero_descansos_fecha_reingreso_min_check
    check (fecha_reingreso_min >= fecha_salida_estimada),
  constraint potrero_descansos_fecha_reingreso_orden_check
    check (fecha_reingreso_min <= fecha_reingreso_recomendada and fecha_reingreso_recomendada <= fecha_reingreso_max)
);

comment on table agx.potrero_recomendaciones_descanso is
  'Histórico append-only de recomendaciones de descanso/reentrada (SPRINT-3D8) -- cada fila preserva exactamente el rango de días y fechas calculadas en ese momento. NUNCA se actualiza/sobrescribe una fila existente.';
comment on column agx.potrero_recomendaciones_descanso.dias_descanso_recomendado is
  'Punto recomendado DENTRO del rango [dias_descanso_min, dias_descanso_max] -- nunca se presenta como un valor único sin el rango (§1/§8 del sprint: evitar falsa precisión tipo "30.00 días").';
comment on column agx.potrero_recomendaciones_descanso.fecha_inicio_pastoreo is
  'Fecha prevista/real de ingreso del lote, aportada por el cliente al calcular el descanso (§11/§12 del sprint) -- NUNCA sustituida silenciosamente por la fecha de creación de la recomendación de pastoreo ni por "hoy".';
comment on column agx.potrero_recomendaciones_descanso.condiciones_reentrada_json is
  'Condiciones mínimas de reentrada (§9 del sprint) -- códigos + detalle legible. Nunca solo "vuelva en N días" -- siempre incluye al menos confirmar recuperación con un nuevo aforo.';
comment on column agx.potrero_recomendaciones_descanso.motor_version is
  'Versión del motor de descanso que produjo esta fila (§14 del sprint) -- p.ej. "descanso-v1". Permite distinguir histórico calculado con reglas distintas en el futuro.';
comment on column agx.potrero_recomendaciones_descanso.agroclimate_status is
  'HARDENING DINÁMICO -- clasificación determinística (FAVORABLE/NORMAL/RESTRICTIVE/SEVERELY_RESTRICTIVE/INSUFFICIENT_DATA) que produjo el ajuste dinámico de esta fila. Ver agroClimateAssessment.js.';
comment on column agx.potrero_recomendaciones_descanso.previous_descanso_id is
  'HARDENING DINÁMICO -- recomendación de descanso inmediatamente anterior de este mismo potrero, si existe. Permite reconstruir que un recálculo es un recálculo (§19/§24 del hardening), sin implicar que la fila anterior fue modificada (append-only, nunca se edita).';

-- Ancla self-referencia (mismo patrón que las anclas compuestas del resto
-- del esquema, p.ej. potrero_fichas_id_potrero_organizacion_unique) --
-- permite que la FK compuesta de previous_descanso_id verifique, a nivel
-- de integridad referencial, que la fila predecesora pertenece al MISMO
-- potrero/organización (nunca solo que el id exista).
alter table agx.potrero_recomendaciones_descanso
  add constraint potrero_descansos_id_potrero_organizacion_unique
  unique (descanso_id, potrero_id, organizacion_id);

alter table agx.potrero_recomendaciones_descanso
  add constraint potrero_descansos_previous_potrero_organizacion_fkey
  foreign key (previous_descanso_id, potrero_id, organizacion_id)
  references agx.potrero_recomendaciones_descanso (descanso_id, potrero_id, organizacion_id);

-- FK compuesta hacia la ficha productiva (mismo patrón que 0005/0007).
alter table agx.potrero_recomendaciones_descanso
  add constraint potrero_descansos_ficha_potrero_organizacion_fkey
  foreign key (ficha_id, potrero_id, organizacion_id)
  references agx.potrero_fichas_productivas (ficha_id, potrero_id, organizacion_id);

-- FK compuesta OPCIONAL hacia el contexto agroclimático -- contexto_id
-- nullable: sin fila coincidente, MATCH SIMPLE (default de Postgres) no
-- exige que la FK se satisfaga (modo degradado sin contexto sigue siendo
-- válido, mismo criterio que 0007).
alter table agx.potrero_recomendaciones_descanso
  add constraint potrero_descansos_contexto_potrero_organizacion_fkey
  foreign key (contexto_id, potrero_id, organizacion_id)
  references agx.potrero_contextos_agroclimaticos (contexto_id, potrero_id, organizacion_id);

-- FK compuesta hacia la recomendación de pastoreo guardada -- garantiza que
-- la recomendación de pastoreo referenciada realmente pertenece a este
-- potrero/organización (ancla agregada arriba en este mismo archivo).
alter table agx.potrero_recomendaciones_descanso
  add constraint potrero_descansos_recomendacion_potrero_organizacion_fkey
  foreign key (recomendacion_pastoreo_id, potrero_id, organizacion_id)
  references agx.potrero_recomendaciones_pastoreo (recomendacion_id, potrero_id, organizacion_id);

-- FK compuesta hacia el potrero y hacia el predio (mismo patrón que 0005/0007).
alter table agx.potrero_recomendaciones_descanso
  add constraint potrero_descansos_potrero_organizacion_fkey
  foreign key (potrero_id, organizacion_id)
  references agx.potreros (potrero_id, organizacion_id);

alter table agx.potrero_recomendaciones_descanso
  add constraint potrero_descansos_predio_organizacion_fkey
  foreign key (predio_id, organizacion_id)
  references agx.predios (predio_id, organizacion_id);

create index potrero_descansos_organizacion_id_idx on agx.potrero_recomendaciones_descanso (organizacion_id);
create index potrero_descansos_potrero_id_idx on agx.potrero_recomendaciones_descanso (potrero_id);
create index potrero_descansos_organizacion_potrero_idx
  on agx.potrero_recomendaciones_descanso (organizacion_id, potrero_id);
create index potrero_descansos_potrero_created_idx
  on agx.potrero_recomendaciones_descanso (potrero_id, created_at desc);
create index potrero_descansos_recomendacion_pastoreo_id_idx
  on agx.potrero_recomendaciones_descanso (recomendacion_pastoreo_id);
create index potrero_descansos_ficha_id_idx on agx.potrero_recomendaciones_descanso (ficha_id);

alter table agx.potrero_recomendaciones_descanso owner to agx_owner;

alter table agx.potrero_recomendaciones_descanso enable row level security;
alter table agx.potrero_recomendaciones_descanso force row level security;

create policy potrero_descansos_tenant_isolation on agx.potrero_recomendaciones_descanso
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- Grants -- histórico append-only para la aplicación: SELECT/INSERT
-- únicamente (§13 del sprint: "No permitir UPDATE/DELETE a agx_app").
grant select, insert on agx.potrero_recomendaciones_descanso to agx_app;
grant usage, select on sequence agx.potrero_recomendaciones_descanso_descanso_id_seq to agx_app;

grant all privileges on agx.potrero_recomendaciones_descanso to agx_owner;
grant usage, select on sequence agx.potrero_recomendaciones_descanso_descanso_id_seq to agx_owner;

-- =======================================================================
-- HARDENING TERRITORIAL: agx.potrero_climatologias_agroclimaticas -- caché
-- append-only de climatología LOCAL histórica por potrero (§2/§19 del
-- hardening territorial). NUNCA se recalcula en cada "Calcular descanso"
-- (§20: "la climatología no cambia diariamente") -- se refresca de forma
-- explícita/infrecuente (creación del potrero, refresh manual, cambio de
-- método). El motor de descanso LEE la fila más reciente; refrescarla es
-- responsabilidad de un proceso separado (ver
-- potreroClimatologiaRepository.js -- refreshPotreroClimatologia, aún no
-- expuesto por HTTP en este sprint, §29: "mantenerlo interno al motor").
-- =======================================================================
create table agx.potrero_climatologias_agroclimaticas (
  climatologia_id bigserial primary key,
  organizacion_id uuid not null,
  predio_id bigint not null,
  potrero_id bigint not null,

  -- Periodo climatológico de precipitación/temperatura (§3 del hardening
  -- -- normal OMM/WMO de 30 años, documentado, nunca hardcodeado sin
  -- razón: ver WMO_CLIMATOLOGY_PERIOD en era5HistoricalClimatologyProvider.js).
  period_start_year integer not null,
  period_end_year integer not null,

  -- Periodo de humedad de suelo -- HARDENING OPERACIONAL: auditoría
  -- empírica (2026-08-25) confirmó que ERA5-Land tiene la MISMA
  -- disponibilidad real que precipitación/temperatura para este punto (ver
  -- cabecera de era5HistoricalClimatologyProvider.js) -- en v1 coincide
  -- con period_start_year/period_end_year. Columnas separadas por si un
  -- futuro proveedor de suelo distinto requiere un periodo propio (aditivo,
  -- nunca 0009 solo para esto).
  soil_period_start_year integer,
  soil_period_end_year integer,

  dataset varchar(40) not null default 'ERA5_ERA5LAND',
  provider varchar(40) not null default 'OPEN_METEO',

  -- Versión del MÉTODO de cálculo de climatología (percentiles/breakpoints,
  -- climatologyStatistics.js) -- una climatología calculada con un método
  -- anterior NUNCA se reinterpreta silenciosamente bajo reglas nuevas
  -- (mismo criterio que motor_version en las demás tablas del esquema).
  method_version varchar(40) not null,

  -- Breakpoints P10/P25/P50/P75/P90 por mes calendario (1-12) y variable
  -- (precipitacion7dMm/15d/30d, temperaturaMediaC, humedadSueloSuperficial,
  -- humedadSueloSubsuperficial) -- ver buildMonthlyClimatology en
  -- climatologyStatistics.js. NUNCA observaciones horarias/diarias crudas
  -- (§19 del hardening: "no guardar millones de observaciones horarias si
  -- solo necesitamos estadísticas derivadas").
  monthly_statistics_json jsonb not null default '{}',

  -- Trazabilidad de qué variable se obtuvo y cuáles fallaron por año (§27
  -- del hardening) -- nunca oculta un fallo parcial.
  fuentes_json jsonb not null default '[]',

  created_at timestamptz not null default now(),

  constraint potrero_climatologias_period_check
    check (period_end_year >= period_start_year),
  constraint potrero_climatologias_soil_period_check
    check (
      (soil_period_start_year is null and soil_period_end_year is null)
      or (soil_period_end_year >= soil_period_start_year)
    )
);

comment on table agx.potrero_climatologias_agroclimaticas is
  'Caché append-only de climatología LOCAL histórica por potrero (hardening territorial, SPRINT-3D8) -- percentiles mensuales, nunca observaciones crudas. Refrescada de forma infrecuente (nunca en cada cálculo de descanso). NUNCA se actualiza/sobrescribe una fila existente -- un refresh siempre inserta una fila nueva.';
comment on column agx.potrero_climatologias_agroclimaticas.monthly_statistics_json is
  'Breakpoints P10/P25/P50/P75/P90 por mes calendario (1-12) y variable -- base para clasificar valores ACTUALES relativos a la distribución histórica LOCAL de ese potrero/época del año, nunca contra un umbral absoluto universal.';

alter table agx.potrero_climatologias_agroclimaticas
  add constraint potrero_climatologias_potrero_organizacion_fkey
  foreign key (potrero_id, organizacion_id)
  references agx.potreros (potrero_id, organizacion_id);

alter table agx.potrero_climatologias_agroclimaticas
  add constraint potrero_climatologias_predio_organizacion_fkey
  foreign key (predio_id, organizacion_id)
  references agx.predios (predio_id, organizacion_id);

create index potrero_climatologias_organizacion_id_idx on agx.potrero_climatologias_agroclimaticas (organizacion_id);
create index potrero_climatologias_potrero_id_idx on agx.potrero_climatologias_agroclimaticas (potrero_id);
create index potrero_climatologias_potrero_created_idx
  on agx.potrero_climatologias_agroclimaticas (potrero_id, created_at desc);

alter table agx.potrero_climatologias_agroclimaticas owner to agx_owner;

alter table agx.potrero_climatologias_agroclimaticas enable row level security;
alter table agx.potrero_climatologias_agroclimaticas force row level security;

create policy potrero_climatologias_tenant_isolation on agx.potrero_climatologias_agroclimaticas
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- Grants -- caché append-only para la aplicación: SELECT/INSERT
-- únicamente. Un refresh siempre inserta una fila nueva -- nunca UPDATE.
grant select, insert on agx.potrero_climatologias_agroclimaticas to agx_app;
grant usage, select on sequence agx.potrero_climatologias_agroclimaticas_climatologia_id_seq to agx_app;

grant all privileges on agx.potrero_climatologias_agroclimaticas to agx_owner;
grant usage, select on sequence agx.potrero_climatologias_agroclimaticas_climatologia_id_seq to agx_owner;
