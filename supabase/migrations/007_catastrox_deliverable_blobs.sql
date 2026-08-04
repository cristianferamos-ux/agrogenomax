-- CATX-DELIVERY-001: automatiza generación/persistencia/envío del PDF
-- comprado. catastrox_deliverables ya existía (migración 004) como tabla
-- de METADATOS (storage_key, content_hash, byte_size, file_type) -- nunca
-- tuvo un lugar real donde guardar los bytes. Sin R2/S3 configurado hoy
-- (confirmado: cero variables de entorno de storage en todo el repo) y con
-- un PDF pequeño (texto+trazos vectoriales vía PDFKit, sin imágenes
-- rasterizadas -- decenas de KB típico), se elige Postgres como backend de
-- almacenamiento por defecto, vía una tabla separada de blobs (nunca se
-- mezclan bytes con metadatos consultables/JOINeables) detrás de una
-- interfaz de storage intercambiable (server/services/catastrox/storage/).
--
-- Consultas SIEMPRE por deliverable_id exacto (clave primaria = FK) --
-- nunca un listado. Ningún endpoint de historial (GET /orders/mine) toca
-- esta tabla.

-- file_name: nombre server-side (<canonicalPredioId>_<packageId>.pdf, ver
-- buildCatastroxDeliverableFilename) -- persistido en vez de recalculado
-- en cada descarga, para que nunca diverja si la función de nombrado
-- cambia en el futuro.
alter table public.catastrox_deliverables
  add column file_name text not null default '';
alter table public.catastrox_deliverables
  alter column file_name drop default;

create table public.catastrox_deliverable_blobs (
  deliverable_id uuid primary key references public.catastrox_deliverables(id),
  bytes bytea not null,
  content_type text not null default 'application/pdf',
  -- Límite documentado en server/config/env.js (CATASTROX_DELIVERABLE_MAX_BYTES,
  -- default 10 MB) -- se aplica en la capa de aplicación antes del INSERT,
  -- este CHECK es una segunda barrera a nivel de base de datos.
  byte_size integer not null,
  created_at timestamptz not null default now(),
  check (byte_size = octet_length(bytes)),
  check (byte_size > 0 and byte_size <= 10485760)
);

alter table public.catastrox_deliverable_blobs enable row level security;
