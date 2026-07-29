-- CatastroX: credencial de recuperación (posesión legítima), identidad
-- canónica de predio, y máquina de estados transaccional del webhook.
--
-- Corrige dos defectos encontrados en la revisión de seguridad de la
-- migración 002:
--  1) POST /entitlements/check autorizaba solo con codigoPredial+packageId
--     -- el código predial no es secreto, así que cualquiera que lo
--     conociera podía reutilizar el pago de otro cliente. Este archivo
--     agrega la credencial de posesión (recovery_token_hash) que el backend
--     exige antes de reconocer un pago como propio.
--  2) El webhook podía marcar un evento como "ya visto" antes de confirmar
--     que la orden transicionó -- un fallo a mitad de camino perdía el
--     webhook para siempre. Este archivo agrega el estado explícito
--     (RECEIVED/PROCESSING/PROCESSED/FAILED) que la nueva lógica
--     transaccional en paymentOrderRepository.js necesita.
--
-- Aditiva sobre 002: ningún "drop table", ninguna pérdida de datos. La
-- única fila real ya insertada (backfill de la transacción Sandbox
-- aprobada, ver scripts/catastrox/backfill-known-approved-order.mjs) se
-- migra de forma segura más abajo.

-- --------------------------------------------------------------------
-- 1) Identidad canónica del predio (Bloque 3/4/5 del pedido)
-- --------------------------------------------------------------------
-- Reemplaza codigo_predial_normalized como llave de entitlement.
-- codigo_predial_normalized se conserva (columna existente, sin tocar) como
-- dato de referencia/legado; canonical_predio_id es la llave nueva usada
-- por el índice único y por las consultas de checkout/entitlement.
alter table public.catastrox_payment_orders
  add column canonical_predio_id text;

-- Backfill: para toda fila ya existente, la identidad canónica coincide con
-- el código predial normalizado ya guardado (hoy todas las órdenes reales
-- se crearon exigiendo un código predial válido de 20/30 dígitos -- no hay
-- ninguna fila que dependiera del esquema de respaldo
-- fuente:version:terrenoId, que solo aplica a predios sin código conocido).
update public.catastrox_payment_orders
   set canonical_predio_id = codigo_predial_normalized
 where canonical_predio_id is null;

alter table public.catastrox_payment_orders
  alter column canonical_predio_id set not null;

drop index if exists public.uq_catastrox_orders_approved_entitlement;
create unique index uq_catastrox_orders_approved_entitlement
  on public.catastrox_payment_orders (canonical_predio_id, package_id)
  where status = 'APPROVED';

drop index if exists public.idx_catastrox_orders_active;
create index idx_catastrox_orders_active
  on public.catastrox_payment_orders (canonical_predio_id, package_id, created_at desc)
  where status in ('CREATED', 'PENDING');

-- --------------------------------------------------------------------
-- 2) Credencial de recuperación / posesión legítima (Bloque 1)
-- --------------------------------------------------------------------
-- Nunca se guarda el token en texto plano -- solo su hash SHA256 (el token
-- en sí tiene 256 bits de entropía propia generados con crypto.randomBytes;
-- no se añade un "pepper" adicional porque introduciría un secreto más que
-- rotar/gestionar sin aportar resistencia real frente a fuerza bruta dado
-- ese tamaño de espacio de claves -- decisión documentada, no omisión).
alter table public.catastrox_payment_orders
  add column recovery_token_hash text,
  add column recovery_token_version integer not null default 1,
  add column recovery_token_revoked_at timestamptz,
  add column recovery_token_expires_at timestamptz;

-- Único mientras esté vigente (no revocado): permite rotar/revocar un token
-- y emitir uno nuevo para la misma orden sin chocar con el hash antiguo ya
-- revocado. Ninguna fila con hash nulo (órdenes creadas antes de esta
-- migración, o antes de que /checkout emitiera el cookie) participa del
-- índice.
create unique index uq_catastrox_orders_recovery_token_hash
  on public.catastrox_payment_orders (recovery_token_hash)
  where recovery_token_hash is not null and recovery_token_revoked_at is null;

-- --------------------------------------------------------------------
-- 3) Máquina de estados transaccional del webhook (Bloque 2)
-- --------------------------------------------------------------------
create type public.catastrox_webhook_event_status as enum (
  'RECEIVED',
  'PROCESSING',
  'PROCESSED',
  'FAILED'
);

-- processed_at ya existe desde 002 (not null default now()) -- se ajusta
-- más abajo, no se vuelve a declarar aquí.
alter table public.catastrox_payment_webhook_events
  add column status public.catastrox_webhook_event_status not null default 'RECEIVED',
  add column attempt_count integer not null default 1,
  add column first_received_at timestamptz not null default now(),
  add column last_attempt_at timestamptz not null default now(),
  -- Código corto y saneado (p. ej. "WOMPI_FETCH_FAILED", "DB_ERROR") --
  -- nunca el mensaje de error completo ni un stack trace.
  add column last_error_code text;

-- Backfill: las filas ya existentes (insertadas por la lógica anterior, no
-- transaccional) representan eventos que en su momento sí completaron el
-- ciclo de principio a fin bajo esa implementación -- se migran como
-- PROCESSED, usando su processed_at original como referencia también para
-- first_received_at/last_attempt_at (no hay mejor dato disponible).
update public.catastrox_payment_webhook_events
   set status = 'PROCESSED',
       first_received_at = processed_at,
       last_attempt_at = processed_at
 where status = 'RECEIVED';

-- A partir de esta migración, processed_at representa el momento en que el
-- evento terminó de procesarse de verdad (lo fija la transacción del
-- webhook al llegar a PROCESSED) -- ya no "cuándo se insertó la fila". Se
-- quita el default now() (las filas nuevas nacen sin procesar) y se
-- permite NULL mientras el evento esté RECEIVED/PROCESSING/FAILED.
alter table public.catastrox_payment_webhook_events
  alter column processed_at drop default,
  alter column processed_at drop not null;
