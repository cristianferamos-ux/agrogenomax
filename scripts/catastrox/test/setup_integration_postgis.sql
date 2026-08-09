-- CATX-INTEGRATION-TEST-001: fixture PostGIS sintético mínimo, exclusivo de
-- integración local, para poder ejecutar las suites que hoy se auto-omiten
-- sin Postgres real:
--   server/routes/__tests__/catastroxPaymentOrders.test.js
--   server/routes/__tests__/catastroxPaymentWebhook.test.js
--   server/routes/__tests__/catastroxDeliveryLifecycle.test.js
--   server/routes/__tests__/catastroxCustomerOtpAndHistory.test.js
--
-- Ejecutar EXCLUSIVAMENTE contra una base local/efímera destinada a
-- CATASTROX_DATABASE_URL (p. ej. catastrox_postgis_test) -- NUNCA contra
-- staging ni producción. Ver scripts/catastrox/test/README.md.
--
-- No contiene ni deriva de ningún dato real de producción: ni la geometría
-- ni el código predial provienen de un predio existente. codigo_predial es
-- un valor SINTÉTICO de 30 dígitos ('999999999999999999999999999901'),
-- verificado contra validateCadastralCodeInput/normalizeCadastralCodeInput/
-- resolveCanonicalPredioId (server/routes/catastrox.js): ninguna de esas
-- funciones exige checksum ni validación territorial, solo 20 o 30 dígitos
-- numéricos -- este código las satisface sin necesidad de simular un
-- predio real.
--
-- Columnas limitadas exactamente a las que lee buildDeliveryPredioSql()/
-- consume resolvePredioDataForDelivery()/resolveCanonicalAreaForRow()
-- (server/routes/catastrox.js, server/services/catastrox/catastroxCanonicalArea.js)
-- -- ninguna columna adicional.
--
-- SRID: la geometría se almacena SIN SRID registrado (0) a propósito. El
-- único ST_Transform que usa resolvePredioDataForDelivery pasa el PROJ4
-- literal de CATASTROX_ORIGEN_NACIONAL_PROJ como origen explícito
-- (ST_Transform(geom, proj4_text, 4326)), así que nunca consulta
-- spatial_ref_sys para el SRID de origen -- solo el destino (4326, WGS84,
-- siempre presente por defecto) importa. Esto evita cualquier dependencia
-- de que EPSG:9377 esté registrado localmente (no lo está ni en la
-- instancia de desarrollo real del equipo, ver
-- docs/catastrox/CATASTROX_CLEAN_IMPORT_CAQUETA.md).
--
-- Idempotente: puede ejecutarse repetidamente sin error (CREATE EXTENSION/
-- SCHEMA/TABLE IF NOT EXISTS, CREATE OR REPLACE VIEW, INSERT ... ON
-- CONFLICT DO UPDATE).

create extension if not exists postgis;

create schema if not exists catastrox_clean;

create table if not exists catastrox_clean.predios (
  codigo_predial              text primary key,
  codigo_anterior              text,
  departamento_nombre          text,
  municipio_nombre              text,
  zona                            text,
  nombre_predio                    text,
  direccion_real                    text,
  vereda_nombre                      text,
  barrio_nombre                       text,
  sector_codigo                        text,
  manzana_codigo                        text,
  area_terreno_m2                        double precision,
  area_terreno_ha                         double precision,
  destino_economico_nombre                 text,
  uso_1_nombre                              text,
  uso_2_nombre                               text,
  uso_3_nombre                                text,
  numero_construcciones                        integer,
  area_construida_m2                            double precision,
  tipos_construccion_resumen                     text,
  fuente                                          text,
  fecha_proceso                                    text,
  geom                                              geometry(Polygon, 0)
);

create or replace view catastrox_clean.v_predios_enriquecidos as
select
  codigo_predial, codigo_anterior, departamento_nombre, municipio_nombre, zona,
  nombre_predio, direccion_real, vereda_nombre, barrio_nombre, sector_codigo,
  manzana_codigo, area_terreno_m2, area_terreno_ha, destino_economico_nombre,
  uso_1_nombre, uso_2_nombre, uso_3_nombre, numero_construcciones,
  area_construida_m2, tipos_construccion_resumen, fuente, fecha_proceso, geom
from catastrox_clean.predios;

-- Fila sintética única: predio de integración (municipio MILAN, departamento
-- CAQUETA, zona RURAL, destino AGROPECUARIO -- valores ya usados como
-- fixture no-DB en server/services/catastrox/pdf/__tests__/catastroxPdfGenerator.test.js
-- buildSamplePredioData, reutilizados aquí para consistencia, no copiados de
-- ningún registro real).
--
-- Geometría: rectángulo puramente sintético, 2000 m x 2185.75 m, área
-- EXACTA 4,371,500 m2 (437.15 ha) -- construido a partir del punto de
-- origen falso (x_0=5000000, y_0=2000000) ya declarado como constante
-- pública en el propio código de la app (CATASTROX_ORIGEN_NACIONAL_PROJ,
-- server/routes/catastrox.js), no de coordenadas de ningún predio real.
insert into catastrox_clean.predios (
  codigo_predial, codigo_anterior, departamento_nombre, municipio_nombre, zona,
  nombre_predio, direccion_real, vereda_nombre, barrio_nombre, sector_codigo,
  manzana_codigo, area_terreno_m2, area_terreno_ha, destino_economico_nombre,
  uso_1_nombre, uso_2_nombre, uso_3_nombre, numero_construcciones,
  area_construida_m2, tipos_construccion_resumen, fuente, fecha_proceso, geom
) values (
  '999999999999999999999999999901', null, 'CAQUETA', 'MILAN', 'RURAL',
  'Predio de prueba', 'Vereda de prueba', 'Vereda de prueba', null, null,
  null, 4371500, 437.15, 'AGROPECUARIO',
  null, null, null, null,
  null, null, 'sintetico-integracion-local', null,
  ST_GeomFromText(
    'POLYGON((5000000 2000000, 5002000 2000000, 5002000 2002185.75, 5000000 2002185.75, 5000000 2000000))',
    0
  )
)
on conflict (codigo_predial) do update set
  codigo_anterior = excluded.codigo_anterior,
  departamento_nombre = excluded.departamento_nombre,
  municipio_nombre = excluded.municipio_nombre,
  zona = excluded.zona,
  nombre_predio = excluded.nombre_predio,
  direccion_real = excluded.direccion_real,
  vereda_nombre = excluded.vereda_nombre,
  barrio_nombre = excluded.barrio_nombre,
  sector_codigo = excluded.sector_codigo,
  manzana_codigo = excluded.manzana_codigo,
  area_terreno_m2 = excluded.area_terreno_m2,
  area_terreno_ha = excluded.area_terreno_ha,
  destino_economico_nombre = excluded.destino_economico_nombre,
  uso_1_nombre = excluded.uso_1_nombre,
  uso_2_nombre = excluded.uso_2_nombre,
  uso_3_nombre = excluded.uso_3_nombre,
  numero_construcciones = excluded.numero_construcciones,
  area_construida_m2 = excluded.area_construida_m2,
  tipos_construccion_resumen = excluded.tipos_construccion_resumen,
  fuente = excluded.fuente,
  fecha_proceso = excluded.fecha_proceso,
  geom = excluded.geom;
