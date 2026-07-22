param(
  [Parameter(Mandatory = $true)]
  [string]$GpkgPath,

  [string]$Ogr2OgrPath,

  [string]$ProjLib,

  [switch]$Overwrite
)

$ErrorActionPreference = "Stop"

if (-not $env:CATASTROX_DATABASE_URL) {
  throw "CATASTROX_DATABASE_URL no esta configurada."
}

if (-not (Test-Path -LiteralPath $GpkgPath)) {
  throw "No existe el GPKG indicado: $GpkgPath"
}

if (-not $Ogr2OgrPath) {
  $ogrCommand = Get-Command ogr2ogr -ErrorAction SilentlyContinue
  if ($ogrCommand) {
    $Ogr2OgrPath = $ogrCommand.Source
  } else {
    $programRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
    $fallbackOgrPaths = @(
      foreach ($programRoot in $programRoots) {
        Join-Path $programRoot "QGIS 3.44.10\bin\ogr2ogr.exe"
        Join-Path $programRoot "QGIS 3.42.0\bin\ogr2ogr.exe"
        Join-Path $programRoot "QGIS 3.40.0\bin\ogr2ogr.exe"
        Join-Path $programRoot "GDAL\ogr2ogr.exe"
      }
    )
    $Ogr2OgrPath = $fallbackOgrPaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  }
}

if (-not $Ogr2OgrPath -or -not (Test-Path -LiteralPath $Ogr2OgrPath)) {
  throw "No se encontro ogr2ogr. Instala GDAL/QGIS o indica -Ogr2OgrPath."
}

if (-not $ProjLib) {
  $candidateProjLib = Join-Path (Split-Path (Split-Path $Ogr2OgrPath -Parent) -Parent) "share\proj"
  if (Test-Path -LiteralPath $candidateProjLib) {
    $ProjLib = $candidateProjLib
  }
}

if ($ProjLib -and (Test-Path -LiteralPath $ProjLib)) {
  $env:PROJ_LIB = $ProjLib
}

$layers = @(
  @{ Source = "catastrox_predios"; Target = "catastrox_clean.predios" },
  @{ Source = "catastrox_construcciones"; Target = "catastrox_clean.construcciones" },
  @{ Source = "catastrox_nomenclatura"; Target = "catastrox_clean.nomenclatura" },
  @{ Source = "catastrox_territorio"; Target = "catastrox_clean.territorio" }
)

$targetTables = $layers | ForEach-Object { $_.Target }
$targetListSql = ($targetTables | ForEach-Object { "'$_'" }) -join ", "
$existingTablesSql = "select string_agg(name, ', ' order by name) from (select unnest(array[$targetListSql]) as name) t where to_regclass(name) is not null;"
$existingTables = psql $env:CATASTROX_DATABASE_URL -v ON_ERROR_STOP=1 -qAt -c $existingTablesSql

if ($existingTables) {
  if (-not $Overwrite) {
    throw "Abortado: ya existen tablas destino en catastrox_clean: $existingTables. Usa -Overwrite para eliminarlas antes de importar."
  }

  Write-Host "Overwrite habilitado. Eliminando solo tablas destino en catastrox_clean: $existingTables"
  $dropSql = "drop table if exists catastrox_clean.predios, catastrox_clean.construcciones, catastrox_clean.nomenclatura, catastrox_clean.territorio cascade;"
  psql $env:CATASTROX_DATABASE_URL -v ON_ERROR_STOP=1 -q -c $dropSql
}

psql $env:CATASTROX_DATABASE_URL -v ON_ERROR_STOP=1 -q -c "create schema if not exists catastrox_clean;"

# La importacion se ejecuta por capas; si una capa falla despues de otra exitosa,
# el proceso no es atomico y debe repetirse con -Overwrite tras revisar el error.
foreach ($layer in $layers) {
  Write-Host "Importando $($layer.Source) -> $($layer.Target)"
  # -a_srs asigna SRID a la capa importada; no transforma coordenadas.
  & $Ogr2OgrPath `
    -f PostgreSQL `
    "PG:$env:CATASTROX_DATABASE_URL" `
    $GpkgPath `
    $layer.Source `
    -nln $layer.Target `
    -nlt PROMOTE_TO_MULTI `
    -a_srs EPSG:9377 `
    -lco GEOMETRY_NAME=geom

  if ($LASTEXITCODE -ne 0) {
    throw "ogr2ogr fallo importando $($layer.Source)"
  }
}

Write-Host "Importacion completada en catastrox_clean."
