# Migraciones de Postgres-AGX-Business

Base NUEVA, separada del Postgres legacy de producción (que queda intacto,
ver informe SPRINT-3B1-BUSINESS-DB-FOUNDATION) y separada también de
Postgres-AGX (plano de identidad -- `db/agx/migrations/`). Primera
vertical: MIS PREDIOS (`agx.predios` + `agx.predio_snapshots_catastrales`).

**Nunca ejecutar estos archivos directamente contra Railway/producción sin
autorización explícita separada.** Este directorio es el artefacto
versionado; la creación real del servicio Railway y la ejecución del DDL
son pasos posteriores y distintos, no incluidos en este sprint.

Orden de aplicación: `0000_bootstrap_roles.sql` (requiere superusuario, crea
`agx_owner`/`agx_app`) → `0001_business_foundation.sql` (schema, extensión
PostGIS, tablas, índices, RLS, políticas, grants).

## Modelo: predio (mutable) vs snapshot catastral (append-only)

- **`agx.predios`** es la entidad OPERATIVA del cliente -- mutable.
  `agx_app` tiene `SELECT/INSERT/UPDATE/DELETE`. El cliente puede renombrar
  su predio, corregir el área declarada, actualizar la geometría vigente,
  etc., en cualquier momento.
- **`agx.predio_snapshots_catastrales`** es el registro de lo que
  CatastroX devolvió en un momento dado -- **append-only para la
  aplicación**. `agx_app` tiene únicamente `SELECT/INSERT` -- ni
  `UPDATE` ni `DELETE`, aplicado tanto a nivel de GRANT (rechazo
  `42501 insufficient_privilege`) como reforzado por RLS. Una nueva
  consulta catastral (re-verificación, actualización periódica, etc.)
  **siempre inserta una fila nueva** -- nunca actualiza un snapshot
  existente. Si algún día se necesita borrar snapshots por retención de
  datos, esa es una operación de `agx_owner` (fuera del rol de
  aplicación), no algo que la API deba poder hacer.
- La FK compuesta `(predio_id, organizacion_id)` de snapshots contra
  `predios (predio_id, organizacion_id)` garantiza, a nivel de integridad
  referencial (no solo RLS), que un snapshot no puede declarar una
  organización distinta de la del predio que referencia -- ni siquiera
  enumerando `predio_id` a ciegas.

## Entorno local desechable (PostgreSQL + PostGIS)

La contraseña de `agx_app` nunca vive en ningún archivo versionado -- ni
siquiera como placeholder de ejemplo. Se genera en el momento de ejecutar
el bootstrap y se inyecta vía la variable `psql` `agx_app_password`.

```bash
docker run --name agx-business-integration-pg -e POSTGRES_PASSWORD=postgres \
  -p 55436:5432 -d postgis/postgis:16-3.4

# Esperar readiness
docker exec agx-business-integration-pg pg_isready -U postgres

# Contraseña generada solo para esta sesión de shell -- nunca escrita a disco.
export AGX_APP_PASSWORD="$(openssl rand -base64 24)"

psql "postgres://postgres:postgres@localhost:55436/postgres" \
  -v ON_ERROR_STOP=1 -v agx_app_password="$AGX_APP_PASSWORD" \
  -f db/agx-business/migrations/0000_bootstrap_roles.sql

psql "postgres://postgres:postgres@localhost:55436/postgres" \
  -v ON_ERROR_STOP=1 -f db/agx-business/migrations/0001_business_foundation.sql

export AGX_BUSINESS_DATABASE_URL="postgres://agx_app:${AGX_APP_PASSWORD}@localhost:55436/postgres"
```

## Pruebas de integración de "Mis Predios" (SPRINT-3C1/3C1.1/3C1.2)

`server/services/__tests__/prediosRepositoryIntegration.test.js` prueba
contra un Postgres/PostGIS REAL (RLS+FORCE, aislamiento entre
organizaciones, rollback real de transacción, retry/concurrencia de
candidatos).

**⚠️ `AGX_BUSINESS_DATABASE_URL_TEST` NUNCA debe apuntar a Railway/producción.**
Es una variable exclusiva de esta suite, deliberadamente distinta de
`AGX_BUSINESS_DATABASE_URL` (la variable de producción/runtime real que
lee `server/db/agxBusinessPool.js`) para que un test local o de CI no
pueda conectarse a producción por herencia accidental de entorno -- el
archivo de test borra explícitamente cualquier `AGX_BUSINESS_DATABASE_URL`
ambiental antes de decidir si corre, y solo la fija internamente (en
memoria de su propio proceso) derivada 1:1 de `_TEST`.

Pasos completos, de cero:

```bash
# 1. Levantar el Postgres/PostGIS desechable (mismo entorno de arriba).
docker run --name agx-business-integration-pg -e POSTGRES_PASSWORD=postgres \
  -p 55436:5432 -d postgis/postgis:16-3.4
docker exec agx-business-integration-pg pg_isready -U postgres

# 2. Aplicar las migraciones (mismo orden de siempre).
export AGX_APP_PASSWORD="$(openssl rand -base64 24)"
psql "postgres://postgres:postgres@localhost:55436/postgres" \
  -v ON_ERROR_STOP=1 -v agx_app_password="$AGX_APP_PASSWORD" \
  -f db/agx-business/migrations/0000_bootstrap_roles.sql
psql "postgres://postgres:postgres@localhost:55436/postgres" \
  -v ON_ERROR_STOP=1 -f db/agx-business/migrations/0001_business_foundation.sql

# 3. Configurar las variables EXCLUSIVAS de este test -- nunca
# AGX_BUSINESS_DATABASE_URL (esa es la de producción/runtime).
export AGX_BUSINESS_DATABASE_URL_TEST="postgres://agx_app:${AGX_APP_PASSWORD}@localhost:55436/postgres"
export AGX_BUSINESS_INTEGRATION_ADMIN_DATABASE_URL="postgres://postgres:postgres@localhost:55436/postgres"

# 4. Ejecutar el script dedicado.
npm run test:ganaderia-predios-integration
# -> 9/9 PASS

# 5. Destruir la base desechable.
docker rm -f agx-business-integration-pg
```

`npm run test:ganaderia-predios-integration` **falla explícitamente**
(no se omite en silencio) si `AGX_BUSINESS_DATABASE_URL_TEST` no está
configurada -- mensaje: `AGX_BUSINESS_DATABASE_URL_TEST is required for
real integration tests.` (ver `.tools/require-ganaderia-predios-integration-env.mjs`).
Este mismo archivo de test, cuando corre como parte de
`npm run test:node` (la suite general), sigue auto-omitiéndose sin fallar
el pipeline si esas variables no están configuradas -- el gate estricto
es exclusivo del script dedicado, no del archivo de test en sí.

## Teardown

```bash
docker rm -f agx-business-integration-pg
```
