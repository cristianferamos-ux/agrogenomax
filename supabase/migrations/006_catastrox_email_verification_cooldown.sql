-- EMAIL_PROVIDER_002 (cierre de protección backend, revisión de cooldown OTP):
-- el frontend aplicaba un cooldown de 30s entre reenvíos de OTP
-- (CatastroXOtpVerification.jsx), pero POST /customers no tenía ninguna
-- protección de backend equivalente -- un cliente que llamara al endpoint
-- directamente (sin pasar por el frontend) podía disparar tantos envíos
-- reales a Resend como el rate limit general por IP (customerLimiter,
-- server/middleware/rateLimit.js) lo permitiera, sin ningún límite por
-- comprador/correo.
--
-- Esta migración agrega una tabla de estado de un registro por comprador,
-- separada de catastrox_email_verifications a propósito: esta última solo
-- debe contener códigos REALMENTE entregados (política establecida en la
-- revisión de reenvío anterior -- ver docs/catastrox/EMAIL_PROVIDER_001.md
-- §13); mezclar en ella un estado de "reserva breve mientras se intenta el
-- envío" habría reabierto el mismo riesgo que esa revisión cerró (una fila
-- "reservada" podría, por error, volverse verificable antes de confirmar la
-- entrega). catastrox_customer_otp_state, en cambio, nunca contiene un
-- código ni nada verificable -- solo dos marcas de tiempo por comprador.
create table public.catastrox_customer_otp_state (
  customer_id uuid primary key references public.catastrox_customers(id),
  -- Último envío CONFIRMADO como entregado (o development/test, donde no
  -- hay entrega real que confirmar) -- única fuente del cooldown de 30s.
  -- Nunca se actualiza con un intento fallido.
  last_delivered_at timestamptz,
  -- Reserva breve: se marca justo antes de intentar el envío real (dentro
  -- de la misma transacción corta que hace el chequeo, vía
  -- SELECT ... FOR UPDATE -- nunca mientras se mantiene abierta una llamada
  -- HTTP al proveedor de correo) y se libera (NULL) apenas se conoce el
  -- resultado del envío, sin importar si fue exitoso. Un valor más viejo
  -- que el TTL de reserva (20s, server/services/catastrox/customerRepository.js)
  -- se trata como abandonado -- nunca bloquea indefinidamente ante un
  -- proceso caído a mitad de un envío.
  reserved_at timestamptz
);

create index idx_catastrox_customer_otp_state_last_delivered
  on public.catastrox_customer_otp_state (last_delivered_at);

alter table public.catastrox_customer_otp_state enable row level security;
