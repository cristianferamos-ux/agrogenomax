-- CATX-DELIVERY-CONCURRENCY-001
-- Constraints defensivos para serializacion/idempotencia de delivery.
-- No elimina datos: si existen duplicados historicos, falla con un mensaje
-- claro para que se auditen manualmente antes de aplicar constraints.

-- Diagnostico manual sugerido antes/despues:
-- select delivery_job_id, attempt_number, count(*)
--   from public.catastrox_delivery_attempts
--  group by delivery_job_id, attempt_number
-- having count(*) > 1;
--
-- select delivery_job_id, file_type, count(*)
--   from public.catastrox_deliverables
--  group by delivery_job_id, file_type
-- having count(*) > 1;
--
-- select constraint_name
--   from information_schema.table_constraints
--  where table_schema = 'public'
--    and table_name in ('catastrox_delivery_attempts', 'catastrox_deliverables')
--    and constraint_name in (
--      'uq_catastrox_delivery_attempts_job_attempt',
--      'uq_catastrox_deliverables_job_file_type'
--    );
--
-- select indexname
--   from pg_indexes
--  where schemaname = 'public'
--    and tablename in ('catastrox_delivery_attempts', 'catastrox_deliverables');

do $$
begin
  if exists (
    select 1
      from public.catastrox_delivery_attempts
     group by delivery_job_id, attempt_number
    having count(*) > 1
  ) then
    raise exception 'No se puede crear uq_catastrox_delivery_attempts_job_attempt: existen duplicados en (delivery_job_id, attempt_number). Ejecute la consulta diagnostica de la migracion 009.';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'uq_catastrox_delivery_attempts_job_attempt'
       and conrelid = 'public.catastrox_delivery_attempts'::regclass
  ) then
    alter table public.catastrox_delivery_attempts
      add constraint uq_catastrox_delivery_attempts_job_attempt
      unique (delivery_job_id, attempt_number);
  end if;
end $$;

do $$
begin
  if exists (
    select 1
      from public.catastrox_deliverables
     group by delivery_job_id, file_type
    having count(*) > 1
  ) then
    raise exception 'No se puede crear uq_catastrox_deliverables_job_file_type: existen duplicados en (delivery_job_id, file_type). Ejecute la consulta diagnostica de la migracion 009.';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'uq_catastrox_deliverables_job_file_type'
       and conrelid = 'public.catastrox_deliverables'::regclass
  ) then
    alter table public.catastrox_deliverables
      add constraint uq_catastrox_deliverables_job_file_type
      unique (delivery_job_id, file_type);
  end if;
end $$;
