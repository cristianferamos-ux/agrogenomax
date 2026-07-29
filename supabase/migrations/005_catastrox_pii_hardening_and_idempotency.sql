-- CatastroX: endurecimiento de PII (correo/nombres/ciudad/departamento
-- cifrados en reposo) + unicidad de jobs de entrega/factura por orden.
--
-- Aditiva sobre 002/003/004: ningún "drop table", ninguna pérdida de
-- datos. Las columnas en texto plano (email_normalized, first_name,
-- last_name, legal_name, department, city, billing_name, billing_email,
-- delivery_email) quedan presentes pero DEPRECADAS -- el código nuevo ya
-- no las escribe (ver customerRepository.js/paymentOrderRepository.js/
-- deliveryJobService.js), solo las columnas *_encrypted/*_hash. No se
-- eliminan aquí porque hacerlo comprometería el rollback; una migración
-- posterior, después de correr el backfill de cifrado
-- (scripts/catastrox/backfill-encrypt-existing-pii.mjs) y verificar los
-- valores, puede retirarlas.

-- --------------------------------------------------------------------
-- 1) catastrox_customers: correo/nombres/ciudad/departamento cifrados
-- --------------------------------------------------------------------
alter table public.catastrox_customers
  add column first_name_encrypted text,
  add column last_name_encrypted text,
  add column legal_name_encrypted text,
  add column email_encrypted text,
  -- HMAC-SHA256 (mismo secreto CATASTROX_PII_HASH_SECRET que
  -- document_number_hash) -- permite upsert/búsqueda por correo sin
  -- desencriptar y sin ser un hash simple enumerable.
  add column email_hash text,
  add column department_encrypted text,
  add column city_encrypted text;

-- email_normalized nace NOT NULL en 004 -- el código nuevo deja de
-- escribirla, por lo que debe poder quedar NULL en filas nuevas.
alter table public.catastrox_customers
  alter column email_normalized drop not null;

-- Índice de búsqueda por email_hash (equivalente cifrado de
-- idx_catastrox_customers_email, que queda para las filas legadas).
create index if not exists idx_catastrox_customers_email_hash on public.catastrox_customers (email_hash);

-- Los CHECK de 004 exigían first_name/last_name/legal_name en texto plano
-- -- el código nuevo ya no los escribe (solo *_encrypted), así que deben
-- validar la columna cifrada en su lugar. Mismo nivel de garantía, sobre
-- la columna que el código nuevo realmente usa.
alter table public.catastrox_customers
  drop constraint catastrox_customers_natural_requires_name,
  drop constraint catastrox_customers_juridica_requires_legal_name;

alter table public.catastrox_customers
  add constraint catastrox_customers_natural_requires_name
    check (customer_type <> 'NATURAL' or (first_name_encrypted is not null and last_name_encrypted is not null) or (first_name is not null and last_name is not null)),
  add constraint catastrox_customers_juridica_requires_legal_name
    check (customer_type <> 'JURIDICA' or legal_name_encrypted is not null or legal_name is not null);

-- --------------------------------------------------------------------
-- 2) catastrox_billing_profiles: nombre/correo/ciudad/departamento cifrados
-- --------------------------------------------------------------------
alter table public.catastrox_billing_profiles
  add column billing_name_encrypted text,
  add column billing_email_encrypted text,
  add column billing_email_hash text,
  add column city_encrypted text,
  add column department_encrypted text;

alter table public.catastrox_billing_profiles
  alter column billing_name drop not null,
  alter column billing_email drop not null;

create index if not exists idx_catastrox_billing_profiles_email_hash
  on public.catastrox_billing_profiles (billing_email_hash);

-- --------------------------------------------------------------------
-- 3) catastrox_delivery_jobs: correo de entrega cifrado
-- --------------------------------------------------------------------
alter table public.catastrox_delivery_jobs
  add column delivery_email_encrypted text,
  add column delivery_email_hash text;

alter table public.catastrox_delivery_jobs
  alter column delivery_email drop not null;

-- --------------------------------------------------------------------
-- 4) Unicidad de jobs de entrega/factura por orden (defecto corregido:
--    nada impedía hoy insertar dos filas para la misma orden si el
--    código de creación llegara a invocarse dos veces; el diseño pasa de
--    "N intentos = N filas" a "1 fila principal por orden, los reintentos
--    actualizan attempt_count/last_attempt_at/next_retry_at/status en la
--    misma fila" -- ver deliveryJobService.js/invoiceJobService.js).
--    catastrox_invoice_jobs ya era 1:1 en la práctica (createInvoiceJobForOrder
--    se llama una sola vez, al aprobar) -- esto lo hace explícito y lo
--    protege también a nivel de base de datos.
-- --------------------------------------------------------------------
alter table public.catastrox_delivery_jobs
  add constraint uq_catastrox_delivery_jobs_order unique (payment_order_id);

alter table public.catastrox_invoice_jobs
  add constraint uq_catastrox_invoice_jobs_order unique (payment_order_id);
