begin;

set search_path to catastrox_clean, public;

do $$
declare
  required_table text;
  bounds record;
begin
  foreach required_table in array array['predios', 'construcciones', 'nomenclatura', 'territorio']
  loop
    if to_regclass(format('catastrox_clean.%I', required_table)) is null then
      raise exception 'Falta la tabla requerida catastrox_clean.%', required_table;
    end if;

    if not exists (
      select 1
      from information_schema.columns
      where table_schema = 'catastrox_clean'
        and table_name = required_table
        and column_name = 'geom'
    ) then
      raise exception 'Falta la columna geom en catastrox_clean.%', required_table;
    end if;
  end loop;

  select
    min(st_xmin(box2d(geom))) as xmin,
    max(st_xmax(box2d(geom))) as xmax,
    min(st_ymin(box2d(geom))) as ymin,
    max(st_ymax(box2d(geom))) as ymax
  into bounds
  from (
    select geom from catastrox_clean.predios where geom is not null
    union all
    select geom from catastrox_clean.construcciones where geom is not null
    union all
    select geom from catastrox_clean.nomenclatura where geom is not null
    union all
    select geom from catastrox_clean.territorio where geom is not null
  ) g;

  if bounds.xmin is null then
    raise exception 'No hay geometrías para validar antes de asignar SRID 9377.';
  end if;

  if bounds.xmin < 3000000 or bounds.xmax > 7000000 or bounds.ymin < 500000 or bounds.ymax > 3500000 then
    raise exception 'Rango espacial incompatible con EPSG:9377 para Caquetá. Bounds detectados: xmin %, xmax %, ymin %, ymax %',
      bounds.xmin, bounds.xmax, bounds.ymin, bounds.ymax;
  end if;
end $$;

alter table catastrox_clean.predios
  alter column geom type geometry(Geometry, 9377) using st_setsrid(geom, 9377);
alter table catastrox_clean.construcciones
  alter column geom type geometry(Geometry, 9377) using st_setsrid(geom, 9377);
alter table catastrox_clean.nomenclatura
  alter column geom type geometry(Geometry, 9377) using st_setsrid(geom, 9377);
alter table catastrox_clean.territorio
  alter column geom type geometry(Geometry, 9377) using st_setsrid(geom, 9377);

create index if not exists idx_catastrox_clean_predios_geom
  on catastrox_clean.predios using gist (geom);
create index if not exists idx_catastrox_clean_construcciones_geom
  on catastrox_clean.construcciones using gist (geom);
create index if not exists idx_catastrox_clean_nomenclatura_geom
  on catastrox_clean.nomenclatura using gist (geom);
create index if not exists idx_catastrox_clean_territorio_geom
  on catastrox_clean.territorio using gist (geom);

create index if not exists idx_catastrox_clean_predios_codigo_predial
  on catastrox_clean.predios (codigo_predial);
create index if not exists idx_catastrox_clean_predios_codigo_anterior
  on catastrox_clean.predios (codigo_anterior);
create index if not exists idx_catastrox_clean_predios_municipio_dane
  on catastrox_clean.predios (municipio_dane);
create index if not exists idx_catastrox_clean_predios_municipio_nombre
  on catastrox_clean.predios (municipio_nombre);
create index if not exists idx_catastrox_clean_predios_vereda_nombre
  on catastrox_clean.predios (vereda_nombre);
create index if not exists idx_catastrox_clean_predios_zona
  on catastrox_clean.predios (zona);
create index if not exists idx_catastrox_clean_predios_destino
  on catastrox_clean.predios (destino_economico_nombre);

create index if not exists idx_catastrox_clean_construcciones_codigo_predial
  on catastrox_clean.construcciones (codigo_predial);
create index if not exists idx_catastrox_clean_construcciones_codigo_anterior
  on catastrox_clean.construcciones (codigo_anterior);
create index if not exists idx_catastrox_clean_construcciones_municipio_dane
  on catastrox_clean.construcciones (municipio_dane);
create index if not exists idx_catastrox_clean_construcciones_municipio_nombre
  on catastrox_clean.construcciones (municipio_nombre);
create index if not exists idx_catastrox_clean_construcciones_zona
  on catastrox_clean.construcciones (zona);

create index if not exists idx_catastrox_clean_nomenclatura_codigo_predial
  on catastrox_clean.nomenclatura (codigo_predial);
create index if not exists idx_catastrox_clean_nomenclatura_municipio_dane
  on catastrox_clean.nomenclatura (municipio_dane);
create index if not exists idx_catastrox_clean_nomenclatura_municipio_nombre
  on catastrox_clean.nomenclatura (municipio_nombre);
create index if not exists idx_catastrox_clean_nomenclatura_zona
  on catastrox_clean.nomenclatura (zona);

create index if not exists idx_catastrox_clean_territorio_municipio_dane
  on catastrox_clean.territorio (municipio_dane);
create index if not exists idx_catastrox_clean_territorio_municipio_nombre
  on catastrox_clean.territorio (municipio_nombre);
create index if not exists idx_catastrox_clean_territorio_zona
  on catastrox_clean.territorio (zona);

commit;
