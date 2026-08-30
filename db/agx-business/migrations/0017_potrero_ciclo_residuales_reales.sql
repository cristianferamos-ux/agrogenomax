-- SPRINT-3D9.4 -- RESIDUAL REAL POST-PASTOREO
--
-- Medición REAL de biomasa tomada DESPUÉS de la salida de un ciclo, para
-- comparar el remanente ESTIMADO (3D9.3, computeRealPressureCore) contra
-- el remanente MEDIDO en campo. ESTIMADO != MEDIDO -- nunca se presenta
-- una estimación como observación real, ni se sustituye una por otra.
--
-- Entidad independiente de agx.potrero_fichas_productivas (0004) --
-- deliberadamente NO se reutiliza esa tabla: un residual post-salida y un
-- aforo pre-ingreso/pre-reingreso son hechos semánticamente distintos, y
-- agx.potrero_evaluaciones_reingreso (0013) ya usa esa misma tabla como
-- evidencia de reingreso -- sin discriminador de rol, mezclar ambos usos
-- ahí permitiría que una medición se reutilizara por error entre roles
-- opuestos. Cycle-scoped, append-only, versionado -- mismo patrón exacto
-- que agx.potrero_ciclo_lote_real_versiones (0015).
--
-- Jerarquía de evidencia (nunca colapsada en una sola resolución):
--   NIVEL 0 (hecho físico, SIEMPRE persistible): numero_muestras,
--     aforo_promedio_g_m2, biomasa_fresca_total_kg, medicion_real_at,
--     horas_desde_salida -- nunca bloqueado por falta de ciencia.
--   NIVEL 1 (derivación científica, independiente de nivel 2):
--     materia_seca_pct_aplicado/materia_seca_fuente/remanente_medido_kg_ms
--     -- nullable, depende solo de que exista snapshot_lote_real_id con
--     ficha base elegible (mismo criterio que 0015).
--   NIVEL 2 (comparación, depende de nivel 1 Y de un descanso REAL ya
--     calculado): descanso_estimado_origen_id/remanente_estimado_kg_ms_congelado/
--     error_absoluto_kg/error_porcentual -- nullable, nunca sustituido por
--     PLAN.
--
-- comparativoEstado (COMPLETO/PENDIENTE_MATERIA_SECA/PENDIENTE_ESTIMADO/
-- DESACTUALIZADO_POR_CORRECCION/INCOMPATIBLE_TEMPORAL) se DERIVA en
-- lectura cruzando estas columnas contra el estado vigente del ciclo --
-- deliberadamente NO es una columna aquí (evitaría UPDATE de una fila
-- append-only, y es inequívocamente derivable).
--
-- Requiere 0000-0016 ya aplicados.

create table agx.potrero_ciclo_residuales_reales_versiones (
  residual_id bigserial primary key,
  organizacion_id uuid not null,
  predio_id bigint not null,
  potrero_id bigint not null,
  ciclo_id bigint not null,

  version integer not null,

  -- NIVEL 0 -- hecho físico de campo, SIEMPRE persistible sin importar si
  -- existe evidencia científica disponible (clima caído, descanso REAL
  -- pendiente, etc.).
  numero_muestras integer not null,
  aforo_promedio_g_m2 numeric not null,
  biomasa_fresca_total_kg numeric not null,

  -- medicion_real_at: momento declarado de campo (afirmación del
  -- usuario). created_at: momento de registro en AgroGenomaX (hecho de
  -- sistema). NUNCA se sustituye uno por otro -- la validación
  -- medicion_real_at <= created_at (misma lectura de now() de Postgres,
  -- ver potreroCicloResidualRealRepository.js) garantiza que el reloj del
  -- cliente nunca gobierna.
  medicion_real_at timestamptz not null,
  -- horas_desde_salida: congelado contra la salida_real_at VIGENTE del
  -- ciclo en el momento de esta versión (capturar o "actualizar
  -- comparativo") -- nunca recalculado retroactivamente fuera de esas dos
  -- operaciones. Deliberadamente SIN CHECK >= 0 (mismo criterio que 0015
  -- con la duración del snapshot real): tras una corrección de
  -- fechaSalidaReal que deja la medición físicamente ANTERIOR a la nueva
  -- salida, "actualizar comparativo" debe poder PERSISTIR ese resultado
  -- negativo igual (evidencia congelada real, aunque incompatible) para
  -- que la capa de aplicación lo clasifique como INCOMPATIBLE_TEMPORAL en
  -- vez de que el INSERT falle y bloquee la auditoría de la corrección.
  horas_desde_salida numeric not null,

  -- NIVEL 1 -- derivación científica: %MS resuelto vía la MISMA
  -- resolución de pastura/clima que 3D9.3 (resolvePastureClimateParams),
  -- nunca una fórmula nueva. NULL si no hay snapshot con ficha base
  -- elegible (ver snapshot_lote_real_id) -- el hecho físico igual se
  -- persiste.
  materia_seca_pct_aplicado numeric,
  materia_seca_fuente varchar(30),
  -- Hook futuro bromatológico (mismo criterio que
  -- pastureClimateEngine.js:materiaSecaMedidaPct) -- NUNCA poblado en
  -- 3D9.4.
  materia_seca_pct_medida numeric,
  -- remanente_medido_kg_ms = biomasa_fresca_total_kg x
  -- materia_seca_pct_aplicado / 100 (computeMateriaSecaTotalKg, sin
  -- fórmula nueva). NULL mientras materia_seca_pct_aplicado sea NULL --
  -- nunca inventado ni sustituido por PLAN.
  remanente_medido_kg_ms numeric,

  -- Snapshot científico del ciclo vigente en el momento en que NIVEL 1 se
  -- resolvió -- ancla para detectar DESACTUALIZADO_POR_CORRECCION cuando
  -- una corrección posterior del ciclo genera una versión de snapshot
  -- distinta.
  snapshot_lote_real_id bigint,

  -- NIVEL 2 -- comparación contra el descanso REAL vigente en el momento
  -- de esta versión. descanso_estimado_origen_id ancla EXACTAMENTE qué
  -- cálculo fue comparado -- nunca un lookup futuro a "descanso vigente"
  -- como sustituto (ver aplicar-a-descanso en el repositorio).
  descanso_estimado_origen_id bigint,
  remanente_estimado_kg_ms_congelado numeric,
  error_absoluto_kg numeric,
  -- NULL cuando remanente_estimado_kg_ms_congelado <= 0 (división por
  -- cero evitada explícitamente, nunca 0 ni Infinity).
  error_porcentual numeric,

  observacion text,
  actor_cuenta_id uuid,
  created_at timestamptz not null default now(),

  constraint potrero_ciclo_residual_real_version_check check (version >= 1),
  constraint potrero_ciclo_residual_real_numero_muestras_check check (numero_muestras >= 1),
  constraint potrero_ciclo_residual_real_aforo_check check (aforo_promedio_g_m2 >= 0),
  constraint potrero_ciclo_residual_real_biomasa_check check (biomasa_fresca_total_kg >= 0)
);

comment on table agx.potrero_ciclo_residuales_reales_versiones is
  'SPRINT-3D9.4: medición REAL de biomasa post-salida de un ciclo -- append-only/versionado, cycle-scoped, independiente de agx.potrero_fichas_productivas. El hecho físico (numero_muestras/aforo_promedio_g_m2/biomasa_fresca_total_kg/medicion_real_at/horas_desde_salida) es SIEMPRE persistible; las derivaciones científicas (%MS, remanente medido, comparativo contra el estimado REAL) son NULLABLE e independientes entre sí -- nunca sustituidas por PLAN. comparativoEstado se deriva en lectura, no se persiste. SELECT/INSERT únicamente -- NUNCA UPDATE/DELETE.';
comment on column agx.potrero_ciclo_residuales_reales_versiones.snapshot_lote_real_id is
  'Versión de agx.potrero_ciclo_lote_real_versiones vigente cuando se resolvió %MS/remanente medido -- si ya no coincide con la vigente actual del ciclo, el comparativo es DESACTUALIZADO_POR_CORRECCION.';
comment on column agx.potrero_ciclo_residuales_reales_versiones.descanso_estimado_origen_id is
  'Descanso EXACTO (fuentePresion=REAL) cuyo remanente estimado fue congelado y comparado contra esta medición -- nunca se sustituye por un lookup a "descanso vigente" al aplicar a descanso.';

alter table agx.potrero_ciclo_residuales_reales_versiones
  add constraint potrero_ciclo_residual_real_ciclo_potrero_organizacion_fkey
  foreign key (ciclo_id, potrero_id, organizacion_id)
  references agx.potrero_ciclos_pastoreo (ciclo_id, potrero_id, organizacion_id);

-- Nullable: si snapshot_lote_real_id es NULL (NIVEL 1 no pudo resolverse
-- al capturar), la FK no se evalúa (MATCH SIMPLE estándar de Postgres).
alter table agx.potrero_ciclo_residuales_reales_versiones
  add constraint potrero_ciclo_residual_real_snapshot_fkey
  foreign key (snapshot_lote_real_id, ciclo_id, potrero_id, organizacion_id)
  references agx.potrero_ciclo_lote_real_versiones (snapshot_id, ciclo_id, potrero_id, organizacion_id);

-- Nullable: si descanso_estimado_origen_id es NULL (NIVEL 2 no pudo
-- resolverse), la FK no se evalúa. FK tenant-safe fuerte de 4 columnas --
-- garantiza que el descanso origen pertenece exactamente al mismo ciclo/
-- potrero/organización, nunca una combinación inventada.
alter table agx.potrero_ciclo_residuales_reales_versiones
  add constraint potrero_ciclo_residual_real_descanso_origen_fkey
  foreign key (descanso_estimado_origen_id, ciclo_id, potrero_id, organizacion_id)
  references agx.potrero_recomendaciones_descanso (descanso_id, ciclo_pastoreo_id, potrero_id, organizacion_id);

-- Como máximo una fila por (ciclo, versión) -- mismo mecanismo de
-- idempotencia bajo carrera que 0012/0015 (perdedor de un 23505 relee la
-- fila ganadora en vez de duplicar).
create unique index potrero_ciclo_residual_real_un_ciclo_version_idx
  on agx.potrero_ciclo_residuales_reales_versiones (ciclo_id, version);

-- Anchor de 4 columnas (mismo patrón de 0012/0013/0015) -- permite que
-- agx.potrero_ciclo_residual_real_invalidaciones verifique en UNA
-- sola FK, a nivel de integridad referencial, que residual_id/ciclo_id/
-- potrero_id/organizacion_id corresponden realmente a la misma fila.
alter table agx.potrero_ciclo_residuales_reales_versiones
  add constraint potrero_ciclo_residual_real_id_ciclo_potrero_organizacion_unique
  unique (residual_id, ciclo_id, potrero_id, organizacion_id);

create index potrero_ciclo_residual_real_organizacion_id_idx on agx.potrero_ciclo_residuales_reales_versiones (organizacion_id);
create index potrero_ciclo_residual_real_potrero_id_idx on agx.potrero_ciclo_residuales_reales_versiones (potrero_id);
create index potrero_ciclo_residual_real_ciclo_id_idx on agx.potrero_ciclo_residuales_reales_versiones (ciclo_id, version desc);

alter table agx.potrero_ciclo_residuales_reales_versiones owner to agx_owner;
alter table agx.potrero_ciclo_residuales_reales_versiones enable row level security;
alter table agx.potrero_ciclo_residuales_reales_versiones force row level security;

create policy potrero_ciclo_residuales_reales_versiones_tenant_isolation on agx.potrero_ciclo_residuales_reales_versiones
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

grant select, insert on agx.potrero_ciclo_residuales_reales_versiones to agx_app;
grant usage, select on sequence agx.potrero_ciclo_residuales_reales_versiones_residual_id_seq to agx_app;

grant all privileges on agx.potrero_ciclo_residuales_reales_versiones to agx_owner;
grant usage, select on sequence agx.potrero_ciclo_residuales_reales_versiones_residual_id_seq to agx_owner;

-- =======================================================================
-- agx.potrero_ciclo_residual_real_invalidaciones -- log append-only
-- puro, mismo criterio exacto que agx.potrero_ciclo_lote_real_invalidaciones
-- (0015)/agx.potrero_descanso_invalidaciones (0012).
-- =======================================================================
create table agx.potrero_ciclo_residual_real_invalidaciones (
  invalidacion_id bigserial primary key,
  organizacion_id uuid not null,
  potrero_id bigint not null,
  residual_id bigint not null,
  ciclo_id bigint not null,

  motivo text not null,
  actor_cuenta_id uuid,
  ocurrido_en timestamptz not null default now(),

  constraint potrero_ciclo_residual_real_invalidaciones_motivo_check
    check (btrim(motivo) <> '')
);

comment on table agx.potrero_ciclo_residual_real_invalidaciones is
  'SPRINT-3D9.4: invalidación append-only de una versión de residual real -- nunca DELETE/UPDATE de la fila original. Se inserta al corregir (nueva versión reemplaza) o al anular explícitamente. SELECT/INSERT únicamente -- NUNCA UPDATE/DELETE.';

alter table agx.potrero_ciclo_residual_real_invalidaciones
  add constraint potrero_ciclo_residual_real_invalidaciones_residual_fkey
  foreign key (residual_id, ciclo_id, potrero_id, organizacion_id)
  references agx.potrero_ciclo_residuales_reales_versiones (residual_id, ciclo_id, potrero_id, organizacion_id);

-- Como máximo UNA invalidación por versión.
create unique index potrero_ciclo_residual_real_invalidaciones_un_residual_idx
  on agx.potrero_ciclo_residual_real_invalidaciones (residual_id);

create index potrero_ciclo_residual_real_invalidaciones_organizacion_id_idx on agx.potrero_ciclo_residual_real_invalidaciones (organizacion_id);
create index potrero_ciclo_residual_real_invalidaciones_ciclo_id_idx on agx.potrero_ciclo_residual_real_invalidaciones (ciclo_id);

alter table agx.potrero_ciclo_residual_real_invalidaciones owner to agx_owner;
alter table agx.potrero_ciclo_residual_real_invalidaciones enable row level security;
alter table agx.potrero_ciclo_residual_real_invalidaciones force row level security;

create policy potrero_ciclo_residual_real_invalidaciones_tenant_isolation on agx.potrero_ciclo_residual_real_invalidaciones
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

grant select, insert on agx.potrero_ciclo_residual_real_invalidaciones to agx_app;
grant usage, select on sequence agx.potrero_ciclo_residual_real_invalidaciones_invalidacion_id_seq to agx_app;

grant all privileges on agx.potrero_ciclo_residual_real_invalidaciones to agx_owner;
grant usage, select on sequence agx.potrero_ciclo_residual_real_invalidaciones_invalidacion_id_seq to agx_owner;
