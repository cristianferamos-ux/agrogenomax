create extension if not exists "pgcrypto";

create type public.agx_role as enum (
  'SUPER_ADMIN',
  'ADMIN_FINCA',
  'VETERINARIO',
  'OPERARIO',
  'CONSULTOR',
  'INVITADO'
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  nit text,
  owner_user_id uuid,
  plan text not null default 'free',
  status text not null default 'active',
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id),
  full_name text,
  phone text,
  role public.agx_role not null default 'INVITADO',
  habeas_data_accepted boolean not null default false,
  habeas_data_accepted_at timestamptz,
  privacy_accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table public.organizations
  add constraint organizations_owner_user_id_fkey
  foreign key (owner_user_id) references public.profiles(id);

create table public.farms (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  internal_code text not null,
  owner_name text,
  owner_document text,
  phone text,
  email text,
  department text,
  municipality text,
  village text,
  gps_lat numeric(10, 7),
  gps_lng numeric(10, 7),
  total_area_ha numeric(12, 2),
  productive_area_ha numeric(12, 2),
  exploitation_types text[] not null default '{}',
  infrastructure text[] not null default '{}',
  pastures text[] not null default '{}',
  silvopastoral_species text[] not null default '{}',
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, internal_code)
);

create table public.breeds (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  species text not null default 'bovine',
  type text not null default 'breed',
  created_at timestamptz not null default now()
);

create table public.animals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  farm_id uuid references public.farms(id) on delete set null,
  code text not null,
  tag_number text,
  qr_payload text,
  qr_storage_path text,
  photo_storage_path text,
  name text,
  sex text not null check (sex in ('Macho', 'Hembra')),
  status text not null,
  breed_mode text not null default 'pure' check (breed_mode in ('pure', 'cross')),
  primary_breed_id uuid references public.breeds(id),
  birth_date date,
  birth_weight_kg numeric(10, 2),
  color text,
  body_condition numeric(4, 2),
  mother_id uuid references public.animals(id),
  father_id uuid references public.animals(id),
  genetic_line text,
  origin text,
  current_paddock_id uuid,
  geo_lat numeric(10, 7),
  geo_lng numeric(10, 7),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, code)
);

create table public.crossbreeds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  animal_id uuid not null references public.animals(id) on delete cascade,
  breed_id uuid not null references public.breeds(id),
  percentage numeric(5, 2) not null check (percentage > 0 and percentage <= 100),
  created_at timestamptz not null default now()
);

create table public.paddocks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  farm_id uuid not null references public.farms(id) on delete cascade,
  name text not null,
  area_ha numeric(12, 2),
  animal_capacity integer,
  occupancy integer not null default 0,
  rest_days integer,
  status text not null default 'available',
  geometry jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table public.animals
  add constraint animals_current_paddock_id_fkey
  foreign key (current_paddock_id) references public.paddocks(id);

create table public.weights (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  animal_id uuid not null references public.animals(id) on delete cascade,
  measured_at date not null,
  weight_kg numeric(10, 2) not null,
  daily_gain_kg numeric(10, 3),
  notes text,
  responsible_id uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.vaccines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  animal_id uuid not null references public.animals(id) on delete cascade,
  applied_at date not null,
  vaccine text not null,
  dose text,
  vaccine_batch text,
  next_application date,
  responsible_id uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.treatments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  animal_id uuid not null references public.animals(id) on delete cascade,
  diagnosis text,
  medication text,
  dose text,
  duration text,
  veterinarian_id uuid references public.profiles(id),
  notes text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.diseases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  animal_id uuid not null references public.animals(id) on delete cascade,
  disease text not null,
  detected_at date,
  alert_level text default 'medium',
  follow_up text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.reproduction (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  animal_id uuid not null references public.animals(id) on delete cascade,
  event_type text not null,
  event_date date not null,
  method text,
  technician_id uuid references public.profiles(id),
  result text,
  notes text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.heats (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  animal_id uuid not null references public.animals(id) on delete cascade,
  heat_date date not null,
  heat_number integer,
  notes text,
  created_at timestamptz not null default now()
);

create table public.inseminations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  animal_id uuid not null references public.animals(id) on delete cascade,
  inseminated_at date not null,
  method text not null check (method in ('IA', 'IAFT', 'Monta natural', 'Transferencia embrionaria')),
  technician_id uuid references public.profiles(id),
  bull text,
  straw_code text,
  breed text,
  semen_sex text,
  pregnancy_diagnosis text,
  expected_birth_date date,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.protocols (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  animal_id uuid references public.animals(id) on delete cascade,
  drug text not null,
  dose text,
  scheduled_at timestamptz not null,
  responsible_id uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.embryos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  code text not null,
  donor_animal_id uuid references public.animals(id),
  father text,
  mother text,
  quality text,
  status text,
  collected_at date,
  pedigree jsonb not null default '{}',
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, code)
);

create table public.embryo_transfers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  embryo_id uuid not null references public.embryos(id) on delete cascade,
  recipient_animal_id uuid references public.animals(id),
  transferred_at date not null,
  technician_id uuid references public.profiles(id),
  result text,
  pregnancy_diagnosis text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.milk_production (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  animal_id uuid not null references public.animals(id) on delete cascade,
  production_date date not null,
  liters_am numeric(10, 2) default 0,
  liters_pm numeric(10, 2) default 0,
  total_liters numeric(10, 2) generated always as (coalesce(liters_am, 0) + coalesce(liters_pm, 0)) stored,
  conductivity numeric(10, 2),
  mastitis boolean default false,
  milk_quality text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.nutrition (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  farm_id uuid references public.farms(id),
  animal_id uuid references public.animals(id),
  nutrition_type text not null,
  pasture_type text,
  rotation text,
  stocking_rate numeric(10, 2),
  supplement text,
  quantity numeric(10, 2),
  frequency text,
  cost numeric(12, 2),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  animal_id uuid not null references public.animals(id) on delete cascade,
  from_paddock_id uuid references public.paddocks(id),
  to_paddock_id uuid references public.paddocks(id),
  moved_at timestamptz not null default now(),
  geo_lat numeric(10, 7),
  geo_lng numeric(10, 7),
  responsible_id uuid references public.profiles(id),
  notes text
);

create table public.qr_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  animal_id uuid not null references public.animals(id) on delete cascade,
  payload text not null,
  png_storage_path text,
  pdf_storage_path text,
  created_at timestamptz not null default now()
);

create table public.files (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  farm_id uuid references public.farms(id),
  animal_id uuid references public.animals(id),
  file_type text not null,
  bucket text not null,
  storage_path text not null,
  mime_type text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id),
  actor_id uuid references public.profiles(id),
  action text not null,
  table_name text,
  record_id uuid,
  old_data jsonb,
  new_data jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create index on public.profiles (organization_id, role);
create index on public.farms (organization_id, deleted_at);
create index on public.animals (organization_id, farm_id, code) where deleted_at is null;
create index on public.weights (organization_id, animal_id, measured_at desc);
create index on public.vaccines (organization_id, next_application) where deleted_at is null;
create index on public.inseminations (organization_id, expected_birth_date) where deleted_at is null;
create index on public.milk_production (organization_id, animal_id, production_date desc);
create index on public.audit_logs (organization_id, created_at desc);

create or replace function public.current_profile_role()
returns public.agx_role
language sql
stable
security definer
as $$
  select role from public.profiles where id = auth.uid() and deleted_at is null
$$;

create or replace function public.current_organization_id()
returns uuid
language sql
stable
security definer
as $$
  select organization_id from public.profiles where id = auth.uid() and deleted_at is null
$$;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
as $$
  select coalesce(public.current_profile_role() = 'SUPER_ADMIN', false)
$$;

create or replace function public.can_write()
returns boolean
language sql
stable
security definer
as $$
  select coalesce(public.current_profile_role() in ('SUPER_ADMIN', 'ADMIN_FINCA', 'VETERINARIO', 'OPERARIO'), false)
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.audit_logs (
    organization_id,
    actor_id,
    action,
    table_name,
    record_id,
    old_data,
    new_data
  )
  values (
    coalesce(new.organization_id, old.organization_id),
    auth.uid(),
    tg_op,
    tg_table_name,
    coalesce(new.id, old.id),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );
  return coalesce(new, old);
end;
$$;

create trigger organizations_touch before update on public.organizations
  for each row execute function public.touch_updated_at();
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger farms_touch before update on public.farms
  for each row execute function public.touch_updated_at();
create trigger animals_touch before update on public.animals
  for each row execute function public.touch_updated_at();
create trigger paddocks_touch before update on public.paddocks
  for each row execute function public.touch_updated_at();

create trigger audit_farms after insert or update or delete on public.farms
  for each row execute function public.audit_row_change();
create trigger audit_animals after insert or update or delete on public.animals
  for each row execute function public.audit_row_change();
create trigger audit_weights after insert or update or delete on public.weights
  for each row execute function public.audit_row_change();
create trigger audit_vaccines after insert or update or delete on public.vaccines
  for each row execute function public.audit_row_change();
create trigger audit_reproduction after insert or update or delete on public.reproduction
  for each row execute function public.audit_row_change();

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.farms enable row level security;
alter table public.breeds enable row level security;
alter table public.animals enable row level security;
alter table public.crossbreeds enable row level security;
alter table public.paddocks enable row level security;
alter table public.weights enable row level security;
alter table public.vaccines enable row level security;
alter table public.treatments enable row level security;
alter table public.diseases enable row level security;
alter table public.reproduction enable row level security;
alter table public.heats enable row level security;
alter table public.inseminations enable row level security;
alter table public.protocols enable row level security;
alter table public.embryos enable row level security;
alter table public.embryo_transfers enable row level security;
alter table public.milk_production enable row level security;
alter table public.nutrition enable row level security;
alter table public.movements enable row level security;
alter table public.qr_codes enable row level security;
alter table public.files enable row level security;
alter table public.audit_logs enable row level security;

create policy "breeds are public catalog" on public.breeds
  for select using (true);

create policy "tenant organizations select" on public.organizations
  for select using (public.is_super_admin() or id = public.current_organization_id());
create policy "tenant organizations update" on public.organizations
  for update using (public.is_super_admin() or id = public.current_organization_id())
  with check (public.is_super_admin() or id = public.current_organization_id());

create policy "profiles tenant select" on public.profiles
  for select using (public.is_super_admin() or organization_id = public.current_organization_id() or id = auth.uid());
create policy "profiles own update" on public.profiles
  for update using (public.is_super_admin() or id = auth.uid())
  with check (public.is_super_admin() or id = auth.uid());

create policy "tenant select farms" on public.farms
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());
create policy "tenant write farms" on public.farms
  for all using (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()))
  with check (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()));

create policy "tenant select animals" on public.animals
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());
create policy "tenant write animals" on public.animals
  for all using (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()))
  with check (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()));

create policy "tenant select crossbreeds" on public.crossbreeds
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());
create policy "tenant write crossbreeds" on public.crossbreeds
  for all using (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()))
  with check (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()));

create policy "tenant select paddocks" on public.paddocks
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());
create policy "tenant write paddocks" on public.paddocks
  for all using (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()))
  with check (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()));

create policy "tenant select weights" on public.weights
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());
create policy "tenant write weights" on public.weights
  for all using (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()))
  with check (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()));

create policy "tenant select vaccines" on public.vaccines
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());
create policy "tenant write vaccines" on public.vaccines
  for all using (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()))
  with check (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()));

create policy "tenant select treatments" on public.treatments
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());
create policy "tenant write treatments" on public.treatments
  for all using (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()))
  with check (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()));

create policy "tenant select diseases" on public.diseases
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());
create policy "tenant write diseases" on public.diseases
  for all using (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()))
  with check (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()));

create policy "tenant select reproduction" on public.reproduction
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());
create policy "tenant write reproduction" on public.reproduction
  for all using (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()))
  with check (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()));

create policy "tenant select heats" on public.heats
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());
create policy "tenant write heats" on public.heats
  for all using (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()))
  with check (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()));

create policy "tenant select inseminations" on public.inseminations
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());
create policy "tenant write inseminations" on public.inseminations
  for all using (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()))
  with check (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()));

create policy "tenant select protocols" on public.protocols
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());
create policy "tenant write protocols" on public.protocols
  for all using (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()))
  with check (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()));

create policy "tenant select embryos" on public.embryos
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());
create policy "tenant write embryos" on public.embryos
  for all using (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()))
  with check (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()));

create policy "tenant select embryo_transfers" on public.embryo_transfers
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());
create policy "tenant write embryo_transfers" on public.embryo_transfers
  for all using (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()))
  with check (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()));

create policy "tenant select milk_production" on public.milk_production
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());
create policy "tenant write milk_production" on public.milk_production
  for all using (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()))
  with check (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()));

create policy "tenant select nutrition" on public.nutrition
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());
create policy "tenant write nutrition" on public.nutrition
  for all using (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()))
  with check (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()));

create policy "tenant select movements" on public.movements
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());
create policy "tenant write movements" on public.movements
  for all using (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()))
  with check (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()));

create policy "tenant select qr_codes" on public.qr_codes
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());
create policy "tenant write qr_codes" on public.qr_codes
  for all using (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()))
  with check (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()));

create policy "tenant select files" on public.files
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());
create policy "tenant write files" on public.files
  for all using (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()))
  with check (public.can_write() and (public.is_super_admin() or organization_id = public.current_organization_id()));

create policy "tenant audit read" on public.audit_logs
  for select using (public.is_super_admin() or organization_id = public.current_organization_id());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('animal-photos', 'animal-photos', false, 10485760, array['image/png', 'image/jpeg', 'image/webp']),
  ('qr-codes', 'qr-codes', false, 5242880, array['image/png', 'application/pdf']),
  ('farm-documents', 'farm-documents', false, 20971520, array['application/pdf', 'image/png', 'image/jpeg', 'image/webp']),
  ('veterinary-files', 'veterinary-files', false, 20971520, array['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

create policy "tenant storage read" on storage.objects
  for select using (
    bucket_id in ('animal-photos', 'qr-codes', 'farm-documents', 'veterinary-files')
    and (
      public.is_super_admin()
      or split_part(name, '/', 1)::uuid = public.current_organization_id()
    )
  );

create policy "tenant storage write" on storage.objects
  for insert with check (
    bucket_id in ('animal-photos', 'qr-codes', 'farm-documents', 'veterinary-files')
    and public.can_write()
    and (
      public.is_super_admin()
      or split_part(name, '/', 1)::uuid = public.current_organization_id()
    )
  );
