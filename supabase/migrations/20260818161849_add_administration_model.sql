-- Administrative model: administrators create staff accounts and assign one
-- study/country scope to every supervisor. Supervisors only operate in scope.

alter table public.profiles
  add column if not exists username text,
  add column if not exists is_active boolean not null default true;

create unique index if not exists profiles_username_lower_uidx
  on public.profiles (lower(username))
  where username is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_username_format'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_username_format
      check (username is null or username ~ '^[a-z0-9][a-z0-9._-]{2,31}$');
  end if;
end;
$$;

create table public.countries (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint countries_code_format check (code = upper(code) and code ~ '^[A-Z0-9]{2,5}$'),
  constraint countries_name_not_blank check (length(btrim(name)) > 0),
  constraint countries_code_unique unique (code),
  constraint countries_name_unique unique (name)
);

create index countries_created_by_idx on public.countries (created_by);

create table public.studies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint studies_name_not_blank check (length(btrim(name)) > 0),
  constraint studies_name_unique unique (name)
);

create index studies_created_by_idx on public.studies (created_by);

create table public.supervisor_assignments (
  id uuid primary key default gen_random_uuid(),
  supervisor_id uuid not null references public.profiles(id) on delete cascade,
  study_id uuid not null references public.studies(id) on delete restrict,
  country_id uuid not null references public.countries(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supervisor_assignments_one_scope_per_supervisor unique (supervisor_id)
);

create index supervisor_assignments_study_id_idx
  on public.supervisor_assignments (study_id);
create index supervisor_assignments_country_id_idx
  on public.supervisor_assignments (country_id);
create index supervisor_assignments_created_by_idx
  on public.supervisor_assignments (created_by);

alter table public.validators
  add column if not exists study_id uuid references public.studies(id) on delete restrict,
  add column if not exists country_id uuid references public.countries(id) on delete restrict,
  add column if not exists created_by uuid references auth.users(id) on delete set null default auth.uid();

create index if not exists validators_study_country_idx
  on public.validators (study_id, country_id);
create index if not exists validators_country_id_idx
  on public.validators (country_id);
create index if not exists validators_created_by_idx
  on public.validators (created_by);

alter table public.audits
  add column if not exists study_id uuid references public.studies(id) on delete restrict,
  add column if not exists country_id uuid references public.countries(id) on delete restrict;

create index if not exists audits_study_country_status_idx
  on public.audits (study_id, country_id, status);
create index if not exists audits_country_id_idx
  on public.audits (country_id);

create trigger countries_set_updated_at
before update on public.countries
for each row execute function private.set_updated_at();

create trigger studies_set_updated_at
before update on public.studies
for each row execute function private.set_updated_at();

create trigger supervisor_assignments_set_updated_at
before update on public.supervisor_assignments
for each row execute function private.set_updated_at();

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1 from public.profiles
      where id = (select auth.uid())
        and role = 'admin'::public.app_role
        and is_active = true
    );
$$;

create or replace function private.is_supervisor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1 from public.profiles
      where id = (select auth.uid())
        and role = 'supervisor'::public.app_role
        and is_active = true
    );
$$;

create or replace function private.supervisor_has_scope(p_study_id uuid, p_country_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_study_id is not null
    and p_country_id is not null
    and exists (
      select 1
      from public.supervisor_assignments sa
      join public.profiles p on p.id = sa.supervisor_id
      where sa.supervisor_id = (select auth.uid())
        and sa.study_id = p_study_id
        and sa.country_id = p_country_id
        and p.role = 'supervisor'::public.app_role
        and p.is_active = true
    );
$$;

revoke all on function private.is_admin() from public, anon;
revoke all on function private.supervisor_has_scope(uuid, uuid) from public, anon;
grant execute on function private.is_admin() to authenticated;
grant execute on function private.supervisor_has_scope(uuid, uuid) to authenticated;

alter table public.countries enable row level security;
alter table public.studies enable row level security;
alter table public.supervisor_assignments enable row level security;

-- Replace the broad supervisor policies with role- and scope-aware policies.
drop policy if exists profiles_select_own_or_supervisor on public.profiles;
drop policy if exists profiles_insert_supervisor on public.profiles;
drop policy if exists profiles_update_supervisor on public.profiles;
drop policy if exists profiles_delete_supervisor on public.profiles;

create policy profiles_select_own_or_admin
on public.profiles for select to authenticated
using (id = (select auth.uid()) or (select private.is_admin()));

create policy profiles_insert_admin
on public.profiles for insert to authenticated
with check ((select private.is_admin()));

create policy profiles_update_admin
on public.profiles for update to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

create policy profiles_delete_admin
on public.profiles for delete to authenticated
using ((select private.is_admin()));

create policy countries_select_staff_scope
on public.countries for select to authenticated
using (
  (select private.is_admin())
  or exists (
    select 1 from public.supervisor_assignments sa
    where sa.supervisor_id = (select auth.uid())
      and sa.country_id = countries.id
  )
);

create policy countries_insert_admin
on public.countries for insert to authenticated
with check ((select private.is_admin()));
create policy countries_update_admin
on public.countries for update to authenticated
using ((select private.is_admin())) with check ((select private.is_admin()));
create policy countries_delete_admin
on public.countries for delete to authenticated
using ((select private.is_admin()));

create policy studies_select_staff_scope
on public.studies for select to authenticated
using (
  (select private.is_admin())
  or exists (
    select 1 from public.supervisor_assignments sa
    where sa.supervisor_id = (select auth.uid())
      and sa.study_id = studies.id
  )
);

create policy studies_insert_admin
on public.studies for insert to authenticated
with check ((select private.is_admin()));
create policy studies_update_admin
on public.studies for update to authenticated
using ((select private.is_admin())) with check ((select private.is_admin()));
create policy studies_delete_admin
on public.studies for delete to authenticated
using ((select private.is_admin()));

create policy supervisor_assignments_select_own_or_admin
on public.supervisor_assignments for select to authenticated
using (supervisor_id = (select auth.uid()) or (select private.is_admin()));
create policy supervisor_assignments_insert_admin
on public.supervisor_assignments for insert to authenticated
with check ((select private.is_admin()));
create policy supervisor_assignments_update_admin
on public.supervisor_assignments for update to authenticated
using ((select private.is_admin())) with check ((select private.is_admin()));
create policy supervisor_assignments_delete_admin
on public.supervisor_assignments for delete to authenticated
using ((select private.is_admin()));

drop policy if exists validators_select_assigned_or_supervisor on public.validators;
drop policy if exists validators_insert_supervisor on public.validators;
drop policy if exists validators_update_supervisor on public.validators;
drop policy if exists validators_delete_supervisor on public.validators;

create policy validators_select_by_role_and_scope
on public.validators for select to authenticated
using (
  (select private.is_admin())
  or id = (select private.current_validator_id())
  or (select private.supervisor_has_scope(study_id, country_id))
);
create policy validators_insert_by_role_and_scope
on public.validators for insert to authenticated
with check (
  (select private.is_admin())
  or (select private.supervisor_has_scope(study_id, country_id))
);
create policy validators_update_by_role_and_scope
on public.validators for update to authenticated
using (
  (select private.is_admin())
  or (select private.supervisor_has_scope(study_id, country_id))
)
with check (
  (select private.is_admin())
  or (select private.supervisor_has_scope(study_id, country_id))
);
create policy validators_delete_by_role_and_scope
on public.validators for delete to authenticated
using (
  (select private.is_admin())
  or (select private.supervisor_has_scope(study_id, country_id))
);

drop policy if exists audits_select_assigned_or_supervisor on public.audits;
drop policy if exists audits_insert_supervisor on public.audits;
drop policy if exists audits_update_supervisor on public.audits;
drop policy if exists audits_delete_supervisor on public.audits;

create policy audits_select_by_role_and_scope
on public.audits for select to authenticated
using (
  (select private.is_admin())
  or assigned_validator_id = (select private.current_validator_id())
  or (select private.supervisor_has_scope(study_id, country_id))
);
create policy audits_insert_by_role_and_scope
on public.audits for insert to authenticated
with check (
  (select private.is_admin())
  or (select private.supervisor_has_scope(study_id, country_id))
);
create policy audits_update_by_role_and_scope
on public.audits for update to authenticated
using (
  (select private.is_admin())
  or (select private.supervisor_has_scope(study_id, country_id))
)
with check (
  (select private.is_admin())
  or (select private.supervisor_has_scope(study_id, country_id))
);
create policy audits_delete_by_role_and_scope
on public.audits for delete to authenticated
using (
  (select private.is_admin())
  or (select private.supervisor_has_scope(study_id, country_id))
);

revoke all on public.countries, public.studies, public.supervisor_assignments
  from anon, authenticated;
grant select, insert, update, delete on public.countries to authenticated;
grant select, insert, update, delete on public.studies to authenticated;
grant select, insert, update, delete on public.supervisor_assignments to authenticated;

-- Existing API tables were created while automatic exposure was disabled.
-- Restate the required authenticated privileges explicitly.
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.validators to authenticated;
grant select, insert, update, delete on public.audits to authenticated;
