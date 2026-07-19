# CatastroX Clean Import Caqueta

## Fuente

- GPKG de entrada: `<RUTA_GPKG_CAQUETA>\catastrox_caqueta.gpkg`
- No copiar el GPKG al repositorio.
- Base destino: definida por `CATASTROX_DATABASE_URL`.
- Schema destino: `catastrox_clean`

## Herramienta usada

El script intenta localizar `ogr2ogr` con `Get-Command` antes de usar rutas fallback comunes de GDAL/QGIS.

Ejemplo parametrizado:

```powershell
$env:CATASTROX_DATABASE_URL = "<DATABASE_URL>"
.\scripts\catastrox\import\import_caqueta_clean_gpkg.ps1 `
  -GpkgPath "<RUTA_GPKG_CAQUETA>\catastrox_caqueta.gpkg" `
  -Ogr2OgrPath "<RUTA_OGR2OGR>\ogr2ogr.exe" `
  -ProjLib "<RUTA_PROJ_LIB>"
```

`Ogr2OgrPath` y `ProjLib` son opcionales si están disponibles en el entorno.

Entorno validado: GDAL incluido con QGIS 3.44.10 en Windows.

## Capas importadas

- `catastrox_predios` -> `catastrox_clean.predios`
- `catastrox_construcciones` -> `catastrox_clean.construcciones`
- `catastrox_nomenclatura` -> `catastrox_clean.nomenclatura`
- `catastrox_territorio` -> `catastrox_clean.territorio`

## Conteos validados

- `predios`: 87155
- `construcciones`: 56863
- `nomenclatura`: 68363
- `territorio`: 4386

## CRS / SRID

- Fuente: EPSG:9377 MAGNA-SIRGAS / Origen-Nacional.
- Las geometrías se mantienen en CRS metrico.
- `ogr2ogr -a_srs EPSG:9377` asigna el SRID declarado a la capa importada; no transforma coordenadas.
- Durante la importacion GDAL registro inicialmente un SRID interno local (`900914`).
- Se corrige en `catastrox_clean` con `ST_SetSRID(geom, 9377)`, sin transformar coordenadas.
- Antes de aplicar `ST_SetSRID`, `020_catastrox_clean_indexes.sql` valida existencia de tablas/geom y un rango espacial compatible con EPSG:9377 para evitar etiquetar coordenadas incorrectas.

## Politica ante tablas existentes

Por seguridad, la importacion aborta si cualquiera de estas tablas ya existe:

- `catastrox_clean.predios`
- `catastrox_clean.construcciones`
- `catastrox_clean.nomenclatura`
- `catastrox_clean.territorio`

Para reemplazarlas debe usarse explicitamente `-Overwrite`. Ese parametro elimina unicamente esas cuatro tablas dentro de `catastrox_clean` antes de importar. No toca otros schemas.

## Orden de ejecucion

1. Configurar `CATASTROX_DATABASE_URL` en la sesion local, sin guardar credenciales en el repositorio.
2. Ejecutar `import_caqueta_clean_gpkg.ps1` con `-GpkgPath`.
3. Ejecutar manualmente `020_catastrox_clean_indexes.sql`.
4. Ejecutar manualmente `030_catastrox_clean_views.sql`.

## Atomicidad

La importacion del GPKG se ejecuta por capas. No es atomica: si una capa falla despues de otra exitosa, revisar el error y repetir con `-Overwrite` solo cuando se decida reemplazar las cuatro tablas destino.

## Problema spatial_ref_sys

La instancia PostGIS local no tiene EPSG:9377 registrado en `spatial_ref_sys`.
Por eso las pruebas espaciales WGS84 -> Origen Nacional se validaron con definicion PROJ explicita.

Ver tambien:

- `docs/catastrox/CATASTROX_EPSG_9377_PENDING.md`

## Indices creados

- GiST sobre `geom` en las 4 tablas.
- Btree sobre campos de busqueda:
  - `codigo_predial`
  - `codigo_anterior`
  - `municipio_dane`
  - `municipio_nombre`
  - `vereda_nombre`
  - `zona`
  - `destino_economico_nombre`

## Vista creada

- `catastrox_clean.v_predios_enriquecidos`

Campos principales:

- codigos prediales
- departamento / municipio
- zona
- nombre y direccion del predio
- vereda / barrio / sector / manzana
- areas
- destino economico
- usos
- construcciones
- fuente / fecha de proceso
- `geom`

## Predios validados

### Cartagena del Chaira

- `codigo_predial`: `181500002000000300047000000000`
- `nombre_predio`: `LAS ILUSIONES N 2`
- `municipio`: `CARTAGENA DEL CHAIRA`
- `zona`: `rural`
- `vereda_nombre`: `26BB`
- `destino_economico_nombre`: `Pecuario`
- `uso_1_nombre`: `VIVIENDA HASTA 3 PISOS`
- `numero_construcciones`: `2`
- `area_construida_m2`: `50`
- `area_terreno_ha`: `402.9074`

### Albania

- `codigo_predial`: `180290001000000270015000000000`
- `nombre_predio`: `LA PRIMAVERA`
- `municipio`: `ALBANIA`
- `zona`: `rural`
- `vereda_nombre`: `Florida Uno`
- `destino_economico_nombre`: `Pecuario`
- `area_terreno_ha`: `9.1589`

## Tablas no tocadas

El flujo limpio no modifica:

- `gis.catastro_caqueta`
- `gis.municipios_colombia`
- schemas `agx` ni `gis`

`public` solo puede ser consultado/usado para extensiones o funciones necesarias de PostGIS, no para almacenar tablas limpias de este lote.
