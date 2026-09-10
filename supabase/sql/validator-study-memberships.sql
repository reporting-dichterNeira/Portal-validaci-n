-- Additive, repeatable rollout: one validator identity/code, several study rosters.
begin;
create table if not exists public.validator_study_memberships (
  validator_id text not null references public.validators(id) on delete cascade,
  study_id uuid not null references public.studies(id),
  country_id uuid not null references public.countries(id),
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (validator_id, study_id, country_id)
);
create index if not exists validator_memberships_scope_idx on public.validator_study_memberships(study_id, country_id, is_active);
alter table public.validator_study_memberships enable row level security;
revoke all on public.validator_study_memberships from anon, authenticated;
grant select on public.validator_study_memberships to authenticated;
drop policy if exists validator_memberships_select on public.validator_study_memberships;
create policy validator_memberships_select on public.validator_study_memberships for select to authenticated
using (private.is_admin() or private.supervisor_has_scope(study_id, country_id) or validator_id = (select private.current_validator_id()));

insert into public.validator_study_memberships(validator_id, study_id, country_id, is_active, created_by)
select id, study_id, country_id, is_active, created_by from public.validators
where study_id is not null and country_id is not null
on conflict do nothing;

create or replace function private.initialize_validator_membership()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.study_id is not null and new.country_id is not null then
    insert into public.validator_study_memberships(validator_id, study_id, country_id, is_active, created_by)
    values(new.id, new.study_id, new.country_id, new.is_active, new.created_by) on conflict do nothing;
  end if;
  return new;
end; $$;
revoke all on function private.initialize_validator_membership() from public, anon, authenticated;
drop trigger if exists validators_initialize_membership on public.validators;
create trigger validators_initialize_membership after insert on public.validators
for each row execute function private.initialize_validator_membership();

-- Narrow directory: never return login codes, emails, sessions or audit data.
-- Privileged lookup is confined to private; public entry point is INVOKER.
create or replace function private.available_study_validators(p_study_id uuid, p_country_id uuid)
returns table(id text, name text, study text) language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.supervisor_has_scope(p_study_id, p_country_id) then
    raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode = '42501';
  end if;
  return query select v.id, v.name, v.study from public.validators v
  where v.is_active and not exists(select 1 from public.validator_study_memberships m
    where m.validator_id=v.id and m.study_id=p_study_id and m.country_id=p_country_id)
  order by v.name, v.id;
end; $$;
create or replace function public.available_study_validators(p_study_id uuid, p_country_id uuid)
returns table(id text, name text, study text) language sql security invoker set search_path = '' as $$
  select * from private.available_study_validators(p_study_id, p_country_id);
$$;

-- Membership controls are authorized for the destination only. Identity and
-- memberships in every other study remain unchanged. Row lock serializes edits.
create or replace function private.manage_validator_membership(p_validator_id text, p_study_id uuid, p_country_id uuid, p_active boolean, p_add boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.supervisor_has_scope(p_study_id, p_country_id) then
    raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode = '42501';
  end if;
  if p_active is null or p_add is null then raise exception 'INVALID_MEMBERSHIP_REQUEST'; end if;
  perform 1 from public.validators where id=p_validator_id for update;
  if not found then raise exception 'VALIDATOR_NOT_FOUND'; end if;
  if p_add then
    if not exists(select 1 from public.validators where id=p_validator_id and is_active) then
      raise exception 'VALIDATOR_NOT_ACTIVE';
    end if;
    insert into public.validator_study_memberships(validator_id, study_id, country_id, is_active)
    values(p_validator_id, p_study_id, p_country_id, true) on conflict do nothing;
  else
    if not p_active and exists(select 1 from public.audits a join public.upload_batches b on b.id=a.batch_id
      where a.assigned_validator_id=p_validator_id and a.study_id=p_study_id and a.country_id=p_country_id
      and a.status='en_progreso' and b.status='active') then raise exception 'VALIDATOR_HAS_IN_PROGRESS_AUDITS'; end if;
    update public.validator_study_memberships set is_active=p_active
    where validator_id=p_validator_id and study_id=p_study_id and country_id=p_country_id;
    if not found then raise exception 'VALIDATOR_OUT_OF_SCOPE'; end if;
  end if;
  update public.validators v set is_active=exists(select 1 from public.validator_study_memberships m where m.validator_id=v.id and m.is_active)
  where v.id=p_validator_id;
end; $$;
create or replace function public.add_existing_study_validator(p_validator_id text, p_study_id uuid, p_country_id uuid)
returns void language sql security invoker set search_path = '' as $$
  select private.manage_validator_membership(p_validator_id, p_study_id, p_country_id, true, true);
$$;
create or replace function public.set_study_validator_active(p_validator_id text, p_study_id uuid, p_country_id uuid, p_active boolean)
returns void language sql security invoker set search_path = '' as $$
  select private.manage_validator_membership(p_validator_id, p_study_id, p_country_id, p_active, false);
$$;

-- Scope read uses existing RLS on memberships; no global identity write is granted.
drop policy if exists validators_select_membership_scope on public.validators;
create policy validators_select_membership_scope on public.validators for select to authenticated
using (exists(select 1 from public.validator_study_memberships m where m.validator_id=validators.id
  and private.supervisor_has_scope(m.study_id,m.country_id)));

revoke all on function private.available_study_validators(uuid,uuid), public.available_study_validators(uuid,uuid),
  private.manage_validator_membership(text,uuid,uuid,boolean,boolean), public.add_existing_study_validator(text,uuid,uuid),
  public.set_study_validator_active(text,uuid,uuid,boolean) from public, anon;
grant execute on function private.available_study_validators(uuid,uuid), public.available_study_validators(uuid,uuid),
  private.manage_validator_membership(text,uuid,uuid,boolean,boolean), public.add_existing_study_validator(text,uuid,uuid),
  public.set_study_validator_active(text,uuid,uuid,boolean) to authenticated;

-- Keep both supported reassignment signatures, replacing only the roster checks.
do $$ declare fn record; definition text; begin
  for fn in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='reassign_pending_audits' loop
    definition := pg_get_functiondef(fn.oid);
    definition := replace(definition, 'from public.validators v', 'from public.validator_study_memberships v');
    definition := replace(definition, 'v.id =', 'v.validator_id =');
    execute definition;
  end loop;
end; $$;
notify pgrst, 'reload schema';
commit;
