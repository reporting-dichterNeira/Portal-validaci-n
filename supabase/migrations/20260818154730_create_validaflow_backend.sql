-- ValidaFlow multi-user backend.
-- Supervisors manage imports/assignments; validators only read their assigned
-- audits and write progress through the narrowly-scoped RPC below.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

-- New cloud projects can create this automatic-RLS trigger function in the
-- exposed public schema. The trigger still works after direct API execution is
-- revoked from browser roles.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;

create type public.app_role as enum ('supervisor');
create type public.audit_module as enum ('smart', 'blocking');
create type public.audit_status as enum ('pendiente', 'en_progreso', 'completada');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.app_role not null,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.validators (
  id text primary key,
  code text not null unique,
  name text not null,
  email text not null default '',
  study text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint validators_code_format check (code = upper(code) and length(code) between 8 and 20),
  constraint validators_name_not_blank check (length(btrim(name)) > 0),
  constraint validators_study_not_blank check (length(btrim(study)) > 0)
);

create table public.validator_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  validator_id text not null references public.validators(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index validator_sessions_validator_id_idx
  on public.validator_sessions (validator_id);

create table public.audits (
  module public.audit_module not null,
  external_id text not null,
  study text not null,
  assigned_validator_id text references public.validators(id) on delete set null,
  status public.audit_status not null default 'pendiente',
  audit_date date,
  validation_date date,
  payload jsonb not null default '{}'::jsonb,
  validation_results jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  duration_seconds integer,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (module, external_id),
  constraint audits_external_id_not_blank check (length(btrim(external_id)) > 0),
  constraint audits_study_not_blank check (length(btrim(study)) > 0),
  constraint audits_duration_nonnegative check (duration_seconds is null or duration_seconds >= 0)
);

create index audits_assignee_module_status_idx
  on public.audits (assigned_validator_id, module, status);
create index audits_module_study_status_idx
  on public.audits (module, study, status);
create index audits_created_by_idx
  on public.audits (created_by);
create index audits_pending_updated_idx
  on public.audits (updated_at desc)
  where status <> 'completada';

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function private.set_updated_at();

create trigger validators_set_updated_at
before update on public.validators
for each row execute function private.set_updated_at();

create trigger audits_set_updated_at
before update on public.audits
for each row execute function private.set_updated_at();

create or replace function private.is_supervisor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.profiles
      where id = (select auth.uid())
        and role = 'supervisor'::public.app_role
    );
$$;

revoke all on function private.is_supervisor() from public, anon;
grant execute on function private.is_supervisor() to authenticated;

create or replace function private.current_validator_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.validator_id
  from public.validator_sessions s
  where s.user_id = (select auth.uid());
$$;

revoke all on function private.current_validator_id() from public, anon;
grant execute on function private.current_validator_id() to authenticated;

alter table public.profiles enable row level security;
alter table public.validators enable row level security;
alter table public.validator_sessions enable row level security;
alter table public.audits enable row level security;

create policy profiles_select_own_or_supervisor
on public.profiles for select to authenticated
using (id = (select auth.uid()) or (select private.is_supervisor()));

create policy profiles_insert_supervisor
on public.profiles for insert to authenticated
with check ((select private.is_supervisor()));

create policy profiles_update_supervisor
on public.profiles for update to authenticated
using ((select private.is_supervisor()))
with check ((select private.is_supervisor()));

create policy profiles_delete_supervisor
on public.profiles for delete to authenticated
using ((select private.is_supervisor()));

create policy validators_select_assigned_or_supervisor
on public.validators for select to authenticated
using (
  (select private.is_supervisor())
  or id = (select private.current_validator_id())
);

create policy validators_insert_supervisor
on public.validators for insert to authenticated
with check ((select private.is_supervisor()));

create policy validators_update_supervisor
on public.validators for update to authenticated
using ((select private.is_supervisor()))
with check ((select private.is_supervisor()));

create policy validators_delete_supervisor
on public.validators for delete to authenticated
using ((select private.is_supervisor()));

-- No direct policies are intentionally defined on validator_sessions.
-- Session claims are only created through claim_validator_code().

create policy audits_select_assigned_or_supervisor
on public.audits for select to authenticated
using (
  (select private.is_supervisor())
  or assigned_validator_id = (select private.current_validator_id())
);

create policy audits_insert_supervisor
on public.audits for insert to authenticated
with check ((select private.is_supervisor()));

create policy audits_update_supervisor
on public.audits for update to authenticated
using ((select private.is_supervisor()))
with check ((select private.is_supervisor()));

create policy audits_delete_supervisor
on public.audits for delete to authenticated
using ((select private.is_supervisor()));

revoke all on public.profiles, public.validators, public.validator_sessions, public.audits
  from anon, authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.validators to authenticated;
grant select, insert, update, delete on public.audits to authenticated;

create or replace function public.claim_validator_code(p_code text)
returns table (
  id text,
  code text,
  name text,
  email text,
  estudio text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_validator public.validators%rowtype;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select * into v_validator
  from public.validators v
  where v.code = upper(btrim(p_code))
    and v.is_active = true;

  if not found then
    raise exception 'INVALID_VALIDATOR_CODE' using errcode = '22023';
  end if;

  insert into public.validator_sessions (user_id, validator_id, last_seen_at)
  values (v_user_id, v_validator.id, now())
  on conflict (user_id) do update
    set validator_id = excluded.validator_id,
        last_seen_at = excluded.last_seen_at;

  return query
  select v_validator.id, v_validator.code, v_validator.name,
         v_validator.email, v_validator.study;
end;
$$;

revoke all on function public.claim_validator_code(text) from public, anon;
grant execute on function public.claim_validator_code(text) to authenticated;

create or replace function public.save_audit_progress(
  p_module public.audit_module,
  p_external_id text,
  p_status public.audit_status,
  p_validation_results jsonb,
  p_started_at timestamptz default null,
  p_completed_at timestamptz default null,
  p_duration_seconds integer default null,
  p_validation_date date default null
)
returns public.audits
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_validator_id text;
  v_result public.audits%rowtype;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select s.validator_id into v_validator_id
  from public.validator_sessions s
  where s.user_id = v_user_id;

  if v_validator_id is null then
    raise exception 'VALIDATOR_SESSION_REQUIRED' using errcode = '42501';
  end if;

  if p_duration_seconds is not null and p_duration_seconds < 0 then
    raise exception 'INVALID_DURATION' using errcode = '22023';
  end if;

  update public.audits a
  set status = p_status,
      validation_results = coalesce(p_validation_results, '{}'::jsonb),
      started_at = coalesce(p_started_at, a.started_at),
      completed_at = case
        when p_status = 'completada'::public.audit_status then coalesce(p_completed_at, now())
        else p_completed_at
      end,
      duration_seconds = p_duration_seconds,
      validation_date = coalesce(p_validation_date, a.validation_date)
  where a.module = p_module
    and a.external_id = btrim(p_external_id)
    and a.assigned_validator_id = v_validator_id
  returning a.* into v_result;

  if not found then
    raise exception 'AUDIT_NOT_ASSIGNED' using errcode = '42501';
  end if;

  update public.validator_sessions
  set last_seen_at = now()
  where user_id = v_user_id;

  return v_result;
end;
$$;

revoke all on function public.save_audit_progress(
  public.audit_module, text, public.audit_status, jsonb,
  timestamptz, timestamptz, integer, date
) from public, anon;
grant execute on function public.save_audit_progress(
  public.audit_module, text, public.audit_status, jsonb,
  timestamptz, timestamptz, integer, date
) to authenticated;

-- The app listens to audit changes so supervisors and validators see progress
-- from different computers without refreshing.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'audits'
  ) then
    alter publication supabase_realtime add table public.audits;
  end if;
end;
$$;

insert into public.validators (id, code, name, email, study)
select seed.id,
       'VAL-' || upper(substr(md5(seed.id || random()::text), 1, 8)),
       seed.name,
       seed.email,
       seed.study
from (values
  ('val-ch-1', 'Rodrigo Silva', 'rodrigo.silva@dichter-neira.com', 'Chile'),
  ('val-ch-2', 'Camila Morales', 'camila.morales@dichter-neira.com', 'Chile'),
  ('val-ch-3', 'Gabriel Valenzuela', 'gabriel.valenzuela@dichter-neira.com', 'Chile'),
  ('val-ch-4', 'Javiera Castro', 'javiera.castro@dichter-neira.com', 'Chile'),
  ('val-tr-1', 'Carlos Mendoza', 'carlos.mendoza@dichter-neira.com', 'Tradicional'),
  ('val-tr-2', 'Laura Gomez', 'laura.gomez@dichter-neira.com', 'Tradicional'),
  ('val-tr-3', 'Andres Silva', 'andres.silva@dichter-neira.com', 'Tradicional'),
  ('val-tr-4', 'Maria Torres', 'maria.torres@dichter-neira.com', 'Tradicional'),
  ('val-md-1', 'Valeria Rios', 'valeria.rios@dichter-neira.com', 'Moderno'),
  ('val-md-2', 'Diego Alarcon', 'diego.alarcon@dichter-neira.com', 'Moderno'),
  ('val-md-3', 'Mariana Ospina', 'mariana.ospina@dichter-neira.com', 'Moderno'),
  ('val-md-4', 'Lucas Echeverri', 'lucas.echeverri@dichter-neira.com', 'Moderno'),
  ('val-ln-1', 'Fernando Quispe', 'fernando.quispe@dichter-neira.com', 'Lindley'),
  ('val-ln-2', 'Claudia Salazar', 'claudia.salazar@dichter-neira.com', 'Lindley'),
  ('val-ln-3', 'Miguel Flores', 'miguel.flores@dichter-neira.com', 'Lindley'),
  ('val-ln-4', 'Patricia Ramos', 'patricia.ramos@dichter-neira.com', 'Lindley')
) as seed(id, name, email, study)
on conflict (id) do nothing;
