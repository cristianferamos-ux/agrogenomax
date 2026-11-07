# Migraciones de Postgres-AGX (plano de identidad/autorización)

> **HARDENING PRE-SANIDAD:** `0000_baseline_auth_schema.sql` versiona la estructura
> preexistente (extraída solo lectura de producción el 2026-11-06, sin datos).
> `0000`+`0001`+`0002` reconstruyen Auth desde cero con huella idéntica a producción
> (`db/agx/verify/prod_auth_20261106.fingerprint`):
> `node .tools/agx-migrate.mjs up --target auth --fresh --url-env VAR --var agx_auth_password=ENV`.
> 0000 falla a propósito sobre una base existente: no se aplica en producción.
> Este target todavía no tiene ledger. Ver
> [`docs/runbooks/agx-db-dr-migraciones.md`](../../../docs/runbooks/agx-db-dr-migraciones.md).
> El bloque "Entorno local desechable" de abajo queda obsoleto: ya no hace falta recrear las tablas a mano.

Convención nueva para este directorio (no existía ninguna migración
versionada de `agx.*` antes de `0001`; ese esquema fue provisionado
directamente en Railway). A partir de aquí, cualquier cambio de esquema
sobre Postgres-AGX (producción) o su equivalente en staging
(Postgres-3myV) debe versionarse aquí como un archivo `NNNN_descripcion.sql`
aditivo, con su `NNNN_descripcion_rollback.sql` correspondiente.

**Nunca ejecutar estos archivos directamente contra Railway/producción
sin autorización explícita separada.** Este directorio es el artefacto
versionado; la ejecución real es un paso posterior y distinto.

## Entorno local desechable (para `server/security/__tests__/ganaderiaOrgMembresiaIntegration.test.js`)

Mismo patrón que `scripts/catastrox/test/README.md`: la suite se
auto-omite (`skip`) si `AGX_AUTH_DATABASE_URL` no apunta a una base real
con `agx.organizaciones` ya migrada -- nunca falla el pipeline sin
Postgres real disponible, y nunca debe apuntar a una URL de
staging/producción real.

```bash
docker run --name agx-auth-integration-pg -e POSTGRES_PASSWORD=postgres \
  -p 55434:5432 -d postgres:18

psql "postgres://postgres:postgres@localhost:55434/postgres" \
  -c "create schema if not exists agx; create role agx_owner nologin; create role agx_auth login password 'x';"
# Recrear las 6 tablas base tal como existen en producción (ver informe
# Sprint 1A, sección B, o el propio server/db/agxAuthPool.js para las
# columnas exactas que el código espera) -- fuera de alcance de este
# README reproducir aquí el DDL completo de las 6 tablas preexistentes;
# usar como referencia el volcado del informe de auditoría del sprint.

export AGX_AUTH_DATABASE_URL="postgres://agx_auth:x@localhost:55434/postgres"
# Rol admin SOLO para sembrar/limpiar fixtures de prueba (agx_auth nunca
# tiene INSERT en cuentas/organizaciones/membresias -- ver comentario de
# cabecera del test):
export AGX_AUTH_INTEGRATION_ADMIN_DATABASE_URL="postgres://postgres:postgres@localhost:55434/postgres"

psql "postgres://postgres:postgres@localhost:55434/postgres" \
  -v ON_ERROR_STOP=1 -f db/agx/migrations/0001_organizaciones_membresias_auth.sql

node --test "server/security/__tests__/ganaderiaOrgMembresiaIntegration.test.js"
```

## Teardown

```bash
docker rm -f agx-auth-integration-pg
```
