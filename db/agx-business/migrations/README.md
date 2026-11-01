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

## 0023 -- inventario QR (SPRINT-3D11.3 R1)

`0023_qr_inventario_chapetas.sql` crea el rol PostgreSQL **`agx_qr_admin`**
(única conexión con acceso al inventario QR global; `agx_app` no tiene
privilegios sobre lotes, tokens ni eventos de lote). Requiere la variable
`psql` `agx_qr_admin_password` y se aplica en UNA transacción:

```bash
psql "$ADMIN_URL" -1 -v ON_ERROR_STOP=1 \
  -v agx_qr_admin_password="$AGX_QR_ADMIN_PASSWORD" \
  -f db/agx-business/migrations/0023_qr_inventario_chapetas.sql
```

El backend usa ese rol vía `AGX_BUSINESS_QR_ADMIN_DATABASE_URL` (distinta de
`AGX_BUSINESS_DATABASE_URL`), y además necesita `AGX_QR_TOKEN_ENCRYPTION_KEY`
(AES-256-GCM, 32 bytes base64, clave propia) y `AGX_QR_PUBLIC_ORIGIN`
(dominio impreso en el QR). Sin ellas el servidor arranca y las rutas
`/api/ganaderia/admin/qr` responden 503.

Integración local (además de las dos URLs de siempre):
`AGX_BUSINESS_QR_ADMIN_DATABASE_URL_TEST=postgres://agx_qr_admin:...@127.0.0.1:<puerto>/<base>_test`
(`npm run test:ganaderia-animales-integration` la exige y valida el rol).

## 0024 -- pesajes posteriores MANUAL (FASE 1A)

Aditiva sobre `agx.animal_pesajes` (sigue siendo la única fuente de verdad
del historial de peso; nada derivado se guarda en `agx.animales`):

- `origen` admite `REGISTRO_INICIAL` (máximo uno por animal, NO es peso al
  nacimiento) y `MANUAL` (N por animal, varios el mismo día). OFFLINE no es
  un origen sino un transporte.
- `client_operation_id uuid` (obligatorio para `MANUAL`, índice UNIQUE
  parcial por organización) y `observaciones text` (≤ 500, nunca vacía).
- Sin cambios de RLS/FORCE, políticas ni grants: `agx_app` sigue con
  SELECT/INSERT (append-only).

**Secuencia de despliegue:** aplicar `0024` en Postgres-AGX-Business
**antes** del merge del código que registra pesajes MANUAL (Railway despliega
`main` automáticamente); el código anterior funciona con la tabla ampliada.
Rollback: `0024_animal_pesajes_manual_rollback.sql`, solo tras revertir el
código y sin filas MANUAL (si existen, el rollback falla a propósito).
Pruebas: `server/services/__tests__/animalPesajesIntegration.test.js`
(incluida en `npm run test:ganaderia-animales-integration`).

## 0025 -- cierre operativo: salida y muerte (FASE 2A)

Aditiva sobre `agx.animales` y `agx.animal_eventos`:

- `estado_operativo` (`EN_HATO` | `SALIDO` | `MUERTO`, por defecto
  `EN_HATO`) es un eje **independiente** de `estado` (`ACTIVO` | `ANULADO`):
  anular corrige un registro erróneo; salir o morir es un hecho real.
- `cierre_fecha` (fecha efectiva de negocio), `cierre_causa` (catálogo según
  el estado), `cierre_observaciones` (≤ 500), `cierre_at`, `cierre_por` y
  `cierre_client_operation_id` (UNIQUE parcial por organización:
  idempotencia). CHECKs de consistencia estado/columnas y de orden de fechas
  (no antes del nacimiento ni del ingreso).
- Trigger `animales_cierre_guard`: solo `EN_HATO -> SALIDO|MUERTO`; el
  cierre es terminal e inmutable (sin reapertura en esta fase).
- Eventos `SALIDO` / `MUERTO` en `agx.animal_eventos` (como mucho uno de los
  dos por animal, índice único parcial). `agx_app` recibe UPDATE solo sobre
  las columnas nuevas; RLS/FORCE y políticas sin cambios.

**Secuencia de despliegue:** aplicar `0025` en Postgres-AGX-Business
**antes** del merge del código de FASE 2A; el código anterior funciona con
las columnas nuevas (no las lee ni las escribe). Rollback:
`0025_animal_cierre_operativo_rollback.sql`, solo tras revertir el código y
sin eventos `SALIDO`/`MUERTO` (si existen, el rollback falla a propósito).
Pruebas: `server/services/__tests__/animalCierreIntegration.test.js`
(incluida en `npm run test:ganaderia-animales-integration`).

## 0026 -- reproducción bovina: historial de eventos (FASE 4A)

Aditiva pura: crea `agx.reproduccion_eventos` (no modifica tablas ni datos
existentes; solo referencia `agx.animales`).

- Fuente de verdad ÚNICA del historial reproductivo. Ocho tipos:
  `CELO_OBSERVADO`, `SERVICIO_MONTA`, `INSEMINACION_ARTIFICIAL`, `IATF`,
  `TRANSFERENCIA_EMBRION`, `DIAGNOSTICO_PRENEZ`, `ABORTO`, `PARTO`.
  Columnas tipadas por tipo (sin JSONB) con un CHECK por grupo: cada campo
  solo existe en los tipos donde aplica.
- El estado reproductivo **no se guarda**: se deriva de los eventos
  `ACTIVO` (`server/services/ganaderia/reproduccionEstado.js`).
- FKs compuestas tenant-safe: animal y toro (`toro_animal_id`) de la misma
  organización; `corrige_evento_id` del MISMO animal y organización (un
  evento se corrige como máximo una vez).
- Idempotencia: `client_operation_id` UNIQUE por organización +
  `intent_hash` v1; `anulacion_client_operation_id` UNIQUE parcial.
- Inmutable: `agx_app` tiene SELECT/INSERT y UPDATE solo de las columnas de
  anulación; sin DELETE. Trigger `reproduccion_eventos_guard`: solo
  `ACTIVO -> ANULADO`, `ANULADO` terminal, contenido inmutable y sin DELETE
  (también para conexiones distintas de la app). RLS ENABLE + FORCE.

**Secuencia de despliegue:** aplicar `0026` en Postgres-AGX-Business
**antes** del merge del código de FASE 4A (el código anterior no la usa).
Imprescindible: desde 4A, `corregirAnimal` también consulta
`agx.reproduccion_eventos` al cambiar sexo o fecha de nacimiento (sin 0026
esas correcciones fallarían con 42P01).
Rollback: `0026_reproduccion_bovina_rollback.sql`, solo tras revertir el
código; si la tabla tiene datos el rollback falla a propósito (no borra
historial). Pruebas: `npm run test:ganaderia-reproduccion-integration`
(`server/services/__tests__/reproduccionIntegration.test.js`).
