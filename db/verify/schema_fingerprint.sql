-- Huella de esquema AGX (HARDENING PRE-SANIDAD, PR A).
--
-- SOLO CATÁLOGO: no lee ninguna fila de tablas de negocio ni de identidad.
-- Emite una línea normalizada y ordenada por objeto para poder comparar
-- con `diff` dos bases (producción vs base desechable reconstruida desde
-- migraciones, u origen vs restore). Ejecutar con:
--
--   psql "<url>" -X -q -v ON_ERROR_STOP=1 -v schemas=agx -f db/verify/schema_fingerprint.sql
--
-- `schemas` es una lista separada por comas (por defecto `agx`). Ej.:
-- `-v schemas=agx,agx_meta`. Recomendado en producción con
-- PGOPTIONS='-c default_transaction_read_only=on'.
\set ON_ERROR_STOP 1
\if :{?schemas}
\else
  \set schemas agx
\endif
\pset pager off
\pset tuples_only on
\pset format unaligned

select set_config('agx.fp_schemas', :'schemas', false) as _fp_schemas \gset

-- El bloque entre los marcadores fp-query lo reutiliza también
-- .tools/agx-migrate.mjs (certificación del baseline dentro de la misma
-- transacción que crea el ledger). No poner `;` dentro del bloque.
-- <fp-query>
with s as (
  select n.oid, n.nspname
    from pg_namespace n
   where n.nspname = any (string_to_array(current_setting('agx.fp_schemas'), ','))
),
rels as (
  select c.*, s.nspname
    from pg_class c join s on s.oid = c.relnamespace
)
-- Saltos de línea dentro de un valor se escapan: una línea = un objeto.
select replace(replace(line, E'\r', '\r'), E'\n', '\n') as line from (
  select 'extension|' || e.extname || '|' || e.extversion || '|' || en.nspname as line
    from pg_extension e join pg_namespace en on en.oid = e.extnamespace
  union all
  select 'schema|' || s.nspname || '|owner=' || pg_get_userbyid(n.nspowner) || '|acl=' || coalesce(n.nspacl::text, '-')
    from s join pg_namespace n on n.oid = s.oid
  union all
  select 'relation|' || r.nspname || '.' || r.relname || '|kind=' || r.relkind::text::text
         || '|owner=' || pg_get_userbyid(r.relowner)
         || '|rls=' || r.relrowsecurity || '|force=' || r.relforcerowsecurity
         || '|acl=' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(r.relacl) a), '-')
    from rels r where r.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
  union all
  select 'column|' || r.nspname || '.' || r.relname || '.' || a.attname
         || '|' || format_type(a.atttypid, a.atttypmod)
         || '|notnull=' || a.attnotnull
         || '|default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
         || '|identity=' || coalesce(nullif(a.attidentity::text, ''), '-')
         || '|generated=' || coalesce(nullif(a.attgenerated::text, ''), '-')
         || '|acl=' || coalesce((select string_agg(x::text, ',' order by x::text) from unnest(a.attacl) x), '-')
    from rels r
    join pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where r.relkind in ('r', 'p', 'v', 'm', 'f')
  union all
  select 'constraint|' || r.nspname || '.' || r.relname || '|' || con.conname || '|' || con.contype::text
         || '|validated=' || con.convalidated || '|' || pg_get_constraintdef(con.oid)
    from pg_constraint con join rels r on r.oid = con.conrelid
  union all
  select 'index|' || r.nspname || '.' || i.relname || '|' || pg_get_indexdef(i.oid)
    from pg_index x join pg_class i on i.oid = x.indexrelid join rels r on r.oid = x.indrelid
  union all
  select 'policy|' || p.schemaname || '.' || p.tablename || '|' || p.policyname
         || '|' || p.permissive || '|' || p.cmd || '|roles=' || array_to_string(p.roles, ',')
         || '|using=' || coalesce(p.qual, '-') || '|check=' || coalesce(p.with_check, '-')
    from pg_policies p
   where p.schemaname = any (string_to_array(current_setting('agx.fp_schemas'), ','))
  union all
  select 'function|' || s.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
         || '|owner=' || pg_get_userbyid(p.proowner)
         || '|secdef=' || p.prosecdef
         || '|config=' || coalesce(array_to_string(p.proconfig, ';'), '-')
         || '|acl=' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a), '-')
         || '|src_md5=' || md5(coalesce(p.prosrc, ''))
    from pg_proc p join s on s.oid = p.pronamespace
  union all
  select 'trigger|' || r.nspname || '.' || r.relname || '|' || t.tgname || '|enabled=' || t.tgenabled::text
         || '|' || pg_get_triggerdef(t.oid)
    from pg_trigger t join rels r on r.oid = t.tgrelid
   where not t.tgisinternal
  union all
  select 'role|' || rolname || '|super=' || rolsuper || '|inherit=' || rolinherit
         || '|createrole=' || rolcreaterole || '|createdb=' || rolcreatedb
         || '|login=' || rolcanlogin || '|replication=' || rolreplication
         || '|bypassrls=' || rolbypassrls
    from pg_roles
   where rolname like 'agx\_%'
  union all
  select 'membership|' || pg_get_userbyid(m.member) || '|in=' || pg_get_userbyid(m.roleid)
    from pg_auth_members m
   where pg_get_userbyid(m.member) like 'agx\_%' or pg_get_userbyid(m.roleid) like 'agx\_%'
  union all
  select 'database_acl|' || coalesce((select string_agg(a::text, ',' order by a::text)
                                        from unnest(d.datacl) a
                                       where a::text ~ '(^|[,{])(agx_[a-z_]+)?='), '-')
    from pg_database d where d.datname = current_database()
  union all
  select 'default_acl|' || pg_get_userbyid(da.defaclrole) || '|' || coalesce(n.nspname, '*')
         || '|' || da.defaclobjtype::text || '|' || coalesce(da.defaclacl::text, '-')
    from pg_default_acl da left join pg_namespace n on n.oid = da.defaclnamespace
) fp
-- </fp-query>
order by line collate "C";
