-- CatastroX: modelo comercial definitivo -- N compras por predio/paquete,
-- comprador, facturación electrónica preparada, entrega por correo, sesión
-- de recuperación multiorden.
--
-- Corrige un defecto de diseño de la migración 002/003: el índice único
-- "un solo APPROVED por predio+paquete" implementaba, sin que se hubiera
-- pedido así, la política de "un derecho global por predio" -- la política
-- comercial real es que el mismo predio y el mismo paquete pueden
-- comprarse N veces (compradores distintos o el mismo), cada compra es una
-- orden independiente con su propio comprador. Este archivo retira esa
-- restricción y añade el modelo de datos que nunca existió: comprador,
-- perfil de facturación por orden, sesión de recuperación multiorden,
-- trabajos de entrega y de facturación electrónica.
--
-- Aditiva sobre 002/003: ningún "drop table", ninguna pérdida de datos.
-- Las columnas recovery_token_* de 003 quedan presentes pero DEPRECADAS --
-- el código nuevo usa catastrox_recovery_sessions en su lugar.

-- --------------------------------------------------------------------
-- 1) Retirar la exclusividad global de APPROVED por predio+paquete
-- --------------------------------------------------------------------
-- La unidad comercial pasa a ser la orden (payment_order_id), no
-- canonical_predio_id+package_id. wompi_reference, wompi_transaction_id y
-- order_token YA son UNIQUE desde 002 -- se mantienen sin cambios (siguen
-- impidiendo que una misma transacción/reference/token se reutilice entre
-- órdenes distintas, que es la única unicidad que corresponde aquí).
drop index if exists public.uq_catastrox_orders_approved_entitlement;

create index if not exists idx_catastrox_orders_predio_package_status
  on public.catastrox_payment_orders (canonical_predio_id, package_id, status);

-- codigo_predial_normalized nace NOT NULL en 002 porque, en ese momento, el
-- checkout siempre exigía un código predial válido. Desde el Bloque 4 de
-- esta fase, canonical_predio_id admite un respaldo (fuente:versión:id de
-- fila) para predios sin código conocido -- codigo_predial_normalized pasa
-- a ser metadato opcional, nunca la llave de nada.
alter table public.catastrox_payment_orders
  alter column codigo_predial_normalized drop not null;

-- --------------------------------------------------------------------
-- 2) Comprador (Bloque 2)
-- --------------------------------------------------------------------
create type public.catastrox_customer_type as enum ('NATURAL', 'JURIDICA');

create table public.catastrox_customers (
  id uuid primary key default gen_random_uuid(),
  customer_type public.catastrox_customer_type not null,
  first_name text,
  last_name text,
  legal_name text,
  document_type text not null,
  -- Cifrado AES-256-GCM en capa de aplicación (server/services/catastrox/piiCrypto.js)
  -- -- la clave nunca vive en Postgres, solo en la variable de entorno del backend.
  document_number_encrypted text not null,
  -- HMAC-SHA256 (secreto propio, distinto del de cifrado) -- permite buscar
  -- por documento sin desencriptar y sin ser un hash simple enumerable.
  document_number_hash text not null,
  email_normalized text not null,
  phone_encrypted text,
  country_code text not null,
  department text,
  city text,
  address_encrypted text,
  email_verified_at timestamptz,
  privacy_consent_at timestamptz not null,
  terms_accepted_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catastrox_customers_natural_requires_name
    check (customer_type <> 'NATURAL' or (first_name is not null and last_name is not null)),
  constraint catastrox_customers_juridica_requires_legal_name
    check (customer_type <> 'JURIDICA' or legal_name is not null)
);

-- Único: permite upsert real por documento (un mismo comprador que vuelve
-- a comprar actualiza su registro en vez de duplicarlo) -- ver
-- server/services/catastrox/customerRepository.js.
create unique index uq_catastrox_customers_document_hash on public.catastrox_customers (document_number_hash);
create index idx_catastrox_customers_email on public.catastrox_customers (email_normalized);

create trigger catastrox_customers_touch
  before update on public.catastrox_customers
  for each row execute function public.touch_updated_at();

-- --------------------------------------------------------------------
-- 3) Órdenes: comprador + idempotencia de intento de compra
-- --------------------------------------------------------------------
alter table public.catastrox_payment_orders
  add column customer_id uuid references public.catastrox_customers(id),
  add column idempotency_key text;

-- Único cuando está presente: una orden CREATED/PENDING con la misma
-- idempotency_key (comprador+predio+paquete+ventana corta) se reutiliza en
-- vez de crear una segunda -- protege contra doble clic/reintento técnico,
-- nunca contra una segunda compra explícita (esa siempre crea una orden
-- nueva, con una idempotency_key de una ventana temporal distinta).
create unique index uq_catastrox_orders_idempotency_key
  on public.catastrox_payment_orders (idempotency_key)
  where idempotency_key is not null;

create index idx_catastrox_orders_customer on public.catastrox_payment_orders (customer_id);

-- --------------------------------------------------------------------
-- 4) Perfil de facturación por orden (Bloque 3) -- instantánea 1:1
-- --------------------------------------------------------------------
create type public.catastrox_billing_status as enum ('NOT_REQUESTED', 'PENDING', 'ISSUED', 'FAILED', 'CANCELLED');

create table public.catastrox_billing_profiles (
  id uuid primary key default gen_random_uuid(),
  payment_order_id uuid not null unique references public.catastrox_payment_orders(id),
  customer_type public.catastrox_customer_type not null,
  billing_name text not null,
  document_type text not null,
  document_number_encrypted text not null,
  document_number_hash text not null,
  billing_email text not null,
  phone_encrypted text,
  address_encrypted text,
  city text,
  department text,
  country_code text not null,
  -- Campos futuros específicos del proveedor de facturación electrónica
  -- que CRH conecte más adelante -- validados en capa de aplicación antes
  -- de insertar (nunca un objeto libre sin control de forma/tamaño).
  extra_fields jsonb not null default '{}',
  billing_status public.catastrox_billing_status not null default 'NOT_REQUESTED',
  electronic_invoice_id text,
  electronic_invoice_number text,
  electronic_invoice_provider text,
  electronic_invoice_issued_at timestamptz,
  electronic_invoice_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger catastrox_billing_profiles_touch
  before update on public.catastrox_billing_profiles
  for each row execute function public.touch_updated_at();

-- --------------------------------------------------------------------
-- 5) Sesión de recuperación multiorden (Bloque 7) -- reemplaza el token
--    por-orden de la migración 003 (columnas recovery_token_* quedan
--    deprecadas, no se tocan/eliminan).
-- --------------------------------------------------------------------
create table public.catastrox_recovery_sessions (
  id uuid primary key default gen_random_uuid(),
  session_token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table public.catastrox_recovery_session_orders (
  recovery_session_id uuid not null references public.catastrox_recovery_sessions(id),
  payment_order_id uuid not null references public.catastrox_payment_orders(id),
  linked_at timestamptz not null default now(),
  primary key (recovery_session_id, payment_order_id)
);

create index idx_recovery_session_orders_order on public.catastrox_recovery_session_orders (payment_order_id);

-- --------------------------------------------------------------------
-- 6) Entrega por correo (Bloque 8/9/10) -- 1 orden -> N intentos/reenvíos
-- --------------------------------------------------------------------
create type public.catastrox_delivery_job_status as enum (
  'WAITING_FOR_PAYMENT',
  'QUEUED',
  'GENERATING',
  'READY',
  'SENDING',
  'SENT',
  'DELIVERED',
  'FAILED',
  'EXPIRED'
);

create table public.catastrox_delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  payment_order_id uuid not null references public.catastrox_payment_orders(id),
  customer_id uuid references public.catastrox_customers(id),
  delivery_email text not null,
  status public.catastrox_delivery_job_status not null default 'WAITING_FOR_PAYMENT',
  attempt_count integer not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_attempt_at timestamptz,
  next_retry_at timestamptz,
  last_error_code text,
  provider_message_id text,
  delivered_at timestamptz
);

create index idx_catastrox_delivery_jobs_order on public.catastrox_delivery_jobs (payment_order_id);
create index idx_catastrox_delivery_jobs_status on public.catastrox_delivery_jobs (status, next_retry_at);

create table public.catastrox_deliverables (
  id uuid primary key default gen_random_uuid(),
  delivery_job_id uuid not null references public.catastrox_delivery_jobs(id),
  file_type text not null,
  -- Ubicación privada (nunca una URL pública) -- null hasta que exista
  -- generación server-side real (ver server/services/catastrox/deliveryJobService.js).
  storage_key text,
  content_hash text,
  byte_size integer,
  created_at timestamptz not null default now()
);

create index idx_catastrox_deliverables_job on public.catastrox_deliverables (delivery_job_id);

-- --------------------------------------------------------------------
-- 7) Facturación electrónica (Bloque 11) -- interfaz preparada, sin
--    proveedor conectado todavía.
-- --------------------------------------------------------------------
create type public.catastrox_invoice_job_status as enum ('NOT_REQUESTED', 'PENDING', 'ISSUED', 'FAILED', 'CANCELLED');

create table public.catastrox_invoice_jobs (
  id uuid primary key default gen_random_uuid(),
  payment_order_id uuid not null references public.catastrox_payment_orders(id),
  status public.catastrox_invoice_job_status not null default 'NOT_REQUESTED',
  attempt_count integer not null default 0,
  provider text,
  provider_invoice_id text,
  provider_invoice_number text,
  issued_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_catastrox_invoice_jobs_order on public.catastrox_invoice_jobs (payment_order_id);

create trigger catastrox_invoice_jobs_touch
  before update on public.catastrox_invoice_jobs
  for each row execute function public.touch_updated_at();

-- --------------------------------------------------------------------
-- 8) Verificación de correo por código de un solo uso (Bloque 5)
-- --------------------------------------------------------------------
create table public.catastrox_email_verifications (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.catastrox_customers(id),
  code_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  attempt_count integer not null default 0
);

create index idx_catastrox_email_verifications_customer
  on public.catastrox_email_verifications (customer_id, created_at desc);

-- --------------------------------------------------------------------
-- 9) RLS -- sin políticas permisivas, mismo criterio que 002/003: solo el
--    rol de conexión de DATABASE_URL (server/db.js) accede a estas tablas.
-- --------------------------------------------------------------------
alter table public.catastrox_customers enable row level security;
alter table public.catastrox_billing_profiles enable row level security;
alter table public.catastrox_recovery_sessions enable row level security;
alter table public.catastrox_recovery_session_orders enable row level security;
alter table public.catastrox_delivery_jobs enable row level security;
alter table public.catastrox_deliverables enable row level security;
alter table public.catastrox_invoice_jobs enable row level security;
alter table public.catastrox_email_verifications enable row level security;
