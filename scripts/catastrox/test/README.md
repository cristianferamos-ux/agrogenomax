# Entorno de integración local para P1-02/P1-03 (CatastroX)

**Uso exclusivamente local/test.** Estas instrucciones levantan una base de
datos efímera en tu máquina para poder ejecutar las 4 suites de integración
que hoy se auto-omiten sin Postgres real. **Nunca** apuntes las variables
de este documento a una URL de staging o producción — ni `DATABASE_URL` ni
`CATASTROX_DATABASE_URL` deben contener jamás una connection string real de
Railway, RDS o cualquier entorno compartido. Este documento no contiene
secretos: todas las credenciales de ejemplo son locales (`postgres`/
`postgres`, `localhost`).

## Alcance

Suites cubiertas:

- `server/routes/__tests__/catastroxPaymentOrders.test.js`
- `server/routes/__tests__/catastroxPaymentWebhook.test.js`
- `server/routes/__tests__/catastroxDeliveryLifecycle.test.js`
- `server/routes/__tests__/catastroxCustomerOtpAndHistory.test.js`

Las cuatro se auto-omiten (`skip`) si `DATABASE_URL`/`CATASTROX_DATABASE_URL`
no apuntan a una base real alcanzable — este entorno existe para que dejen
de omitirse, sin tocar producción ni Railway.

## Dos bases, una sola instancia Postgres

| Variable | Base local | Uso |
|---|---|---|
| `DATABASE_URL` | `agrogenomax_test` | Pagos/clientes/entrega de CatastroX (esquema `public`) |
| `CATASTROX_DATABASE_URL` | `catastrox_postgis_test` | Predio sintético (esquema `catastrox_clean`) |

Ambas bases pueden vivir en la **misma** instancia Postgres/PostGIS local —
no hay ninguna dependencia de código que exija procesos separados, solo que
las dos variables apunten a bases (nombres de base de datos) distintas.

## 1. Levantar Postgres/PostGIS local

Con Docker (recomendado, imagen `postgis/postgis` para tener ambas
extensiones disponibles sin pasos extra). El puerto de HOST es
configurable -- elige cualquier puerto libre en tu máquina; el puerto
INTERNO del contenedor siempre es `5432` (no cambia). En Windows, algunos
puertos altos pueden caer dentro de un rango dinámico excluido por
Hyper-V (`netsh interface ipv4 show excludedportrange protocol=tcp`), lo
que hace fallar el bind con "access forbidden" -- si eso ocurre, prueba
otro puerto. El ejemplo de abajo usa `55432` (puerto de host validado en
este entorno), pero cualquier puerto libre y no excluido sirve igual:

```bash
docker run --name catx-integration-pg -e POSTGRES_PASSWORD=postgres \
  -p 55432:5432 -d postgis/postgis:16-3.4
```

## 2. Crear las dos bases

```bash
psql "postgres://postgres:postgres@localhost:55432/postgres" \
  -c "create database agrogenomax_test;"
psql "postgres://postgres:postgres@localhost:55432/postgres" \
  -c "create database catastrox_postgis_test;"
```

## 3. Base principal (`agrogenomax_test`)

```bash
export DATABASE_URL="postgres://postgres:postgres@localhost:55432/agrogenomax_test"

psql "$DATABASE_URL" -c 'create extension if not exists "pgcrypto";'

for f in supabase/migrations/002_catastrox_payment_orders.sql \
         supabase/migrations/003_catastrox_payment_recovery_and_webhook_state.sql \
         supabase/migrations/004_catastrox_commercial_model_n_purchases.sql \
         supabase/migrations/005_catastrox_pii_hardening_and_idempotency.sql \
         supabase/migrations/006_catastrox_email_verification_cooldown.sql \
         supabase/migrations/007_catastrox_deliverable_blobs.sql \
         supabase/migrations/008_catastrox_delivery_attempts.sql \
         supabase/migrations/009_catastrox_delivery_concurrency.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

`001_agrogenomax_core.sql` (Ganadería) se omite deliberadamente: ninguna
tabla/FK de `002`-`009` depende de él. El esquema de todas las tablas
`catastrox_*` es siempre `public` (confirmado en el encabezado de
`002_catastrox_payment_orders.sql`) — `PGSCHEMA` no tiene ningún efecto
sobre ellas.

## 4. Base PostGIS CatastroX (`catastrox_postgis_test`)

```bash
export CATASTROX_DATABASE_URL="postgres://postgres:postgres@localhost:55432/catastrox_postgis_test"

psql "$CATASTROX_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f scripts/catastrox/test/setup_integration_postgis.sql
```

Este script es idempotente: puede volver a ejecutarse sin error para
restaurar el fixture a su estado inicial.

## 5. Variables adicionales requeridas por las 4 suites

Estas variables ya deben existir en tu `.env`/`server/.env` local para que
`getConfig()` no falle al arrancar (ninguna es secreta a nivel real, son
valores de prueba locales — ver `server/.env.example` para la lista
completa con placeholders):

```
APP_ENV=test
HEALTH_MONITOR_TOKEN=<32+ caracteres, valor local de prueba>
CATASTROX_PII_ENCRYPTION_KEY=<32 bytes en base64, valor local de prueba>
CATASTROX_PII_HASH_SECRET=<32+ caracteres, valor local de prueba>
WOMPI_PUBLIC_KEY_TEST=pub_test_<valor de prueba>
WOMPI_INTEGRITY_SECRET_TEST=<valor de prueba>
WOMPI_EVENTS_SECRET_TEST=<32+ caracteres, valor local de prueba>
```

## 6. Ejecutar las 4 suites

```bash
node --test \
  "server/routes/__tests__/catastroxPaymentOrders.test.js" \
  "server/routes/__tests__/catastroxPaymentWebhook.test.js" \
  "server/routes/__tests__/catastroxDeliveryLifecycle.test.js" \
  "server/routes/__tests__/catastroxCustomerOtpAndHistory.test.js"
```

Las cuatro deben dejar de mostrar `SKIP` y ejecutar sus casos reales contra
`agrogenomax_test`/`catastrox_postgis_test`.

## 7. Teardown

```bash
docker rm -f catx-integration-pg
```

Elimina el contenedor y, con él, ambas bases (`agrogenomax_test`,
`catastrox_postgis_test`) por completo — no queda ningún dato residual en
el disco salvo que se haya montado un volumen persistente explícito (este
documento no usa ninguno).
