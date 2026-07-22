begin;

do $$
declare
  required_columns text[] := array[
    'codigo_predial',
    'codigo_anterior',
    'departamento_nombre',
    'municipio_dane',
    'municipio_nombre',
    'zona',
    'nombre_predio',
    'direccion_real',
    'vereda_nombre',
    'barrio_nombre',
    'sector_codigo',
    'manzana_codigo',
    'area_terreno_m2',
    'area_terreno_ha',
    'destino_economico_nombre',
    'uso_1_nombre',
    'uso_2_nombre',
    'uso_3_nombre',
    'numero_construcciones',
    'area_construida_m2',
    'tipos_construccion_resumen',
    'fuente',
    'fecha_proceso',
    'geom'
  ];
  required_column text;
begin
  if to_regclass('catastrox_clean.predios') is null then
    raise exception 'Falta la tabla requerida catastrox_clean.predios para crear la vista.';
  end if;

  foreach required_column in array required_columns
  loop
    if not exists (
      select 1
      from information_schema.columns
      where table_schema = 'catastrox_clean'
        and table_name = 'predios'
        and column_name = required_column
    ) then
      raise exception 'Falta la columna requerida catastrox_clean.predios.% para crear la vista.', required_column;
    end if;
  end loop;
end $$;

create or replace view catastrox_clean.v_predios_enriquecidos as
select
  codigo_predial,
  codigo_anterior,
  departamento_nombre,
  municipio_dane,
  municipio_nombre,
  zona,
  nombre_predio,
  direccion_real,
  vereda_nombre,
  barrio_nombre,
  sector_codigo,
  manzana_codigo,
  area_terreno_m2,
  area_terreno_ha,
  destino_economico_nombre,
  uso_1_nombre,
  uso_2_nombre,
  uso_3_nombre,
  numero_construcciones,
  area_construida_m2,
  tipos_construccion_resumen,
  fuente,
  fecha_proceso,
  geom
from catastrox_clean.predios;

commit;
