-- Independent study/module rosters. Preserve validators already used in Smart.
begin;
alter table public.validator_study_memberships add column if not exists blocking_enabled boolean not null default true;
alter table public.validator_study_memberships add column if not exists smart_enabled boolean not null default false;
alter table public.validator_study_memberships add column if not exists blocking_active boolean;
alter table public.validator_study_memberships add column if not exists smart_active boolean;
update public.validator_study_memberships m set blocking_active=coalesce(blocking_active,is_active),
 smart_enabled=smart_enabled or exists(select 1 from public.audits a where a.assigned_validator_id=m.validator_id and a.study_id=m.study_id and a.country_id=m.country_id and a.module='smart'),
 smart_active=coalesce(smart_active,is_active) where blocking_active is null or smart_active is null;
alter table public.validator_study_memberships alter column blocking_active set default true;
alter table public.validator_study_memberships alter column blocking_active set not null;
alter table public.validator_study_memberships alter column smart_active set default true;
alter table public.validator_study_memberships alter column smart_active set not null;

create or replace function private.set_validator_module(p_id text,p_study uuid,p_country uuid,p_module text,p_enabled boolean,p_active boolean)
returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not coalesce(private.supervisor_has_scope(p_study,p_country),false) then raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode='42501'; end if;
 if p_module is null or p_module not in ('blocking','smart') or p_enabled is null or p_active is null then raise exception 'INVALID_MODULE'; end if;
 perform 1 from public.validators where id=p_id for update;
 if not found then raise exception 'VALIDATOR_NOT_FOUND'; end if;
 if (not p_active or not p_enabled) and exists(select 1 from public.audits a where a.assigned_validator_id=p_id and a.study_id=p_study and a.country_id=p_country and a.module::text=p_module and a.status='en_progreso') then raise exception 'VALIDATOR_HAS_IN_PROGRESS_AUDITS'; end if;
 insert into public.validator_study_memberships(validator_id,study_id,country_id,is_active,blocking_enabled,smart_enabled,blocking_active,smart_active)
 values(p_id,p_study,p_country,p_active,p_module='blocking' and p_enabled,p_module='smart' and p_enabled,p_module='blocking' and p_active,p_module='smart' and p_active)
 on conflict(validator_id,study_id,country_id) do update set
 blocking_enabled=case when p_module='blocking' then p_enabled else validator_study_memberships.blocking_enabled end,
 smart_enabled=case when p_module='smart' then p_enabled else validator_study_memberships.smart_enabled end,
 blocking_active=case when p_module='blocking' then p_active else validator_study_memberships.blocking_active end,
 smart_active=case when p_module='smart' then p_active else validator_study_memberships.smart_active end,removed_at=null;
 update public.validator_study_memberships set is_active=(blocking_enabled and blocking_active) or (smart_enabled and smart_active) where validator_id=p_id and study_id=p_study and country_id=p_country;
 update public.validators set is_active=exists(select 1 from public.validator_study_memberships where validator_id=p_id and is_active and removed_at is null) where id=p_id;
end; $$;
create or replace function public.set_validator_module(p_id text,p_study uuid,p_country uuid,p_module text,p_enabled boolean,p_active boolean)
returns void language sql security invoker set search_path='' as $$ select private.set_validator_module(p_id,p_study,p_country,p_module,p_enabled,p_active); $$;
revoke all on function private.set_validator_module(text,uuid,uuid,text,boolean,boolean),public.set_validator_module(text,uuid,uuid,text,boolean,boolean) from public,anon;
grant execute on function private.set_validator_module(text,uuid,uuid,text,boolean,boolean),public.set_validator_module(text,uuid,uuid,text,boolean,boolean) to authenticated;

create or replace function private.available_module_validators(p_study uuid,p_country uuid,p_module text)
returns table(id text,name text,study text) language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not coalesce(private.supervisor_has_scope(p_study,p_country),false) then raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode='42501'; end if;
 if p_module is null or p_module not in ('blocking','smart') then raise exception 'INVALID_MODULE'; end if;
 return query select v.id,v.name,v.study from public.validators v where v.is_active and not exists(select 1 from public.validator_study_memberships m where m.validator_id=v.id and m.study_id=p_study and m.country_id=p_country and m.removed_at is null and case when p_module='smart' then m.smart_enabled else m.blocking_enabled end) order by v.name;
end; $$;
create or replace function public.available_module_validators(p_study uuid,p_country uuid,p_module text)
returns table(id text,name text,study text) language sql security invoker set search_path='' as $$ select * from private.available_module_validators(p_study,p_country,p_module); $$;
revoke all on function private.available_module_validators(uuid,uuid,text),public.available_module_validators(uuid,uuid,text) from public,anon;
grant execute on function private.available_module_validators(uuid,uuid,text),public.available_module_validators(uuid,uuid,text) to authenticated;

-- Enforce eligibility for new assignments even if an obsolete client is used.
create or replace function private.check_validator_module_assignment()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.assigned_validator_id is null or new.status='completada' then return new; end if;
 if tg_op='UPDATE' then
  if new.assigned_validator_id is not distinct from old.assigned_validator_id and new.module=old.module and new.study_id=old.study_id and new.country_id=old.country_id then return new; end if;
 end if;
 if not exists(select 1 from public.validator_study_memberships m where m.validator_id=new.assigned_validator_id and m.study_id=new.study_id and m.country_id=new.country_id and m.removed_at is null and m.is_active and case when new.module='smart' then m.smart_enabled and m.smart_active else m.blocking_enabled and m.blocking_active end) then raise exception 'VALIDATOR_NOT_ENABLED_FOR_MODULE'; end if;
 return new;
end; $$;
revoke all on function private.check_validator_module_assignment() from public,anon,authenticated;
drop trigger if exists audits_validator_module_eligibility on public.audits;
create trigger audits_validator_module_eligibility before insert or update of assigned_validator_id,module,study_id,country_id on public.audits for each row execute function private.check_validator_module_assignment();
notify pgrst,'reload schema';
commit;
