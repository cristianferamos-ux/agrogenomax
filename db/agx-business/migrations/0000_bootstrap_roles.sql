-- SPRINT-3B1-BUSINESS-DB-FOUNDATION
--
-- Bootstrap de roles para Postgres-AGX-Business (NO Postgres-AGX auth, NO
-- el Postgres legacy de producción). Separado de 0001_business_foundation.sql
-- a propósito: CREATE ROLE normalmente exige el superusuario que Railway
-- entrega al aprovisionar el servicio -- el mismo patrón ya usado para
-- Postgres-AGX (roles creados fuera de las migraciones versionadas, ver
-- db/agx/migrations/README.md). Ejecutar este archivo UNA sola vez, con el
-- superusuario, antes de 0001.
--
-- agx_owner: nologin, dueño de los objetos (mismo patrón que agx_owner en
-- Postgres-AGX auth).
-- agx_app: login, rol de aplicación de mínimo privilegio -- exactamente el
-- rol que server/db/agxBusinessPool.js ya espera vía
-- AGX_BUSINESS_DATABASE_URL. Solo obtiene privilegios explícitos sobre
-- agx.predios/agx.predio_snapshots_catastrales en 0001 -- nunca
-- CREATEDB/CREATEROLE/SUPERUSER, nunca BYPASSRLS.
--
-- Idempotente: seguro de re-ejecutar (DO block con excepción controlada en
-- vez de asumir que CREATE ROLE soporta IF NOT EXISTS, que no existe en
-- PostgreSQL).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'agx_owner') then
    create role agx_owner nologin;
  end if;
end
$$;

-- La contraseña de agx_app NUNCA vive en este archivo -- ni como valor
-- real, ni como placeholder de ejemplo -- para no introducir ningún
-- literal de contraseña en el historial de Git, ni siquiera uno marcado
-- como "cambiar esto". Se inyecta en tiempo de ejecución vía la variable
-- psql `agx_app_password` (sintaxis `:'nombre'`, sustitución de texto del
-- cliente psql ANTES de enviar la sentencia al servidor).
--
-- IMPORTANTE: la sustitución `:'nombre'` de psql NO se aplica dentro de
-- dollar-quoting ($$ ... $$) -- por eso este bloque, a diferencia del de
-- agx_owner arriba, NO usa `DO $$ ... $$` con `IF NOT EXISTS` en PL/pgSQL.
-- La idempotencia se logra con los metacomandos `\gset`/`\if` de psql
-- (evaluados enteramente por el cliente, fuera de cualquier dollar-quote),
-- que sí permiten combinarse con la sustitución de variable.
--
-- Ejecución real (Railway/producción): el operador provee la contraseña
-- real generada para ese entorno. Entorno local desechable: ver
-- README.md de este directorio para el comando completo (genera un valor
-- aleatorio en el momento, nunca lo escribe en un archivo).
--
--   psql "$SUPERUSER_URL" -v agx_app_password="$AGX_APP_PASSWORD" \
--     -v ON_ERROR_STOP=1 -f db/agx-business/migrations/0000_bootstrap_roles.sql
--
-- Si agx_app_password no se provee, psql falla la sustitución de forma
-- visible (variable indefinida) en vez de crear un rol sin contraseña o
-- con un valor por defecto inseguro.
select not exists (select 1 from pg_roles where rolname = 'agx_app') as should_create_agx_app \gset
\if :should_create_agx_app
  create role agx_app login password :'agx_app_password';
\else
  \echo 'agx_app ya existe -- se omite la creación (la contraseña existente no se modifica aquí; para rotarla usar ALTER ROLE por separado).'
\endif
