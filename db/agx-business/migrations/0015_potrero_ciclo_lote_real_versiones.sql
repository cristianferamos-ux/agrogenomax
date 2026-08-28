-- SPRINT-3D9.3 -- SNAPSHOT REAL VERSIONADO DEL LOTE (REAL PRESSURE)
--
-- Parte 2 de 3 de SPRINT-3D9.3. Opción B del diseño aprobado: entidad
-- append-only/versionada separada del current-state operacional
-- (agx.potrero_ciclos_pastoreo), en vez de ensanchar aún más su grant
-- columnar ya delicado (0009/0011). Se convierte en la FUENTE CIENTÍFICA
-- AUTORITATIVA de categoría/cantidad/peso/lactancia/ternero/ficha base
-- para todo ciclo que la tenga -- las columnas equivalentes de
-- agx.potrero_ciclos_pastoreo (categoria_id/numero_animales_real/
-- peso_promedio_real_kg) quedan como espejo de compatibilidad,
-- sincronizado como efecto atómico de la MISMA transacción que crea cada
-- versión nueva (nunca un segundo camino de corrección independiente).
--
-- version=1 se crea SIEMPRE al "Iniciar pastoreo" (salida_real_at NULL);
-- version=2 se crea SIEMPRE al "Finalizar pastoreo" (copia los campos
-- científicos de v1, agrega salida_real_at); version=3+ solo ante una
-- corrección posterior. Cada versión nueva invalida la anterior en la
-- MISMA transacción -- nunca hay dos versiones vigentes simultáneas.
--
-- Requiere 0000-0014 ya aplicados.

create table agx.potrero_ciclo_lote_real_versiones (
  snapshot_id bigserial primary key,
  organizacion_id uuid not null,
  predio_id bigint not null,
  potrero_id bigint not null,
  ciclo_id bigint not null,

  version integer not null,

  -- Snapshot científico completo -- cada versión nueva copia TODOS estos
  -- campos de la vigente anterior y solo cambia los explícitamente
  -- corregidos (o agrega salida_real_at al finalizar). Nunca un UPDATE
  -- parcial de una fila existente.
  categoria_id bigint not null,
  numero_animales integer not null,
  peso_promedio_kg numeric not null,

  produccion_leche_l_dia numeric,
  dias_en_leche integer,
  grasa_leche_pct numeric,
  ternero_al_pie boolean,

  -- Evidencia de biomasa -- NULL cuando ninguna ficha satisface el doble
  -- guardrail temporal (ver potreroCicloRealPressureRepository.js): sin
  -- esto, REAL pressure no puede calcularse para esta versión (cae a
  -- PLAN_FALLBACK), pero el ciclo/snapshot igual se crea con normalidad.
  ficha_id_base_real bigint,

  -- Evidencia científica CONGELADA usada por el cálculo de ESTA versión
  -- -- espejo inmutable del timestamp operacional vigente en
  -- agx.potrero_ciclos_pastoreo al momento de crear esta fila. NUNCA
  -- diverge de él (ambos se escriben en la misma transacción, siempre).
  ingreso_real_at timestamptz not null,
  salida_real_at timestamptz,

  actor_cuenta_id uuid,
  created_at timestamptz not null default now(),

  constraint potrero_ciclo_lote_real_version_check check (version >= 1),
  constraint potrero_ciclo_lote_real_numero_animales_check
    check (numero_animales >= 1 and numero_animales <= 100000),
  constraint potrero_ciclo_lote_real_peso_promedio_check
    check (peso_promedio_kg > 0 and peso_promedio_kg <= 2000)
  -- Deliberadamente SIN un CHECK de duración aquí (a diferencia de las
  -- fechas DATE de 0009) -- una versión con salida_real_at <=
  -- ingreso_real_at debe poder PERSISTIRSE igual (es evidencia congelada
  -- real, aunque inconsistente) para que la capa de aplicación
  -- (computeRealPressureCore, potreroCicloRealPressureRepository.js) la
  -- clasifique como DURACION_INVALIDA -> PLAN_FALLBACK, en vez de que el
  -- INSERT falle y bloquee FASE A de "Finalizar pastoreo" (que SIEMPRE
  -- debe poder completar el hecho crítico, incluso con evidencia real
  -- degenerada).
);

comment on table agx.potrero_ciclo_lote_real_versiones is
  'SPRINT-3D9.3: snapshot append-only/versionado del lote REAL de un ciclo -- fuente científica autoritativa (categoría/cantidad/peso/lactancia/ternero/ficha base/timestamps) para todo ciclo que tenga al menos una versión. version=1 al iniciar (salida_real_at null), version=2 al finalizar (copia v1 + agrega salida_real_at), version=3+ solo ante corrección posterior. SELECT/INSERT únicamente -- NUNCA UPDATE/DELETE, ver agx.potrero_ciclo_lote_real_invalidaciones para "vigencia".';
comment on column agx.potrero_ciclo_lote_real_versiones.ficha_id_base_real is
  'Ficha elegible más reciente con fecha_aforo <= fecha de negocio del ingreso Y created_at <= ingreso_real_at (doble guardrail -- fecha_aforo es autoreportada, created_at es hecho de sistema no manipulable). NULL si ninguna ficha satisface ambos guardrails -- el ciclo/snapshot igual se crea, REAL pressure cae a PLAN_FALLBACK para esa versión.';

alter table agx.potrero_ciclo_lote_real_versiones
  add constraint potrero_ciclo_lote_real_ciclo_potrero_organizacion_fkey
  foreign key (ciclo_id, potrero_id, organizacion_id)
  references agx.potrero_ciclos_pastoreo (ciclo_id, potrero_id, organizacion_id);

alter table agx.potrero_ciclo_lote_real_versiones
  add constraint potrero_ciclo_lote_real_categoria_fkey
  foreign key (categoria_id)
  references agx.catalogo_categorias_productivas (categoria_id);

-- Nullable: si ficha_id_base_real es NULL, esta FK compuesta no se evalúa
-- (comportamiento MATCH SIMPLE estándar de Postgres) -- exactamente el
-- caso "sin evidencia elegible".
alter table agx.potrero_ciclo_lote_real_versiones
  add constraint potrero_ciclo_lote_real_ficha_fkey
  foreign key (ficha_id_base_real, potrero_id, organizacion_id)
  references agx.potrero_fichas_productivas (ficha_id, potrero_id, organizacion_id);

-- Como máximo una fila por (ciclo, versión) -- mismo mecanismo de
-- idempotencia bajo carrera que 0012 (perdedor de un 23505 relee la fila
-- ganadora en vez de duplicar).
create unique index potrero_ciclo_lote_real_un_ciclo_version_idx
  on agx.potrero_ciclo_lote_real_versiones (ciclo_id, version);

-- Anchor de 4 columnas (mismo patrón de 0012/0013) -- permite que
-- agx.potrero_ciclo_lote_real_invalidaciones verifique en UNA sola FK, a
-- nivel de integridad referencial, que snapshot_id/ciclo_id/potrero_id/
-- organizacion_id corresponden realmente a la misma fila.
alter table agx.potrero_ciclo_lote_real_versiones
  add constraint potrero_ciclo_lote_real_id_ciclo_potrero_organizacion_unique
  unique (snapshot_id, ciclo_id, potrero_id, organizacion_id);

create index potrero_ciclo_lote_real_organizacion_id_idx on agx.potrero_ciclo_lote_real_versiones (organizacion_id);
create index potrero_ciclo_lote_real_potrero_id_idx on agx.potrero_ciclo_lote_real_versiones (potrero_id);
create index potrero_ciclo_lote_real_ciclo_id_idx on agx.potrero_ciclo_lote_real_versiones (ciclo_id, version desc);

alter table agx.potrero_ciclo_lote_real_versiones owner to agx_owner;
alter table agx.potrero_ciclo_lote_real_versiones enable row level security;
alter table agx.potrero_ciclo_lote_real_versiones force row level security;

create policy potrero_ciclo_lote_real_versiones_tenant_isolation on agx.potrero_ciclo_lote_real_versiones
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

grant select, insert on agx.potrero_ciclo_lote_real_versiones to agx_app;
grant usage, select on sequence agx.potrero_ciclo_lote_real_versiones_snapshot_id_seq to agx_app;

grant all privileges on agx.potrero_ciclo_lote_real_versiones to agx_owner;
grant usage, select on sequence agx.potrero_ciclo_lote_real_versiones_snapshot_id_seq to agx_owner;

-- =======================================================================
-- agx.potrero_ciclo_lote_real_invalidaciones -- log append-only puro,
-- mismo criterio exacto que agx.potrero_descanso_invalidaciones (0012).
-- =======================================================================
create table agx.potrero_ciclo_lote_real_invalidaciones (
  invalidacion_id bigserial primary key,
  organizacion_id uuid not null,
  potrero_id bigint not null,
  snapshot_id bigint not null,
  ciclo_id bigint not null,

  motivo text not null,
  actor_cuenta_id uuid,
  ocurrido_en timestamptz not null default now(),

  constraint potrero_ciclo_lote_real_invalidaciones_motivo_check
    check (btrim(motivo) <> '')
);

comment on table agx.potrero_ciclo_lote_real_invalidaciones is
  'SPRINT-3D9.3: invalidación append-only de una versión del snapshot real de lote -- nunca DELETE/UPDATE de la fila original. Se inserta cuando: (a) se finaliza el ciclo (invalida v1 al crear v2), o (b) se corrige el lote real de un ciclo ya finalizado (invalida la versión vigente al crear la siguiente). SELECT/INSERT únicamente -- NUNCA UPDATE/DELETE.';

alter table agx.potrero_ciclo_lote_real_invalidaciones
  add constraint potrero_ciclo_lote_real_invalidaciones_snapshot_ciclo_fkey
  foreign key (snapshot_id, ciclo_id, potrero_id, organizacion_id)
  references agx.potrero_ciclo_lote_real_versiones (snapshot_id, ciclo_id, potrero_id, organizacion_id);

-- Como máximo UNA invalidación por versión -- una versión ya invalidada
-- nunca se invalida dos veces (tolerante a reintento en capa de
-- aplicación, mismo criterio que invalidarDescansoVersion).
create unique index potrero_ciclo_lote_real_invalidaciones_un_snapshot_idx
  on agx.potrero_ciclo_lote_real_invalidaciones (snapshot_id);

create index potrero_ciclo_lote_real_invalidaciones_organizacion_id_idx on agx.potrero_ciclo_lote_real_invalidaciones (organizacion_id);
create index potrero_ciclo_lote_real_invalidaciones_ciclo_id_idx on agx.potrero_ciclo_lote_real_invalidaciones (ciclo_id);

alter table agx.potrero_ciclo_lote_real_invalidaciones owner to agx_owner;
alter table agx.potrero_ciclo_lote_real_invalidaciones enable row level security;
alter table agx.potrero_ciclo_lote_real_invalidaciones force row level security;

create policy potrero_ciclo_lote_real_invalidaciones_tenant_isolation on agx.potrero_ciclo_lote_real_invalidaciones
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

grant select, insert on agx.potrero_ciclo_lote_real_invalidaciones to agx_app;
grant usage, select on sequence agx.potrero_ciclo_lote_real_invalidaciones_invalidacion_id_seq to agx_app;

grant all privileges on agx.potrero_ciclo_lote_real_invalidaciones to agx_owner;
grant usage, select on sequence agx.potrero_ciclo_lote_real_invalidaciones_invalidacion_id_seq to agx_owner;
