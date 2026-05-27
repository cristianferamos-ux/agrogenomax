# AgroGenomaX Supabase

Esta carpeta deja lista la base SaaS multi-tenant para AgroGenomaX.

## Crear el proyecto

1. Entra a Supabase y crea un proyecto en el plan gratuito.
2. Copia `Project URL` y `anon public key`.
3. Agrega estas variables al entorno de Cloudflare Pages:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_AGX_PUBLIC_APP_URL`
4. Ejecuta `supabase/migrations/001_agrogenomax_core.sql` en el SQL Editor.
5. Ejecuta `supabase/seed.sql`.

## Propiedad y accesos

El propietario real del dashboard, backups, API keys, Storage y Auth debe ser tu usuario de Supabase. Por seguridad, no se debe entregar la `service_role key` al frontend.

## Backups

Supabase incluye retencion y recuperacion segun el plan vigente. En plan gratuito la estrategia recomendada es export periodico con `pg_dump` o backups gestionados cuando se suba de plan.

## Seguridad

La migracion activa RLS en todas las tablas operativas, separa datos por `organization_id`, define rol `SUPER_ADMIN` y mantiene auditoria en `audit_logs`.
