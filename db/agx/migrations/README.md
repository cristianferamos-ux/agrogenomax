# Migraciones de Postgres-AGX (plano de identidad/autorización)

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
