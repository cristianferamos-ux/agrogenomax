insert into public.breeds (name, species, type) values
  ('Brahman Gris', 'bovine', 'breed'),
  ('Brahman Rojo', 'bovine', 'breed'),
  ('Gyr', 'bovine', 'breed'),
  ('Guzera', 'bovine', 'breed'),
  ('Nelore', 'bovine', 'breed'),
  ('Angus', 'bovine', 'breed'),
  ('Brangus', 'bovine', 'breed'),
  ('Simmental', 'bovine', 'breed'),
  ('Simbrah', 'bovine', 'breed'),
  ('Holstein', 'bovine', 'breed'),
  ('Jersey', 'bovine', 'breed'),
  ('Pardo Suizo', 'bovine', 'breed'),
  ('BON', 'bovine', 'breed'),
  ('Romosinuano', 'bovine', 'breed'),
  ('Beefmaster', 'bovine', 'breed'),
  ('Charolais', 'bovine', 'breed'),
  ('Limousin', 'bovine', 'breed'),
  ('Senepol', 'bovine', 'breed'),
  ('Wagyu', 'bovine', 'breed'),
  ('Girolando', 'bovine', 'breed'),
  ('Normando', 'bovine', 'breed'),
  ('Harton del Valle', 'bovine', 'breed'),
  ('Criollo Caqueteno', 'bovine', 'breed'),
  ('Costeno con Cuernos', 'bovine', 'breed'),
  ('Blanco Orejinegro', 'bovine', 'breed'),
  ('Ayrshire', 'bovine', 'breed'),
  ('Lucerna', 'bovine', 'breed'),
  ('Cruce comercial', 'bovine', 'cross')
on conflict (name) do nothing;

insert into public.organizations (id, name, nit, plan, status, settings)
values (
  '00000000-0000-4000-8000-000000000001',
  'AgroGenomaX Demo',
  '900000000-0',
  'free',
  'active',
  '{"country":"CO","legal":"habeas-data-ready","demo":true}'
)
on conflict (id) do nothing;

insert into public.farms (
  id,
  organization_id,
  name,
  internal_code,
  owner_name,
  department,
  municipality,
  village,
  total_area_ha,
  productive_area_ha,
  exploitation_types,
  infrastructure,
  pastures,
  silvopastoral_species
)
values (
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000001',
  'Genesis Norte',
  'AGX-04',
  'AgroGenomaX Demo',
  'Caqueta',
  'Florencia',
  'Demo',
  2140,
  1380,
  array['Doble proposito', 'Genetica', 'Transferencia embrionaria'],
  array['Corrales', 'Bretes', 'Bascula', 'Agua', 'Sistema silvopastoril'],
  array['Brachiaria brizantha', 'Mombasa', 'Pasto de corte'],
  array['Leucaena', 'Boton de oro', 'Matarraton']
)
on conflict (organization_id, internal_code) do nothing;
