# AgroGenomaX SaaS Architecture

## Capas

- Frontend: Vite + React + Tailwind + Framer Motion.
- PWA: service worker propio, cache runtime, fallback de navegacion y cola offline IndexedDB.
- Backend: Supabase Auth, PostgREST, Storage y PostgreSQL.
- Seguridad: JWT, RLS, roles por tenant, storage privado y auditoria.
- Multi-tenant: `organization_id` en tablas operativas.

## Roles

- `SUPER_ADMIN`: visibilidad global y auditoria.
- `ADMIN_FINCA`: administra fincas, usuarios y datos de su empresa.
- `VETERINARIO`: sanidad, tratamientos, reproduccion y archivos clinicos.
- `OPERARIO`: captura datos operativos, pesos, movimientos y eventos.
- `CONSULTOR`: lectura y reportes.
- `INVITADO`: lectura limitada.

## Offline-first

La app mantiene una cola local `agrogenomax-offline/sync_queue` en IndexedDB. Cuando Supabase no esta configurado o el dispositivo esta offline, los registros se guardan como mutaciones pendientes. La siguiente fase debe agregar una rutina de sincronizacion autenticada por usuario.

## QR

La UI incluye generacion descargable en SVG sin paquetes externos para mantener el build actual. Para produccion se recomienda instalar:

- `react-qr-code`
- `qrcode`
- `html5-qrcode`

## Supabase

Ejecutar:

1. `supabase/migrations/001_agrogenomax_core.sql`
2. `supabase/seed.sql`

Variables Cloudflare Pages:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_AGX_PUBLIC_APP_URL`

## Pendientes para produccion real

- Crear el proyecto Supabase en la cuenta del propietario.
- Configurar SMTP/Auth providers.
- Crear usuario inicial y asignar `SUPER_ADMIN`.
- Automatizar sincronizacion de IndexedDB contra Supabase con usuario autenticado.
- Integrar escaner QR con `html5-qrcode`.
- Crear edge functions para PDF de etiquetas, notificaciones y backups exportables.
