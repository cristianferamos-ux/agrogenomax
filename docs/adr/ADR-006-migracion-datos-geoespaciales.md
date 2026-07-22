# ADR-006: La migración completa de CatastroX queda condicionada a un proceso reproducible y documentado para los datos geoespaciales base

- Estado: Aceptada
- Fecha: 2026-07-17
- Responsables: Equipo técnico AgroGenomaX / CRH Soluciones Integrales S.A.S.

## Precedencia y estado vigente

ADR-006 continúa vigente como gate de migración de CatastroX. Desde su aprobación ya existe un workflow limpio versionado para Caquetá:

- `docs/catastrox/CATASTROX_CLEAN_IMPORT_CAQUETA.md`
- `docs/catastrox/CATASTROX_SEMANTIC_CATALOG.md`
- `scripts/catastrox/import/020_catastrox_clean_indexes.sql`
- `scripts/catastrox/import/030_catastrox_clean_views.sql`
- `scripts/catastrox/import/import_caqueta_clean_gpkg.ps1`

Estos artefactos mejoran la reproducibilidad, pero no cierran por sí solos todo ADR-006. Sigue pendiente validar el import completo desde una fuente controlada, registrar conteos/hash/manifest de entrada y salida, resolver formalmente EPSG:9377, ejecutar una prueba reproducible en PostGIS destino y aprobar el gate antes de migrar CatastroX.

ADR-013 gobierna órdenes, entitlements y artifacts. ADR-014 exige datos sintéticos o anonimizados en staging.

## Contexto

La auditoría técnica confirmó originalmente que las tablas `gis.catastro_caqueta` y `gis.municipios_colombia` **no tenían un proceso versionado completo y validado en el repositorio** — fueron creadas mediante un import externo directo (GDAL/ogr2ogr) desde una ruta local de una máquina específica, fuera de control de versiones y no reproducible desde el repositorio. Posteriormente se incorporó un workflow limpio parcial/versionado para Caquetá bajo `docs/catastrox/` y `scripts/catastrox/import/`, lo que mejora la reproducibilidad pero no reemplaza la validación integral exigida por este ADR. Adicionalmente, el sistema de coordenadas EPSG:9377 usado por el módulo catastral **no está registrado en `spatial_ref_sys`** de la instancia PostGIS actual; el equipo lo resolvió con una cadena PROJ hardcodeada en el código de aplicación (`CATASTROX_ORIGEN_NACIONAL_PROJ`, `server/routes/catastrox.js:25-26`), repetida en al menos cinco consultas distintas, y documentado como un problema pendiente en `docs/catastrox/CATASTROX_EPSG_9377_PENDING.md`.

## Problema

No es posible migrar CatastroX a Amazon RDS PostgreSQL con PostGIS con confianza mientras no exista una forma reproducible, documentada, ejecutada y verificable de recrear los datos geoespaciales base. El workflow limpio versionado actual es un avance parcial; migrar "a ciegas" (por ejemplo, solo con `pg_dump`/`restore` de la instancia local actual) resolvería una única vez el problema, pero no dejaría al proyecto en condición de reconstruir ese entorno en el futuro, ni de auditar cómo se generaron esos datos.

## Opciones consideradas

- **Migrar tal cual, vía `pg_dump`/`restore` de la instancia local existente, como única estrategia**: descartada como solución definitiva — funcionaría una sola vez, pero perpetuaría el mismo riesgo de infraestructura no documentada dentro de AWS, solo que ahora en un entorno de producción. **Se acepta únicamente como mecanismo de validación temporal** (ver Decisión), nunca como la estrategia reproducible en sí.
- **Detener toda la migración de CatastroX hasta resolver el problema**: descartada — CatastroX y Ganadería son bases de datos completamente separadas (aislamiento ya confirmado por la auditoría); no hay razón técnica para bloquear la migración de Ganadería por este motivo.
- **Migrar CatastroX de forma parcial (solo `catastrox_clean`, que sí tiene DDL) y posponer `gis.*`**: parcialmente viable, pero el propio backend consulta primero `gis.catastro_caqueta` (legacy) antes de hacer fallback a `catastrox_clean` (`server/routes/catastrox.js:871-1051`) — migrar solo una fuente rompería el comportamiento actual del endpoint `/lookup`.
- **Condicionar la migración completa de CatastroX a la existencia de un proceso reproducible y documentado, con entregables obligatorios explícitos** (elegida): resuelve la causa raíz sin bloquear el resto del proyecto.

## Decisión

**CatastroX no podrá migrarse completamente hasta contar con un proceso reproducible para `gis.catastro_caqueta` y `gis.municipios_colombia`.** La migración de Ganadería (ADR-001, ADR-002) no queda bloqueada por esta condición, al ser una base de datos completamente separada.

El proceso reproducible debe producir, como **entregables obligatorios** (no opcionales, no reemplazables por un simple volcado de datos):

- **DDL completo** de ambas tablas (estructura, tipos, restricciones).
- **Scripts de importación** versionados, sin dependencias de rutas de archivo locales de una máquina específica.
- **Manifiesto de fuentes de datos**: origen exacto de los datos IGAC utilizados (versión, fecha de descarga, procedencia).
- **Hashes** de los archivos fuente originales, para verificar integridad frente a futuras reimportaciones.
- **SRID** documentado y su tratamiento explícito (registrado en la base destino o mantenido como workaround consciente — ver más abajo).
- **Conteo de registros** esperado por tabla, como línea base de verificación.
- **Índices** (incluidos los espaciales GiST) documentados y reproducibles.
- **Vistas** dependientes (por ejemplo, `v_predios_enriquecidos`) documentadas y reproducibles.
- **Consultas de validación** que permitan confirmar, tras una recreación desde cero, que los datos y la geometría son correctos.
- **Procedimiento de restauración** paso a paso, ejecutable por alguien distinto de quien lo escribió.

**`pg_dump`/`restore` de la instancia local actual puede usarse como mecanismo de validación temporal** (por ejemplo, para probar la Fase 0B de staging mientras el proceso reproducible completo se termina de documentar), **pero no se acepta como la única estrategia reproducible** ni como sustituto de los entregables listados arriba.

## Justificación

- La ausencia de DDL versionado para estas dos tablas es un hallazgo verificado directamente en el código y la documentación existente (`docs/catastrox/CATASTROX_CLEAN_IMPORT_CAQUETA.md`), no una suposición.
- El workaround de EPSG:9377 hardcodeado en la aplicación, en vez de resuelto a nivel de base de datos, es evidencia adicional de que el entorno geoespacial actual tiene deuda de infraestructura no documentada que debe resolverse antes — no después — de comprometerse a un entorno de producción en AWS.
- Exigir entregables concretos (DDL, scripts, manifiesto, hashes, conteos, consultas de validación, procedimiento de restauración) en vez de una simple "migración funcional" asegura que el proceso sea auditable y repetible por cualquier miembro del equipo, no solo por quien lo ejecutó la primera vez.
- Permitir `pg_dump`/`restore` únicamente como validación temporal reconoce que es útil para probar la conectividad y el comportamiento de PostGIS en RDS sin bloquear el aprendizaje del equipo, sin que eso sustituya el trabajo de documentación pendiente.

## Consecuencias positivas

- Evita trasladar infraestructura no reproducible y no documentada al nuevo entorno de producción en AWS.
- Obliga a saldar la deuda de documentación como parte del propio proceso de migración, mejorando la mantenibilidad a largo plazo del módulo catastral.
- Preserva la posibilidad de migrar Ganadería de forma independiente y sin demora, dado que ambas bases están desacopladas.
- Los entregables obligatorios (hashes, manifiesto, consultas de validación) permiten detectar corrupción o divergencia de datos en cualquier reimportación futura, no solo en la migración actual.

## Consecuencias negativas

- La migración de CatastroX a AWS queda desacoplada en el tiempo de la de Ganadería, con un cronograma propio sujeto a que se resuelva este problema.
- Requiere esfuerzo adicional (posiblemente especializado en GIS/PostGIS) para documentar o reconstruir el proceso de importación de datos IGAC de forma reproducible, y para producir todos los entregables exigidos.

## Riesgos

- Si el DDL y el proceso de importación no se capturan pronto, el riesgo aumenta con el tiempo (por ejemplo, si la máquina local con la ruta `D:\CatastroX_IGAC_Limpio_2026\...` cambia o se pierde el acceso a ella).
- Si la instancia RDS destino tampoco tiene EPSG:9377 registrado (escenario probable, no es un SRID estándar de PostGIS), el mismo workaround aplicado hoy deberá mantenerse o resolverse de forma explícita — no debe asumirse resuelto automáticamente por el simple hecho de migrar de proveedor.
- Usar `pg_dump`/`restore` como atajo más allá de la validación temporal (sin producir los entregables obligatorios) reintroduciría exactamente el problema que esta ADR busca resolver.

## Acciones requeridas

- Exportar y documentar el DDL completo y real de `gis.catastro_caqueta` y `gis.municipios_colombia` (por ejemplo, vía `pg_dump --schema-only` contra la instancia actual) como línea base.
- Completar, ejecutar y validar el proceso de importación de datos IGAC versionado, sin depender de una ruta de archivo local de una máquina específica.
- Producir el manifiesto de fuentes de datos y los hashes de los archivos fuente originales.
- Documentar conteos de registros esperados, índices y vistas dependientes.
- Escribir las consultas de validación y el procedimiento de restauración paso a paso.
- Decidir explícitamente si EPSG:9377 se registra formalmente en la instancia RDS destino o si el workaround PROJ actual se mantiene de forma consciente y documentada (no como pendiente sin dueño).
- Validar la reproducibilidad completa (crear desde cero, en un entorno de staging, ambas tablas siguiendo el procedimiento de restauración documentado, y confirmar que el endpoint `/lookup` funciona igual que hoy) antes de considerar la migración de CatastroX lista para producción.

## Criterios de aceptación

- Existen, versionados y accesibles al equipo: DDL completo, scripts de importación, manifiesto de fuentes, hashes, documentación de SRID, conteos de registros esperados, definición de índices y vistas, consultas de validación, y procedimiento de restauración — los diez entregables exigidos en la Decisión.
- El procedimiento de restauración puede ejecutarse, por una persona distinta de quien lo escribió, para recrear `gis.catastro_caqueta` y `gis.municipios_colombia` desde cero en una instancia RDS PostgreSQL/PostGIS limpia, sin depender de rutas locales de una máquina específica.
- El tratamiento de EPSG:9377 queda documentado como decisión explícita (registrado en RDS, o workaround mantenido conscientemente), no como un pendiente sin resolución.
- Una prueba funcional del checklist de staging ("una búsqueda predial con consulta espacial funciona correctamente contra `staging-agx-catastrox`") pasa usando exclusivamente el proceso reproducible documentado, no una copia manual/temporal de la base local.

## Elementos fuera de alcance

- La migración de Ganadería, que no depende de esta ADR (ver ADR-001, ADR-002).
- La ejecución real de la migración de CatastroX a producción (esta ADR condiciona cuándo puede ocurrir, no la ejecuta).
- La decisión final sobre si se registra EPSG:9377 en RDS o se mantiene el workaround — se resuelve como parte de las acciones requeridas, no en esta ADR.
