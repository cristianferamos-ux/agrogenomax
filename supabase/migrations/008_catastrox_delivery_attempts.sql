-- CATX-DELIVERY-OBSERVABILITY-001: historial de intentos de entrega, para
-- que un fallo futuro quede auditable sin depender de logs efímeros de
-- Railway. catastrox_delivery_jobs sigue siendo el estado ACTUAL del job
-- (una fila por orden) -- esta tabla es el historial INMUTABLE de cada
-- intento individual (una fila por intento, nunca se sobrescribe ni se
-- borra). No reemplaza nada existente, es puramente aditiva.
--
-- Motivación real (incidente auditado): un primer intento automático falló
-- silenciosamente (el error solo vivía en last_error_code, que un
-- reintento exitoso posterior sobrescribe con NULL) y no había forma de
-- reconstruir, después del hecho, cuántos intentos hubo ni qué falló en
-- cada uno.

create table public.catastrox_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  delivery_job_id uuid not null references public.catastrox_delivery_jobs(id),
  attempt_number integer not null,
  -- Mismos valores que catastrox_delivery_jobs.status en el momento en que
  -- este intento terminó (o 'RUNNING' mientras está en curso) -- se
  -- reutiliza el mismo vocabulario (QUEUED/GENERATING/READY/SENDING/SENT/
  -- FAILED) en vez de crear un enum paralelo que pueda divergir.
  status text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_code text,
  error_message text,
  -- Nulo mientras el intento no haya llegado a generar/reutilizar un
  -- deliverable (p.ej. si falla durante MAP_RENDER_FAILED, antes de
  -- cualquier INSERT en catastrox_deliverables).
  deliverable_id uuid references public.catastrox_deliverables(id),
  provider_message_id text,
  byte_size integer,
  content_hash text,
  -- Contexto adicional no estructurado (p.ej. detalle de reintentos de
  -- teselas) -- nunca PII ni geometría del predio.
  metadata jsonb not null default '{}'::jsonb,
  check (attempt_number > 0)
);

create index idx_catastrox_delivery_attempts_job on public.catastrox_delivery_attempts (delivery_job_id, attempt_number);

alter table public.catastrox_delivery_attempts enable row level security;

-- Preserva el último error que un intento exitoso terminó resolviendo --
-- catastrox_delivery_jobs.last_error_code se sigue limpiando a NULL en
-- cuanto el job pasa a SENT (sigue reflejando "hay un error activo ahora
-- mismo, sí/no"), pero antes de limpiarlo su valor se copia aquí. La causa
-- del intento anterior nunca desaparece silenciosamente: queda en estas 2
-- columnas Y, con más detalle, en catastrox_delivery_attempts.
alter table public.catastrox_delivery_jobs
  add column last_resolved_error_code text,
  add column last_resolved_error_at timestamptz;
