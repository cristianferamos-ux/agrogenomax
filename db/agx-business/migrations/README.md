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

## Teardown

```bash
docker rm -f agx-business-integration-pg
```
