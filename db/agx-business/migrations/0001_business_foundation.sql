-- SPRINT-3B1-BUSINESS-DB-FOUNDATION
--
-- Base de una nueva Postgres-AGX-Business (NO el Postgres legacy de
-- producción, que queda intacto -- ver db/agx-business/README.md). Primera
-- vertical: MIS PREDIOS. NO incluye potreros/animales/pesajes/
-- vacunaciones/tratamientos/reproduccion/finanzas/carbono/biodiversidad/QR
-- -- esas 30+ tablas existen en Postgres-3myV (staging) con el mismo
-- patrón organizacion_id+RLS, pero se migran en un lote posterior cuando
-- cada vertical se autorice, no todas de golpe.
--
-- IMPORTANTE -- organizacion_id NO tiene FK física: agx.organizaciones
-- vive en Postgres-AGX (el plano de identidad), una instancia Postgres
-- FÍSICAMENTE DISTINTA de esta -- Postgres no soporta FOREIGN KEY entre
-- bases de datos distintas. La integridad de organizacion_id se garantiza
-- en dos capas, no en el esquema: (1) la aplicación SIEMPRE toma
-- organizacion_id de session.organizacionId ya resuelto y autorizado por
-- Postgres-AGX (nunca del body del cliente -- contrato en
-- server/security/ganaderiaSession.js/resolveTenantAuthorization), y (2)
-- RLS impide que cualquier fila exista fuera del contexto de
-- app.current_org_id ya fijado por esa misma resolución.
--
-- Requiere 0000_bootstrap_roles.sql ya ejecutado (roles agx_owner/agx_app).
-- Aditiva pura: sin DROP, sin ALTER destructivo. Nunca ejecutar contra
-- Railway/producción sin autorización explícita separada -- este archivo
-- es el artefacto versionado, la ejecución real es un paso posterior y
-- distinto (igual que db/agx/migrations/README.md).

create schema if not exists agx;

-- PostGIS: SÍ, decisión explícita de este sprint (ver informe, sección E).
-- El predio es una entidad espacial operativa -- potreros-dentro-de-predio,
-- containment, intersecciones, análisis por hectárea son necesidades ya
-- previstas, no hipotéticas. GeoJSON sigue siendo el formato de
-- API/frontend (ST_AsGeoJSON en tiempo de lectura); geometry(...,4326) es
-- la representación canónica en DB, nunca al revés.
create extension if not exists postgis;

grant usage on schema agx to agx_owner;
grant usage, create on schema agx to agx_owner;
grant usage on schema agx to agx_app;

-- ---------------------------------------------------------------------
-- agx.predios -- DATO OPERATIVO DEL CLIENTE (nunca sobrescrito
-- silenciosamente por una consulta catastral -- ver comentario de
-- agx.predio_snapshots_catastrales más abajo).
-- ---------------------------------------------------------------------
create table agx.predios (
  predio_id bigserial primary key,
  organizacion_id uuid not null,

  nombre_predio varchar(200) not null,
  propietario varchar(200),
  departamento varchar(120),
  municipio varchar(120),
  vereda varchar(120),
  area_total_ha numeric,

  -- Punto de referencia declarado por el cliente (no es un polígono
  -- catastral) -- mismo criterio que el Postgres legacy/staging, campos
  -- numéricos simples, no geography.
  latitud numeric,
  longitud numeric,

  -- Código catastral "vigente" -- copiado EXPLÍCITAMENTE por el cliente
  -- desde un snapshot confirmado (ver §7 del sprint), nunca escrito por
  -- una consulta automática sin confirmación humana. Ver H (duplicados)
  -- para el porqué de que viva aquí y no solo en el snapshot.
  codigo_predial varchar(30),

  -- Límite espacial ACTUALMENTE VIGENTE para operaciones (potreros dentro
  -- del predio, cálculos de área, etc.) -- se puebla copiando
  -- explícitamente la geometría de un snapshot confirmado, o queda NULL
  -- para un predio manual sin geometría (MVP, ver informe sección M).
  geometry geometry(MultiPolygon, 4326),

  fecha_creacion timestamptz not null default now(),
  fecha_actualizacion timestamptz not null default now()
);

comment on column agx.predios.organizacion_id is
  'Sin FK física -- agx.organizaciones vive en Postgres-AGX (otra base). Integridad garantizada por sesión+RLS, ver cabecera del archivo.';
comment on column agx.predios.codigo_predial is
  'Denormalizado desde el snapshot catastral confirmado más reciente. Nunca escrito automáticamente por una simple consulta -- requiere confirmación explícita del cliente.';

-- Evita que la MISMA organización registre el mismo código predial dos
-- veces. NO impone unicidad global entre organizaciones (dos
-- organizaciones distintas legítimamente pueden tener el mismo código --
-- copropiedad, arrendamiento, disputa de linderos -- eso requiere revisión
-- humana, no un constraint de DB). Predios manuales sin código quedan
-- fuera de esta restricción. SPRINT-3B1.1: decisión mantenida sin cambios.
create unique index predios_org_codigo_predial_key
  on agx.predios (organizacion_id, codigo_predial)
  where codigo_predial is not null;

-- SPRINT-3B1.1 (hardening #1): destino de la FK compuesta de
-- predio_snapshots_catastrales más abajo. predio_id ya es PK por sí solo
-- (único global), así que esta UNIQUE compuesta no añade una segunda
-- fuente de unicidad -- existe únicamente para que Postgres pueda anclar
-- una FOREIGN KEY de dos columnas contra ella (una FK compuesta debe
-- apuntar a un UNIQUE/PK que cubra exactamente esas mismas columnas).
alter table agx.predios add constraint predios_id_organizacion_unique unique (predio_id, organizacion_id);

create index predios_organizacion_id_idx on agx.predios (organizacion_id);
create index predios_geometry_gix on agx.predios using gist (geometry);

-- ---------------------------------------------------------------------
-- agx.predio_snapshots_catastrales -- DATO DE CATASTROX / FUENTE OFICIAL,
-- inmutable tras insertarse. Relación predio 1:N snapshots -- cada
-- reconsulta futura crea un snapshot NUEVO, nunca sobrescribe uno
-- existente ni el registro operativo de agx.predios.
-- ---------------------------------------------------------------------
create table agx.predio_snapshots_catastrales (
  snapshot_id uuid primary key default gen_random_uuid(),
  predio_id bigint not null,
  -- Denormalizado a propósito (mismo patrón ya usado en las 35 tablas de
  -- staging): permite que la política RLS de esta tabla sea autocontenida
  -- (compara su propia columna, sin JOIN a predios en cada evaluación de
  -- política), y es defensa en profundidad si algún día predio_id se
  -- consulta sin pasar por el filtro de predios primero.
  --
  -- SPRINT-3B1.1 (hardening #1): esta columna YA NO es solo defensa en
  -- profundidad -- participa en la FK compuesta de abajo, que es la
  -- garantía real (a nivel de integridad referencial, no solo RLS) de que
  -- un snapshot nunca puede declarar una organizacion_id distinta de la
  -- del predio al que dice pertenecer, ni siquiera enumerando predio_id a
  -- ciegas.
  organizacion_id uuid not null,

  codigo_predial varchar(30),
  codigo_anterior varchar(20),
  nombre_predio_catastral varchar(200),

  departamento varchar(120),
  municipio varchar(120),
  vereda varchar(120),
  sector varchar(60),

  area_m2 numeric,
  area_ha numeric,

  geometry geometry(MultiPolygon, 4326),

  fuente varchar(60) not null,
  version_fuente varchar(60),
  fecha_consulta timestamptz not null,

  atributos_json jsonb,

  fecha_creacion timestamptz not null default now()
);

-- SPRINT-3B1.1 (hardening #1): FK COMPUESTA, no simple. Reemplaza la FK
-- original de una sola columna (predio_id -> predios.predio_id). Con esta
-- FK, Postgres exige que (predio_id, organizacion_id) del snapshot
-- coincida EXACTAMENTE con una fila real de predios -- es decir, exige que
-- el predio referenciado pertenezca a esa misma organización. Un intento
-- de crear snapshot.organizacion_id=B con snapshot.predio_id=<predio de A>
-- ahora es RECHAZADO por integridad referencial (23503), no solo filtrado
-- por RLS -- el INSERT ni siquiera llega a evaluarse contra la política.
alter table agx.predio_snapshots_catastrales
  add constraint predio_snapshots_predio_organizacion_fkey
  foreign key (predio_id, organizacion_id)
  references agx.predios (predio_id, organizacion_id);

comment on table agx.predio_snapshots_catastrales is
  'Inmutable/append-only para agx_app (ver grants) -- una nueva consulta catastral SIEMPRE inserta un snapshot nuevo, nunca actualiza uno existente. La FK compuesta (predio_id, organizacion_id) garantiza que un snapshot no puede pertenecer a una organizacion_id distinta de la del predio referenciado.';

-- Deliberadamente SIN unique constraint sobre codigo_predial: los
-- snapshots son históricos por diseño -- el mismo codigo_predial se repite
-- legítimamente en cada reconsulta del mismo predio. La unicidad de
-- "no duplicar el predio" vive en agx.predios (predios_org_codigo_predial_key),
-- no aquí. Ver informe, sección H.
create index snapshots_predio_id_idx on agx.predio_snapshots_catastrales (predio_id);
create index snapshots_organizacion_id_idx on agx.predio_snapshots_catastrales (organizacion_id);
create index snapshots_org_codigo_predial_idx on agx.predio_snapshots_catastrales (organizacion_id, codigo_predial);
create index snapshots_geometry_gix on agx.predio_snapshots_catastrales using gist (geometry);

alter table agx.predios owner to agx_owner;
alter table agx.predio_snapshots_catastrales owner to agx_owner;

-- ---------------------------------------------------------------------
-- RLS -- mismo principio ya probado en Postgres-3myV (staging), verificado
-- por auditoría read-only de este sprint.
-- ---------------------------------------------------------------------
alter table agx.predios enable row level security;
alter table agx.predio_snapshots_catastrales enable row level security;

-- FORCE ROW LEVEL SECURITY: agx_app NO es el dueño de estas tablas
-- (agx_owner lo es), así que RLS ya se le aplica sin necesidad de FORCE
-- (FORCE solo cambia el comportamiento para el dueño/superusuario). Se
-- habilita de todas formas como defensa en profundidad barata: si algún
-- día alguien reasigna el owner a agx_app por error, o le concede
-- BYPASSRLS, esta línea sigue exigiendo el filtro. Costo cero en el caso
-- normal.
alter table agx.predios force row level security;
alter table agx.predio_snapshots_catastrales force row level security;

create policy predios_tenant_isolation on agx.predios
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

create policy predio_snapshots_catastrales_tenant_isolation on agx.predio_snapshots_catastrales
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- Grants -- mínimo privilegio real para agx_app: sin TRUNCATE, sin
-- REFERENCES, sin TRIGGER, sin DDL. agx_owner conserva control total.
--
-- SPRINT-3B1.1 (hardening #3): agx.predios es la entidad OPERATIVA
-- (mutable) -- agx_app conserva UPDATE/DELETE. agx.predio_snapshots_catastrales
-- es APPEND-ONLY para la aplicación -- agx_app recibe únicamente SELECT e
-- INSERT. Un intento de UPDATE/DELETE sobre un snapshot desde agx_app
-- debe fallar por GRANT (42501 insufficient_privilege), no solo por RLS --
-- verificado en la práctica (ver informe, tests de inmutabilidad).
-- ---------------------------------------------------------------------
grant select, insert, update, delete on agx.predios to agx_app;
grant select, insert on agx.predio_snapshots_catastrales to agx_app;
grant usage, select on sequence agx.predios_predio_id_seq to agx_app;

grant all privileges on agx.predios to agx_owner;
grant all privileges on agx.predio_snapshots_catastrales to agx_owner;
grant usage, select on sequence agx.predios_predio_id_seq to agx_owner;
