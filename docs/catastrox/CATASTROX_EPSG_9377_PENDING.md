# CatastroX EPSG 9377 Pending

## Problema

La base local PostGIS no tiene registrado EPSG:9377 en `spatial_ref_sys`.
Las capas limpias de Caqueta vienen en MAGNA-SIRGAS / Origen-Nacional y se importaron manteniendo coordenadas metricas.

## Regla para importacion limpia

- `ogr2ogr -a_srs EPSG:9377` asigna el SRID declarado; no transforma coordenadas.
- `ST_SetSRID(geom, 9377)` tambien asigna etiqueta SRID; no transforma coordenadas.
- No usar `ST_Transform` en el lote de importacion limpia de Caqueta.
- Antes de aplicar `ST_SetSRID`, validar que las coordenadas esten en un rango compatible con EPSG:9377.

## Solucion temporal validada

Para pruebas espaciales desde coordenadas WGS84 se uso `ST_Transform` con definicion PROJ explicita:

```sql
+proj=tmerc +lat_0=4 +lon_0=-73 +k=0.9992 +x_0=5000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs +type=crs
```

Luego se asigno SRID 9377 al punto transformado con `ST_SetSRID`.

## Pendiente antes de produccion

Registrar EPSG:9377 de forma controlada en `spatial_ref_sys`, usando definicion oficial confirmada por GDAL/PROJ o una migracion de infraestructura aprobada.

No se debe inventar ni modificar `public.spatial_ref_sys` sin una migracion revisada.

El flujo de importacion limpia no toca schemas `gis` ni `agx`; `public` queda limitado a extensiones o funciones PostGIS necesarias.
