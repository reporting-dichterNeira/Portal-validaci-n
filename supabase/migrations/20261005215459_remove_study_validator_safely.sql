begin;
-- Recoverable roster removal: never delete the validator identity or audits.
alter table public.validator_study_memberships add column if not exists removed_at timestamptz;

create or replace function private.remove_study_validator(p_validator_id text, p_study_id uuid, p_country_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.supervisor_has_scope(p_study_id,p_country_id) then
    raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode='42501';
  end if;
  perform 1 from public.validators where id=p_validator_id for update;
  if not found then raise exception 'VALIDATOR_NOT_FOUND'; end if;
  perform 1 from public.validator_study_memberships where validator_id=p_validator_id
    and study_id=p_study_id and country_id=p_country_id for update;
  if not found then raise exception 'VALIDATOR_OUT_OF_SCOPE' using errcode='42501'; end if;
  -- All active modules share this study membership. Finished history is allowed.
  perform a.id from public.audits a join public.upload_batches b on b.id=a.batch_id
    where a.assigned_validator_id=p_validator_id and a.study_id=p_study_id and a.country_id=p_country_id
      and b.status='active' and a.status in ('pendiente','en_progreso') for update of a;
  if found then raise exception 'VALIDATOR_HAS_UNFINISHED_AUDITS' using errcode='22023'; end if;
  update public.validator_study_memberships set is_active=false, removed_at=coalesce(removed_at,now())
    where validator_id=p_validator_id and study_id=p_study_id and country_id=p_country_id;
  update public.validators v set is_active=exists(select 1 from public.validator_study_memberships m
    where m.validator_id=v.id and m.is_active and m.removed_at is null) where v.id=p_validator_id;
end; $$;
create or replace function public.remove_study_validator(p_validator_id text, p_study_id uuid, p_country_id uuid)
returns void language sql security invoker set search_path = '' as $$
  select private.remove_study_validator(p_validator_id,p_study_id,p_country_id);
$$;

create or replace function private.available_study_validators(p_study_id uuid, p_country_id uuid)
returns table(id text, name text, study text) language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.supervisor_has_scope(p_study_id,p_country_id) then
    raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode='42501';
  end if;
  return query select v.id,v.name,v.study from public.validators v
  where (v.is_active or exists(select 1 from public.validator_study_memberships m where m.validator_id=v.id
    and m.study_id=p_study_id and m.country_id=p_country_id and m.removed_at is not null))
    and not exists(select 1 from public.validator_study_memberships m where m.validator_id=v.id
      and m.study_id=p_study_id and m.country_id=p_country_id and m.removed_at is null)
  order by v.name,v.id;
end; $$;

create or replace function private.manage_validator_membership(p_validator_id text,p_study_id uuid,p_country_id uuid,p_active boolean,p_add boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.supervisor_has_scope(p_study_id,p_country_id) then
    raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode='42501';
  end if;
  if p_active is null or p_add is null then raise exception 'INVALID_MEMBERSHIP_REQUEST'; end if;
  perform 1 from public.validators where id=p_validator_id for update;
  if not found then raise exception 'VALIDATOR_NOT_FOUND'; end if;
  if p_add then
    if not exists(select 1 from public.validators where id=p_validator_id and is_active)
      and not exists(select 1 from public.validator_study_memberships m where m.validator_id=p_validator_id
        and m.study_id=p_study_id and m.country_id=p_country_id and m.removed_at is not null) then
      raise exception 'VALIDATOR_NOT_ACTIVE';
    end if;
    insert into public.validator_study_memberships(validator_id,study_id,country_id,is_active)
      values(p_validator_id,p_study_id,p_country_id,true)
      on conflict(validator_id,study_id,country_id) do update set removed_at=null,is_active=true
      where validator_study_memberships.removed_at is not null;
  else
    if not p_active and exists(select 1 from public.audits a join public.upload_batches b on b.id=a.batch_id
      where a.assigned_validator_id=p_validator_id and a.study_id=p_study_id and a.country_id=p_country_id
        and a.status='en_progreso' and b.status='active') then raise exception 'VALIDATOR_HAS_IN_PROGRESS_AUDITS'; end if;
    update public.validator_study_memberships set is_active=p_active
      where validator_id=p_validator_id and study_id=p_study_id and country_id=p_country_id and removed_at is null;
    if not found then raise exception 'VALIDATOR_OUT_OF_SCOPE'; end if;
  end if;
  update public.validators v set is_active=exists(select 1 from public.validator_study_memberships m
    where m.validator_id=v.id and m.is_active and m.removed_at is null) where v.id=p_validator_id;
end; $$;

-- A stale browser cannot assign new work to a removed roster member.
create or replace function private.prevent_removed_validator_assignment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare removed timestamptz; changed boolean;
begin
  if new.assigned_validator_id is null then return new; end if;
  changed:=tg_op='INSERT';
  if tg_op='UPDATE' then changed:=new.assigned_validator_id is distinct from old.assigned_validator_id; end if;
  if not changed then return new; end if;
  perform 1 from public.validators where id=new.assigned_validator_id for share;
  select m.removed_at into removed from public.validator_study_memberships m
    where m.validator_id=new.assigned_validator_id and m.study_id=new.study_id and m.country_id=new.country_id for share;
  if removed is not null then raise exception 'VALIDATOR_REMOVED_FROM_STUDY' using errcode='22023'; end if;
  return new;
end; $$;
drop trigger if exists audits_prevent_removed_validator_assignment on public.audits;
create trigger audits_prevent_removed_validator_assignment before insert or update of assigned_validator_id on public.audits
  for each row execute function private.prevent_removed_validator_assignment();
revoke all on function private.prevent_removed_validator_assignment() from public,anon,authenticated;
revoke all on function private.remove_study_validator(text,uuid,uuid),public.remove_study_validator(text,uuid,uuid) from public,anon;
grant execute on function private.remove_study_validator(text,uuid,uuid),public.remove_study_validator(text,uuid,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
