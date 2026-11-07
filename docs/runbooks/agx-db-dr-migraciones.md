# Runbook — DR y migraciones de Postgres-AGX-Business y Postgres-AGX (Auth)

HARDENING PRE-SANIDAD, PR A. Cubre BACKUP, RESTORE, VERIFY, MIGRATE y RECOVERY.
Nada de este runbook se ejecuta contra producción sin autorización explícita del sprint.

## ⚠️ Reglas que no se negocian

1. **`pg_dump -Fc` solo NO es DR.** Los roles (`agx_owner`, `agx_app`, `agx_qr_admin`,
   `agx_ficha_pastura_validator`, `agx_auth`) son objetos del cluster y no viajan en el dump.
   Verificado: restaurar sin ellos pierde 10 de 39 policies, todos los grants y el ownership.
   El `GRANT CONNECT ON DATABASE` de 0023 tampoco viaja sin `--create`.
2. **Los roles se restauran primero**, sin contraseñas (`--no-role-passwords`). Las contraseñas
   se fijan después con `ALTER ROLE ... PASSWORD` y se cargan en Railway, nunca en el repo.
3. **Nunca continuar tras un error de `pg_restore`.** Siempre `--exit-on-error --single-transaction`.
   Sin esas opciones, `pg_restore` termina con avisos y las FKs que fallan quedan sin crear.
4. **Nunca conectar el runtime como `postgres`** para "resolver" permisos: el superusuario se salta
   RLS y FORCE RLS y expone a todas las organizaciones. El runtime es `agx_app` (Business) y
   `agx_auth` (Auth), sin SUPERUSER ni BYPASSRLS.
5. **No ejecutar a mano los rollbacks históricos** (`0001`–`0026_*_rollback.sql`). Hacen `DROP TABLE`
   / `DROP COLUMN` con datos; varios sin guarda, y 0024 borra columnas antes de la comprobación que
   debería fallar. Solo con el runner (ver RECOVERY).
6. **Nunca aplicar migraciones con `psql -f` directo.** Siempre el runner: una transacción,
   `ON_ERROR_STOP`, ledger y checksums.

## Inventario verificado (2026-11-06, solo lectura)

| Base | Servicio Railway | DB | Versión | Esquema | Roles |
|---|---|---|---|---|---|
| Business | `Postgres-AGX-Business` | `agx_business` | PostgreSQL 16.4 + PostGIS 3.4.3 | `agx` == 0000–0026 (1064 objetos idénticos) | `agx_owner`, `agx_app`, `agx_qr_admin`, `agx_ficha_pastura_validator` |
| Auth | `Postgres-AGX` | `railway` | PostgreSQL 18.6 | `agx`: 8 tablas, 4 funciones, 3 triggers | `agx_owner`, `agx_auth` |

Business además tiene `fuzzystrmatch`, `postgis_tiger_geocoder` y `postgis_topology`, que trae la
imagen de Railway (fuera de `agx`). No son parte de las migraciones y la certificación las ignora.

Ninguna de las dos bases tiene TCP público: el acceso es `railway ssh --service <servicio>
--environment production -- "<cmd>"` con `psql`/`pg_dump` del propio contenedor (misma versión que el servidor).

## BACKUP (producción, por servicio)

Dentro del contenedor (`railway ssh`), en `/tmp`. Luego transferir con `base64 -w0`, verificar SHA-256
en ambos lados y borrar la copia remota:

```bash
# 1. Roles sin contraseñas (solo los de la aplicación).
pg_dumpall -U postgres --roles-only --no-role-passwords \
  | grep -E '^(CREATE ROLE|ALTER ROLE|GRANT [a-z_]+ TO) agx_' > /tmp/<base>_roles_<UTC>.sql

# 2. Base completa, con propiedades/ACL de la base (--create).
pg_dump -U postgres -Fc --create -d <db> -f /tmp/<base>_<UTC>.dump

# 3. Huella de catálogo al momento del backup (sin filas).
psql -U postgres -d <db> -X -q -v schemas=agx,agx_meta -f /tmp/schema_fingerprint.sql > /tmp/<base>_<UTC>.fingerprint
```

Guardar los tres archivos juntos (`C:\Users\Diego\AGX-Backups\prod-<base>\`). Un `.dump` sin su
`_roles.sql` y su `.fingerprint` no se considera backup DR completo. Para Auth usar `-v schemas=agx`.

## RESTORE (cluster vacío)

```bash
# 0. El cluster destino no debe tener roles agx_* previos con atributos distintos.
psql -U postgres -v ON_ERROR_STOP=1 -1 -f <base>_roles_<UTC>.sql
# 1. Contraseñas NUEVAS para los roles LOGIN (nunca reutilizar ni escribir en archivos).
psql -U postgres -c "alter role agx_app password '...'"   # idem agx_qr_admin / agx_auth
# 2. Base vacía y restore estricto.
createdb -U postgres <db>
pg_restore -U postgres --exit-on-error --single-transaction -d <db> <base>_<UTC>.dump
# 3. Propiedades/ACL de la base (pg_restore solo las aplica con -C, incompatible con --single-transaction).
pg_restore --create --schema-only -f - <base>_<UTC>.dump \
  | grep -E '^(GRANT|REVOKE) .+ ON DATABASE <db> |^ALTER DATABASE <db> SET ' \
  | psql -U postgres -d <db> -v ON_ERROR_STOP=1 -1
```

Si cualquier paso falla: **parar**, no "arreglar" con grants manuales ni con el runtime como `postgres`.

## VERIFY

1. Huella de catálogo del restore == la `.fingerprint` del backup (`diff`). Únicas diferencias
   aceptables: deparse de CHECK/índices parciales y ACLs iguales al default del dueño (ver
   `normalizeForRestoreCompare` en `.tools/agx-dr-verify.mjs`).
2. Filas por tabla == origen.
3. Smoke con el rol runtime (nunca `postgres`): rol sin SUPERUSER/BYPASSRLS; sin organización no se
   ve nada; dentro del tenant sí; tenant ajeno invisible; INSERT ajeno y DELETE rechazados;
   `agx_meta` inaccesible.

La verificación completa y automatizada en local (dos clusters Docker desechables):

```bash
npm run test:agx-dr                       # business + auth, ~1 min, 40 comprobaciones
npm run test:agx-migrations-integration   # runner: 11 pruebas reales
```

## MIGRATE

Runner: `node .tools/agx-migrate.mjs` (`npm run agx:migrate -- ...`). Checksum SHA-256 sobre el
archivo normalizado a LF (git guarda LF; el checkout de Windows puede tener CRLF y eso no cuenta como
cambio). La URL va siempre en una variable de entorno (`--url-env`), y solo se admite loopback salvo
`--allow-remote-host <host>`.

- `status --target business|auth`: archivos, checksums y variables psql requeridas.
- `plan` / `up --target business --url-env VAR [--to N] [--version N] [--var nombre=ENV]`.
- `up --fresh`: construye una base vacía desde 0000 (DR, pruebas, staging nuevo).
- `bundle --target business --version N --out f.sql`: script psql autocontenido para producción.

Cada bundle es UNA transacción (`begin` … `commit`) con advisory lock, y comprueba **en el servidor**,
antes de ejecutar la migración: ledger presente, versión no registrada, todas las previas registradas
con el mismo archivo y checksum, y ninguna posterior. El registro se inserta en la misma transacción:
si algo falla, no queda nada aplicado ni registrado. Se rechazan archivos con BEGIN/COMMIT/SAVEPOINT
propios o con `\connect`, `\i`, `\!`, `\o` o `\g`.

### Producción (Business), secuencia por migración nueva

1. Backup completo (sección BACKUP).
2. `node .tools/agx-migrate.mjs bundle --target business --version N --out bundle_N.sql`
   y anotar su SHA-256.
3. Subir el bundle al contenedor (bloques base64 de unos 3000 caracteres) y verificar el SHA-256.
4. `psql -U postgres -d agx_business -X -v ON_ERROR_STOP=1 [-v var=...] -f /tmp/bundle_N.sql`
5. Verificar `select * from agx_meta.schema_migrations order by version desc limit 3`.
6. Recién entonces mergear el código que depende de la migración (Railway despliega `main` automáticamente).

### Bootstrap del ledger (0027) — una sola vez por base

El bundle de 0027 **certifica** antes de crear el ledger: calcula la huella de catálogo de `agx` y
aborta (`AGX_MIGRATE_BASELINE_FINGERPRINT_MISMATCH`) si no coincide con
`db/agx-business/verify/baseline_0000_0026.fingerprint` (0000–0026 aplicadas desde cero). Solo si
coincide registra 0000–0026 como `baseline_certificada` y 0027 como `aplicada`.
**`baseline_certificada` es una certificación del estado actual, no historia:** `applied_at` es la
fecha de certificación. La existencia de un archivo nunca se registra como evidencia de que corrió.

## RECOVERY

- **Una migración falló:** la transacción se revirtió completa y el ledger no cambió. Corregir con una
  migración NUEVA (nunca editar una ya aplicada: el checksum lo detecta y bloquea todo lo posterior).
- **Rollback de una migración posterior al ledger:** `rollback --target business --version N --confirm-rollback N`.
  Solo la última versión aplicada. Antes del SQL se comprueba que las tablas y columnas que el rollback
  borra estén vacías; si no, aborta. La baja del ledger queda auditada en `agx_meta.schema_migration_eventos`.
- **Rollback histórico (0001–0026):** bloqueado por defecto. Solo con
  `--allow-historical-destructive-rollback N` (la versión exacta) y `--backup-evidence <dump PGDMP local>`,
  además de las mismas precondiciones de datos vacíos verificadas en el servidor. Antes de considerarlo:
  revertir el código, tener un backup DR completo verificado y la autorización del sprint.
- **El ledger no se revierte con el runner.** Retirarlo (solo en una base desechable o con autorización):
  `drop schema agx_meta cascade;` como superusuario. No hay otra manera, a propósito.
- **Pérdida total de una base:** RESTORE desde el último backup completo y VERIFY. Si no hay backup,
  reconstruir la estructura con `up --fresh` (Business 0000–0027; Auth 0000–0002) y asumir que los
  datos se pierden.
