-- The country dimension remains internal so existing RLS scope checks stay intact.
-- Administrators only choose one of the four approved studies in the portal.
insert into public.countries (code, name, is_active)
values ('GLB', 'Alcance interno', true)
on conflict (code) do update
set name = excluded.name,
    is_active = true;

insert into public.studies (name, description, is_active)
values
  ('Tradicional', 'Estudio autorizado para la operación Tradicional.', true),
  ('Moderno', 'Estudio autorizado para la operación Moderno.', true),
  ('Chile', 'Estudio autorizado para la operación Chile.', true),
  ('Lindley', 'Estudio autorizado para la operación Lindley.', true)
on conflict (name) do update
set description = excluded.description,
    is_active = true;
