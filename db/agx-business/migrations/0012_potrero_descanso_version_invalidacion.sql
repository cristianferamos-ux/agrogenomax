-- SPRINT-3D9.2 -- VERSIONADO DE DESCANSO POST-REAL + INVALIDACIÓN
--
-- El índice único original (0009) `potrero_recomendaciones_descanso_un_
-- ciclo_idx on (ciclo_pastoreo_id)` garantizaba "como máximo un descanso
-- por ciclo, para siempre" -- correcto para la idempotencia de FASE B en
-- 3D9.1, pero INCOMPATIBLE con la corrección histórica de 3D9.2: una
-- corrección de fecha_ingreso_real/fecha_salida_real debe poder invalidar
-- el descanso derivado y generar uno nuevo para el MISMO ciclo,
-- preservando ambos históricamente (nunca DELETE).
--
-- Se reemplaza por `version integer` + unique(ciclo_pastoreo_id, version)
-- -- la generación original de FASE B sigue produciendo siempre version=1
-- (comportamiento sin cambios para el caso normal); solo una corrección
-- posterior invalida la versión vigente y crea version+1, bajo el mismo
-- lock de fila del ciclo que ya usa toda la escritura de este dominio.
--
-- Aditiva salvo el reemplazo del índice único. Requiere 0000-0011 ya
-- aplicados. Backfill seguro: todas las filas existentes reciben
-- version=1 vía el DEFAULT, sin ambigüedad (nunca existió más de un
-- descanso por ciclo bajo el índice anterior).

alter table agx.potrero_recomendaciones_descanso add column if not exists version integer not null default 1;

alter table agx.potrero_recomendaciones_descanso
  add constraint potrero_descansos_version_check check (version >= 1);

comment on column agx.potrero_recomendaciones_descanso.version is
  'SPRINT-3D9.2: versión del descanso post-real DENTRO de un mismo ciclo_pastoreo_id -- version=1 en la generación automática al finalizar; version=2, 3... únicamente cuando una corrección de fecha invalida la anterior y recalcula. NULL/no aplica para descansos PLANIFICADOS (ciclo_pastoreo_id is null) -- ahí siempre vale 1 por default, sin significado especial (nunca hay más de un plan "vigente" por ciclo porque no hay ciclo).';

drop index agx.potrero_recomendaciones_descanso_un_ciclo_idx;

-- Reemplaza la garantía "un descanso por ciclo, para siempre" por "un
-- descanso por (ciclo, versión)" -- permite exactamente una fila por cada
-- generación/corrección, nunca dos concurrentes para la MISMA versión
-- (mismo mecanismo de idempotencia de FASE B: perdedor de una carrera por
-- 23505 relee la fila ganadora).
create unique index potrero_recomendaciones_descanso_un_ciclo_version_idx
  on agx.potrero_recomendaciones_descanso (ciclo_pastoreo_id, version)
  where ciclo_pastoreo_id is not null;

-- Anchor de 4 columnas (SPRINT-3D9.2 DESIGN REVISION, punto 4) -- cierra
-- el gap dejado abierto en la ronda anterior: descanso_id ya es único
-- globalmente (PK), así que esta UNIQUE es trivialmente segura contra
-- cualquier fila existente (no puede fallar el ALTER). Con este anchor,
-- agx.potrero_descanso_invalidaciones puede verificar en UNA sola FK, a
-- nivel de integridad referencial (no solo de aplicación), que
-- descanso_id + ciclo_pastoreo_id + potrero_id + organizacion_id
-- corresponden realmente a la MISMA fila.
alter table agx.potrero_recomendaciones_descanso
  add constraint potrero_descansos_id_ciclo_potrero_organizacion_unique
  unique (descanso_id, ciclo_pastoreo_id, potrero_id, organizacion_id);

-- =======================================================================
-- agx.potrero_descanso_invalidaciones -- log append-only puro. Un
-- descanso invalidado NUNCA se borra ni se actualiza -- esta tabla es la
-- ÚNICA fuente de "¿sigue vigente esta versión?" (ver consulta de
-- vigencia en potreroCicloPastoreoRepository.js/potreroDescansoRepository.js).
-- =======================================================================
create table agx.potrero_descanso_invalidaciones (
  invalidacion_id bigserial primary key,
  organizacion_id uuid not null,
  potrero_id bigint not null,
  descanso_id bigint not null,
  ciclo_pastoreo_id bigint not null,

  motivo text not null,
  actor_cuenta_id uuid,
  ocurrido_en timestamptz not null default now(),

  constraint potrero_descanso_invalidaciones_motivo_check
    check (btrim(motivo) <> '')
);

comment on table agx.potrero_descanso_invalidaciones is
  'SPRINT-3D9.2: invalidación append-only de una versión de descanso post-real -- nunca DELETE/UPDATE de la fila original. Se inserta cuando: (a) se corrige fecha_ingreso_real/fecha_salida_real de un ciclo que ya tenía descanso vigente (invalida la versión afectada dentro de la MISMA transacción de corrección, antes de intentar recalcular), o (b) se anula un ciclo FINALIZADO que tenía descanso vigente (invalida dentro de la MISMA transacción de anulación). SELECT/INSERT únicamente -- NUNCA UPDATE/DELETE.';

-- FK de 4 columnas contra el anchor de arriba -- garantía real de
-- integridad referencial, no solo de disciplina de aplicación: un
-- intento de invalidar con una combinación inventada de
-- (descanso_id, ciclo_pastoreo_id, potrero_id, organizacion_id) que no
-- corresponda a una fila real es rechazado con 23503.
alter table agx.potrero_descanso_invalidaciones
  add constraint potrero_descanso_invalidaciones_descanso_ciclo_fkey
  foreign key (descanso_id, ciclo_pastoreo_id, potrero_id, organizacion_id)
  references agx.potrero_recomendaciones_descanso (descanso_id, ciclo_pastoreo_id, potrero_id, organizacion_id);

-- Como máximo UNA invalidación por versión de descanso -- una versión ya
-- invalidada nunca se invalida dos veces.
create unique index potrero_descanso_invalidaciones_un_descanso_idx
  on agx.potrero_descanso_invalidaciones (descanso_id);

create index potrero_descanso_invalidaciones_organizacion_id_idx on agx.potrero_descanso_invalidaciones (organizacion_id);
create index potrero_descanso_invalidaciones_ciclo_id_idx on agx.potrero_descanso_invalidaciones (ciclo_pastoreo_id);

alter table agx.potrero_descanso_invalidaciones owner to agx_owner;
alter table agx.potrero_descanso_invalidaciones enable row level security;
alter table agx.potrero_descanso_invalidaciones force row level security;

create policy potrero_descanso_invalidaciones_tenant_isolation on agx.potrero_descanso_invalidaciones
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

grant select, insert on agx.potrero_descanso_invalidaciones to agx_app;
grant usage, select on sequence agx.potrero_descanso_invalidaciones_invalidacion_id_seq to agx_app;

grant all privileges on agx.potrero_descanso_invalidaciones to agx_owner;
grant usage, select on sequence agx.potrero_descanso_invalidaciones_invalidacion_id_seq to agx_owner;
