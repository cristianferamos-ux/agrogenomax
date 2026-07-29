-- CatastroX: órdenes de pago persistentes (Wompi) + deduplicación de webhooks.
--
-- Corrige el defecto de cobro duplicado: antes de esta migración, el backend
-- de CatastroX no persistía ningún estado de pago -- toda la decisión de
-- "¿está pagado?" vivía en localStorage del navegador, indexada por un
-- routeId aleatorio generado en cada consulta. Estas tablas son la fuente de
-- verdad server-side: un derecho de descarga depende exclusivamente de una
-- fila APPROVED aquí, verificada server-to-server contra Wompi.
--
-- Convenciones (iguales a 001_agrogenomax_core.sql): pgcrypto/gen_random_uuid(),
-- esquema public, timestamptz + updated_at con trigger, RLS habilitada sin
-- políticas permisivas (solo el rol de conexión del backend -- DATABASE_URL,
-- privilegiado / bypass RLS -- puede leer/escribir; ningún rol anon/authenticated
-- de PostgREST/Supabase tiene acceso directo a datos de pago).

create extension if not exists "pgcrypto";

create type public.catastrox_payment_order_status as enum (
  'CREATED',
  'PENDING',
  'APPROVED',
  'DECLINED',
  'VOIDED',
  'ERROR',
  'EXPIRED'
);

create table public.catastrox_payment_orders (
  id uuid primary key default gen_random_uuid(),
  -- Token opaco de 256 bits (base64url) devuelto al cliente. Nunca se expone
  -- el id interno (uuid secuencial-ish/incremental de auditoría) como
  -- identificador público.
  order_token text not null unique,
  package_id text not null check (package_id in ('basico', 'plus', 'profesional')),
  -- Identidad estable del derecho (codigoPredial normalizado + package_id) --
  -- nunca routeId/purchaseKey, que son efímeros y se guardan solo como metadato.
  codigo_predial_normalized text not null,
  route_id_original text,
  purchase_key_original text,
  wompi_reference text not null unique,
  wompi_transaction_id text unique,
  expected_amount_in_cents integer not null check (expected_amount_in_cents > 0),
  currency text not null default 'COP',
  status public.catastrox_payment_order_status not null default 'CREATED',
  customer_email_normalized text,
  payment_method_type text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz,
  webhook_received_at timestamptz,
  last_verified_at timestamptz,
  -- 'return' | 'webhook' | 'manual' -- de dónde vino la última verificación
  -- que llevó al estado actual.
  verification_source text,
  client_ip_hash text,
  user_agent_hash text,
  metadata jsonb not null default '{}'
);

-- Único APPROVED activo por predio+paquete: da idempotencia real a nivel de
-- base de datos (no solo aplicativa) -- un segundo intento de aprobar el
-- mismo predio+paquete choca contra esta restricción en vez de crear un
-- segundo derecho.
create unique index uq_catastrox_orders_approved_entitlement
  on public.catastrox_payment_orders (codigo_predial_normalized, package_id)
  where status = 'APPROVED';

-- Búsqueda de órdenes activas (CREATED/PENDING) para reutilizar en vez de
-- crear una segunda orden concurrente del mismo predio+paquete.
create index idx_catastrox_orders_active
  on public.catastrox_payment_orders (codigo_predial_normalized, package_id, created_at desc)
  where status in ('CREATED', 'PENDING');

create index idx_catastrox_orders_wompi_transaction_id
  on public.catastrox_payment_orders (wompi_transaction_id)
  where wompi_transaction_id is not null;

create table public.catastrox_payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  -- sha256 hex de una huella canónica del evento (event + transaction id +
  -- reference + timestamp + checksum de Wompi) -- nunca el body completo.
  -- Único: garantiza que un mismo evento reenviado (replay/reintento de
  -- Wompi) nunca se procese dos veces.
  event_fingerprint text not null unique,
  wompi_transaction_id text,
  wompi_reference text,
  event_type text not null,
  processed_at timestamptz not null default now()
);

-- create or replace (no "if not exists"): si 001_agrogenomax_core.sql ya
-- definió esta función en el ambiente donde se aplique esta migración, se
-- reemplaza por una definición idéntica (mismo cuerpo) -- nunca se asume su
-- existencia previa, esta migración es autocontenida.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger catastrox_payment_orders_touch
  before update on public.catastrox_payment_orders
  for each row execute function public.touch_updated_at();

alter table public.catastrox_payment_orders enable row level security;
alter table public.catastrox_payment_webhook_events enable row level security;
-- Sin políticas permisivas a propósito: estas tablas solo son accesibles vía
-- el rol de conexión de DATABASE_URL usado por server/db.js (privilegiado,
-- fuera del alcance de RLS de PostgREST/Supabase). Ningún rol anon/authenticated
-- puede leer ni escribir datos de pago directamente.
