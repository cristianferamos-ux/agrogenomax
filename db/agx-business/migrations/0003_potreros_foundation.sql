-- SPRINT-3D2-POTREROS-BUSINESS-FOUNDATION
--
-- Fundación tenant-safe de POTREROS en Postgres-AGX-Business. Aditiva pura
-- sobre 0001/0002 -- NO los modifica, NO toca agx.predios ni
-- agx.predio_snapshots_catastrales. Este sprint crea únicamente tabla,
-- constraints, índices, RLS y grants -- NO API, NO UI, NO GPS/KML/KMZ, NO
-- candidate store (ver informe SPRINT-3D2, fuera de alcance explícito).
--
-- REGLA DE DOMINIO: cada potrero pertenece EXCLUSIVAMENTE a un predio de la
-- MISMA organización (ORGANIZACIÓN -> PREDIO -> POTREROS). No existe un
-- potrero "global" ni compartido entre predios. La FK compuesta
-- (predio_id, organizacion_id) hacia agx.predios (mismo patrón que
-- agx.predio_snapshots_catastrales en 0001, hardening SPRINT-3B1.1) es la
-- garantía real de esto a nivel de integridad referencial, no solo RLS: un
-- intento de registrar organizacion_id=B con predio_id de la organización A
-- es rechazado por 23503, ni siquiera llega a evaluarse contra la política.
--
-- Requiere 0000_bootstrap_roles.sql y 0001_business_foundation.sql ya
-- aplicados (agx.predios debe existir). Aditiva pura: sin DROP, sin ALTER
-- destructivo sobre objetos existentes. Nunca ejecutar contra
-- Railway/producción sin autorización explícita separada -- este archivo es
-- el artefacto versionado, la ejecución real es un paso posterior y
-- distinto (igual que 0001/0002).

create table agx.potreros (
  potrero_id bigserial primary key,
  organizacion_id uuid not null,
  predio_id bigint not null,

  nombre varchar(120) not null,
  capacidad_animales integer,
  observaciones text,

  -- Polygon, NUNCA MultiPolygon -- un potrero representa una unidad
  -- continua de manejo. Si existen dos polígonos desconectados, deben
  -- registrarse como dos potreros distintos -- nunca ST_Union automático.
  geometry geometry(Polygon, 4326) not null,

  -- DERIVADO de geometry -- nunca un dato libre ingresado por el usuario.
  -- Persistido para consulta eficiente; la futura capa API/transaccional
  -- (sprint posterior, no este) debe mantenerlo consistente en cada
  -- insert/update con la fórmula aprobada ST_Area(geometry::geography) / 10000.
  area_ha numeric not null,

  metodo_delimitacion varchar(20) not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint potreros_metodo_delimitacion_check
    check (metodo_delimitacion in ('coordenadas', 'gps_movil', 'kml', 'kmz')),
  constraint potreros_area_ha_check check (area_ha > 0),
  constraint potreros_capacidad_animales_check
    check (capacidad_animales is null or capacidad_animales >= 0)
);

comment on table agx.potreros is
  'Cada potrero pertenece EXCLUSIVAMENTE a un predio de la MISMA organización (ORGANIZACIÓN -> PREDIO -> POTREROS) -- ver FK compuesta potreros_predio_organizacion_fkey. No existe potrero global ni compartido entre predios. Una futura vista global de potreros deberá agrupar siempre por predio.';
comment on column agx.potreros.organizacion_id is
  'Sin FK física -- agx.organizaciones vive en Postgres-AGX (otra base). Integridad garantizada por sesión+RLS, mismo criterio que agx.predios.organizacion_id (ver 0001).';
comment on column agx.potreros.geometry is
  'Polygon, NUNCA MultiPolygon. Regla espacial futura (NO implementada como constraint/FK SQL en este sprint -- requiere consultar la fila padre, es responsabilidad de la capa transaccional/API del siguiente sprint): ST_CoveredBy(potrero.geometry, predio.geometry). Se permite compartir borde -- NO buffer, NO snap, NO clip automático, NO tolerancia oculta. Un predio sin geometry no puede recibir un potrero espacial (error futuro aprobado: PREDIO_WITHOUT_GEOMETRY, validado en la API, no resuelto con trigger en DB).';
comment on column agx.potreros.area_ha is
  'DERIVADO de geometry -- NUNCA un dato libre ingresado por el usuario. Fórmula aprobada: ST_Area(geometry::geography) / 10000, calculada server-side. La capa API/transaccional (sprint posterior a este) debe mantenerlo consistente en cada insert/update.';
comment on column agx.potreros.updated_at is
  'Sin trigger de DB -- gestionado por la aplicación, mismo criterio que agx.predios.fecha_actualizacion (0001). No se introduce infraestructura de trigger global solo para Potreros en este sprint.';

-- FK COMPUESTA (predio_id, organizacion_id) -- mismo patrón que
-- agx.predio_snapshots_catastrales (0001, hardening SPRINT-3B1.1). Ancla
-- contra la UNIQUE compuesta predios_id_organizacion_unique ya existente en
-- agx.predios -- no requiere ningún cambio sobre 0001.
alter table agx.potreros
  add constraint potreros_predio_organizacion_fkey
  foreign key (predio_id, organizacion_id)
  references agx.predios (predio_id, organizacion_id);

-- UNIQUE (potrero_id, organizacion_id) -- ancla para futuros FKs
-- compuestos hacia potreros (mismo patrón que predios_id_organizacion_unique
-- en 0001). No añade una segunda fuente de unicidad -- potrero_id ya es PK
-- por sí solo.
alter table agx.potreros
  add constraint potreros_id_organizacion_unique unique (potrero_id, organizacion_id);

-- Deliberadamente SIN unique (predio_id, nombre) -- dos potreros del mismo
-- predio pueden tener legítimamente el mismo nombre en casos reales.
-- Si se necesita en el futuro, es una decisión separada que requiere
-- reportarse antes de aplicarse (ver informe SPRINT-3D2, sección 9).

create index potreros_organizacion_id_idx on agx.potreros (organizacion_id);
create index potreros_predio_id_idx on agx.potreros (predio_id);
-- Ruta futura prevista: /predios/:predioId/potreros, siempre filtrada
-- también por organización -- índice compuesto para esa consulta
-- subordinada (evita depender solo de los índices simples de arriba).
create index potreros_organizacion_predio_idx on agx.potreros (organizacion_id, predio_id);
create index potreros_geometry_gix on agx.potreros using gist (geometry);

alter table agx.potreros owner to agx_owner;

-- ---------------------------------------------------------------------
-- RLS -- mismo patrón ya aprobado de agx.predios (0001).
-- ---------------------------------------------------------------------
alter table agx.potreros enable row level security;

-- FORCE ROW LEVEL SECURITY: agx_app no es el dueño de esta tabla
-- (agx_owner lo es), así que RLS ya se le aplica sin necesidad de FORCE.
-- Se habilita de todas formas como defensa en profundidad barata, mismo
-- criterio que agx.predios (0001).
alter table agx.potreros force row level security;

create policy potreros_tenant_isolation on agx.potreros
  for all
  using (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organizacion_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- ---------------------------------------------------------------------
-- Grants -- mínimo privilegio real para agx_app: sin TRUNCATE, sin
-- REFERENCES, sin TRIGGER, sin DDL. agx_owner conserva control total.
-- agx.potreros es entidad OPERATIVA (mutable, mismo criterio que
-- agx.predios) -- agx_app recibe SELECT/INSERT/UPDATE/DELETE.
-- ---------------------------------------------------------------------
grant select, insert, update, delete on agx.potreros to agx_app;
grant usage, select on sequence agx.potreros_potrero_id_seq to agx_app;

grant all privileges on agx.potreros to agx_owner;
grant usage, select on sequence agx.potreros_potrero_id_seq to agx_owner;
