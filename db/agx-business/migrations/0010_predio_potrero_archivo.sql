-- SPRINT-3D9.2 -- ARCHIVO DE PREDIO/POTRERO (ARCHIVE_ONLY)
--
-- Ni agx.predios ni agx.potreros admiten hoy un hard DELETE seguro desde
-- la aplicación (ambas tienen cascada operativa completa dependiendo de
-- ellas -- fichas, contextos, recomendaciones, ciclos, eventos). Este
-- archivo introduce archivado reversible (ACTIVO <-> ARCHIVADO) como
-- reemplazo del hard DELETE, y CIERRA el gap real detectado en la
-- auditoría 3D9.2: agx_app tenía grant DELETE en ambas tablas desde
-- 0001/0003, sin que ningún endpoint lo usara -- riesgo latente, nunca
-- explotado, revocado aquí explícitamente.
--
-- Columnas current-state (responden "¿está archivado AHORA, desde
-- cuándo?") + tabla de eventos append-only por entidad (responde "¿cuál
-- es la historia completa de archivar/restaurar?", sin perder auditoría
-- si se repite varias veces) -- SPRINT-3D9.2 DESIGN REVISION, sección G.
--
-- Aditiva pura. Requiere 0000-0009 ya aplicados. Nunca ejecutar contra
-- Railway/producción sin autorización explícita separada.

-- =======================================================================
-- agx.predios -- columnas current-state.
-- =======================================================================
alter table agx.predios add column if not exists estado varchar(20) not null default 'ACTIVO';
alter table agx.predios add column if not exists archivado_at timestamptz;
alter table agx.predios add column if not exists archivado_por uuid;
alter table agx.predios add column if not exists motivo_archivado text;

alter table agx.predios
  add constraint predios_estado_check check (estado in ('ACTIVO', 'ARCHIVADO'));

-- Exhaustivo: ARCHIVADO exige archivado_at + motivo_archivado poblados;
-- ACTIVO los exige todos NULL (nunca "medio archivado"). archivado_por
-- se mantiene NULLABLE incluso en ARCHIVADO -- mismo criterio de
-- actor_cuenta_id en TODO el resto del esquema (potrero_ciclo_eventos,
-- potrero_descanso_invalidaciones, potrero_evaluaciones_reingreso):
-- auditoría deseable, nunca obligatoria a nivel de integridad.
alter table agx.predios
  add constraint predios_estado_consistency_check
  check (
    (estado = 'ACTIVO'
      and archivado_at is null
      and archivado_por is null
      and motivo_archivado is null)
    or
    (estado = 'ARCHIVADO'
      and archivado_at is not null
      and motivo_archivado is not null
      and btrim(motivo_archivado) <> '')
  );

comment on column agx.predios.estado is
  'SPRINT-3D9.2: ACTIVO/ARCHIVADO -- reemplaza el hard DELETE (revocado más abajo). Archivar NO borra ni modifica potreros/fichas/recomendaciones/ciclos -- toda la historia permanece intacta y consultable.';

-- =======================================================================
-- agx.potreros -- mismas columnas current-state.
-- =======================================================================
alter table agx.potreros add column if not exists estado varchar(20) not null default 'ACTIVO';
alter table agx.potreros add column if not exists archivado_at timestamptz;
alter table agx.potreros add column if not exists archivado_por uuid;
alter table agx.potreros add column if not exists motivo_archivado text;

alter table agx.potreros
  add constraint potreros_estado_check check (estado in ('ACTIVO', 'ARCHIVADO'));

alter table agx.potreros
  add constraint potreros_estado_consistency_check
  check (
    (estado = 'ACTIVO'
      and archivado_at is null
      and archivado_por is null
      and motivo_archivado is null)
    or
    (estado = 'ARCHIVADO'
      and archivado_at is not null
      and motivo_archivado is not null
      and btrim(motivo_archivado) <> '')
  );

comment on column agx.potreros.estado is
  'SPRINT-3D9.2: ACTIVO/ARCHIVADO. Un potrero ARCHIVADO conserva su historia (fichas/recomendaciones/ciclos/eventos) y sigue siendo consultable -- solo deja de aceptar nuevas fichas/recomendaciones/ciclos y de aparecer en listados activos por defecto. El estado operativo derivado del potrero también hereda ARCHIVADO cuando su predio padre está archivado (ver server/services/ganaderia/potreroArchivoRepository.js) -- eso es una precedencia de LECTURA, nunca escribe sobre esta columna.';

-- =======================================================================
-- REVOKE DELETE -- cierra el gap de la auditoría 3D9.2 (grant existente
-- desde 0001/0003, nunca explotado por ningún endpoint, pero
-- innecesariamente amplio ahora que existe el reemplazo ARCHIVE_ONLY).
-- =======================================================================
revoke delete on agx.predios from agx_app;
revoke delete on agx.potreros from agx_app;

-- =======================================================================
-- agx.predio_archivo_eventos -- log append-only (auditoría completa,
-- independiente de las columnas current-state de arriba).
-- =======================================================================
create table agx.predio_archivo_eventos (
  evento_id bigserial primary key,
  organizacion_id uuid not null,
  predio_id bigint not null,

  tipo_evento varchar(20) not null,

  -- Obligatorio para ARCHIVADO (auditable, por qué se archivó). Opcional
  -- para RESTAURADO (mismo criterio que "cancelar" nunca exige motivo
  -- para revertir una acción, solo para tomarla).
  motivo text,

  actor_cuenta_id uuid,
  ocurrido_en timestamptz not null default now(),

  constraint predio_archivo_eventos_tipo_check
    check (tipo_evento in ('ARCHIVADO', 'RESTAURADO')),
  constraint predio_archivo_eventos_motivo_check
    check (tipo_evento = 'RESTAURADO' or (motivo is not null and btrim(motivo) <> ''))
);

comment on table agx.predio_archivo_eventos is
  'Log append-only de archivar/restaurar predio (SPRINT-3D9.2) -- SELECT/INSERT únicamente para agx_app, NUNCA UPDATE/DELETE. Conserva la historia completa aunque el predio se archive/restaure varias veces (las columnas current-state de agx.predios solo reflejan la ÚLTIMA transición).';

alter table agx.predio_archivo_eventos
  add constraint predio_archivo_eventos_predio_organizacion_fkey
  foreign key (predio_id, organizacion_id)
  references agx.predios (predio_id, organizacion_id);

create index predio_archivo_eventos_predio_id_idx on agx.predio_archivo_eventos (predio_id, ocurrido_en);
create index predio_archivo_eventos_organizacion_id_idx on agx.predio_archivo_eventos (organizacion_id);

alter table agx.predio_archivo_eventos owner to agx_owner;
alter table agx.predio_archivo_eventos enable row level security;
alter table agx.predio_archivo_eventos force row level security;

create policy predio_archivo_eventos_tenant_isolation on agx.predio_archivo_eventos
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

grant select, insert on agx.predio_archivo_eventos to agx_app;
grant usage, select on sequence agx.predio_archivo_eventos_evento_id_seq to agx_app;

grant all privileges on agx.predio_archivo_eventos to agx_owner;
grant usage, select on sequence agx.predio_archivo_eventos_evento_id_seq to agx_owner;

-- =======================================================================
-- agx.potrero_archivo_eventos -- mismo diseño, para potreros.
-- =======================================================================
create table agx.potrero_archivo_eventos (
  evento_id bigserial primary key,
  organizacion_id uuid not null,
  potrero_id bigint not null,

  tipo_evento varchar(20) not null,
  motivo text,

  actor_cuenta_id uuid,
  ocurrido_en timestamptz not null default now(),

  constraint potrero_archivo_eventos_tipo_check
    check (tipo_evento in ('ARCHIVADO', 'RESTAURADO')),
  constraint potrero_archivo_eventos_motivo_check
    check (tipo_evento = 'RESTAURADO' or (motivo is not null and btrim(motivo) <> ''))
);

comment on table agx.potrero_archivo_eventos is
  'Log append-only de archivar/restaurar potrero (SPRINT-3D9.2) -- mismo criterio que agx.predio_archivo_eventos.';

alter table agx.potrero_archivo_eventos
  add constraint potrero_archivo_eventos_potrero_organizacion_fkey
  foreign key (potrero_id, organizacion_id)
  references agx.potreros (potrero_id, organizacion_id);

create index potrero_archivo_eventos_potrero_id_idx on agx.potrero_archivo_eventos (potrero_id, ocurrido_en);
create index potrero_archivo_eventos_organizacion_id_idx on agx.potrero_archivo_eventos (organizacion_id);

alter table agx.potrero_archivo_eventos owner to agx_owner;
alter table agx.potrero_archivo_eventos enable row level security;
alter table agx.potrero_archivo_eventos force row level security;

create policy potrero_archivo_eventos_tenant_isolation on agx.potrero_archivo_eventos
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

grant select, insert on agx.potrero_archivo_eventos to agx_app;
grant usage, select on sequence agx.potrero_archivo_eventos_evento_id_seq to agx_app;

grant all privileges on agx.potrero_archivo_eventos to agx_owner;
grant usage, select on sequence agx.potrero_archivo_eventos_evento_id_seq to agx_owner;
