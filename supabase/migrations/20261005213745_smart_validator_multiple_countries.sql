begin;
alter table public.validator_study_memberships
  add column if not exists smart_countries text[] not null default '{}'::text[];
-- Preserve each current single-country preference. Empty array means all countries.
update public.validator_study_memberships set smart_countries = array[smart_country]
where cardinality(smart_countries) = 0 and nullif(btrim(smart_country),'') is not null;

create or replace function private.smart_country_allowed(countries text[], country text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(cardinality(countries),0) = 0 or exists (
    select 1 from unnest(countries) allowed
    where private.audit_country_key(allowed) = private.audit_country_key(coalesce(country,''))
  );
$$;
revoke all on function private.smart_country_allowed(text[],text) from public, anon, authenticated;

create or replace function private.set_study_validator_smart_countries(
  p_validator_id text, p_study_id uuid, p_country_id uuid, p_smart_countries text[], p_active boolean
) returns void language plpgsql security definer set search_path = '' as $$
declare selected_countries text[]; study_name text;
begin
  if auth.uid() is null or not private.supervisor_has_scope(p_study_id,p_country_id)
    or not exists(select 1 from public.supervisor_assignments sa where sa.supervisor_id=auth.uid()
      and sa.study_id=p_study_id and sa.country_id=p_country_id and sa.module='smart') then
    raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode='42501';
  end if;
  select s.name into study_name from public.studies s where s.id=p_study_id;
  if study_name not in ('Tradicional','Moderno') then
    raise exception 'El filtro de países solo aplica a KO Tradicional y KO Moderno.';
  end if;
  if exists(select 1 from unnest(coalesce(p_smart_countries,'{}'::text[])) country
    where coalesce(private.normalize_audit_country(country),'') = '') then
    raise exception 'Selecciona países válidos; no códigos numéricos.' using errcode='22023';
  end if;
  select coalesce(array_agg(country order by country),'{}'::text[]) into selected_countries
    from (select distinct private.normalize_audit_country(country) as country
      from unnest(coalesce(p_smart_countries,'{}'::text[])) country) normalized;
  perform 1 from public.validators where id=p_validator_id for update;
  perform 1 from public.validator_study_memberships m where m.validator_id=p_validator_id
    and m.study_id=p_study_id and m.country_id=p_country_id for update;
  if not found then raise exception 'VALIDATOR_OUT_OF_SCOPE' using errcode='42501'; end if;
  if exists(select 1 from public.audits a join public.upload_batches b on b.id=a.batch_id
    where a.assigned_validator_id=p_validator_id and a.study_id=p_study_id and a.country_id=p_country_id
    and a.module='smart' and a.status='en_progreso' and b.status='active'
    and not private.smart_country_allowed(selected_countries,a.payload->>'pais')) then
    raise exception 'Termina las auditorías en progreso de los países que vas a quitar.';
  end if;
  update public.validator_study_memberships set smart_countries=selected_countries,
    smart_country=coalesce(selected_countries[1],'')
    where validator_id=p_validator_id and study_id=p_study_id and country_id=p_country_id;
  if p_active is not null then
    perform private.manage_validator_membership(p_validator_id,p_study_id,p_country_id,p_active,false);
  end if;
  update public.audits a set assigned_validator_id=null from public.upload_batches b
    where b.id=a.batch_id and b.status='active' and a.module='smart' and a.status='pendiente'
    and a.assigned_validator_id=p_validator_id and a.study_id=p_study_id and a.country_id=p_country_id
    and not private.smart_country_allowed(selected_countries,a.payload->>'pais');
end; $$;

create or replace function public.set_study_validator_smart_countries(
  p_validator_id text, p_study_id uuid, p_country_id uuid, p_smart_countries text[], p_active boolean default null
) returns void language sql security invoker set search_path = '' as $$
  select private.set_study_validator_smart_countries(p_validator_id,p_study_id,p_country_id,p_smart_countries,p_active);
$$;
-- Existing clients retain a single-country RPC without bypassing the new server rule.
create or replace function private.set_study_validator_smart_country(
  p_validator_id text, p_study_id uuid, p_country_id uuid, p_smart_country text, p_active boolean
) returns void language sql security invoker set search_path = '' as $$
  select private.set_study_validator_smart_countries(p_validator_id,p_study_id,p_country_id,
    case when nullif(btrim(p_smart_country),'') is null then '{}'::text[] else array[p_smart_country] end,p_active);
$$;
create or replace function private.enforce_smart_audit_country()
returns trigger language plpgsql security definer set search_path = '' as $$
declare actual_country text; restricted_countries text[]; operation_date date; changed_assignment boolean;
begin
  actual_country := private.normalize_audit_country(coalesce(nullif(new.payload->>'pais', ''), new.payload->>'country'));
  if new.study = 'Lindley' then actual_country := 'Perú';
  elsif new.study = 'Chile' then actual_country := 'Chile'; end if;
  new.payload := jsonb_set(coalesce(new.payload, '{}'::jsonb), '{pais}', to_jsonb(coalesce(actual_country, '')));
  select b.operation_date into operation_date from public.upload_batches b where b.id = new.batch_id;
  if new.study in ('Tradicional','Moderno') and operation_date >= date '2026-10-01' and coalesce(actual_country, '') = '' then
    raise exception 'La auditoría KO necesita un nombre de país válido, no ID_PAIS.' using errcode = '22023';
  end if;
  changed_assignment := tg_op = 'INSERT';
  if tg_op = 'UPDATE' then changed_assignment := new.assigned_validator_id is distinct from old.assigned_validator_id; end if;
  if new.module = 'smart' and new.study in ('Tradicional','Moderno') and new.assigned_validator_id is not null
    and (changed_assignment or new.status <> 'completada') then
    select m.smart_countries into restricted_countries from public.validator_study_memberships m
    where m.validator_id = new.assigned_validator_id and m.study_id = new.study_id and m.country_id = new.country_id;
    if not private.smart_country_allowed(restricted_countries, actual_country) then
      raise exception 'El validador solo revisa Smart de %. La auditoría pertenece a %.', array_to_string(restricted_countries, ', '), actual_country using errcode = '22023';
    end if;
  end if;
  return new;
end; $$;
create or replace function private.reassign_smart_pending_by_country(
  p_study_id uuid, p_module public.audit_module, p_source_validator_id text, p_target_validator_ids text[]
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare scope_country uuid; active_batch bigint; targets text[]; target_count integer;
  audit_row record; eligible text[]; target_id text; distribution jsonb := '{}'::jsonb; moved integer := 0;
begin
  if auth.uid() is null or not private.is_supervisor() then raise exception 'SUPERVISOR_REQUIRED' using errcode='42501'; end if;
  if p_module <> 'smart' or p_module is null then raise exception 'INVALID_REASSIGNMENT_REQUEST'; end if;
  select sa.country_id into scope_country from public.supervisor_assignments sa
    where sa.supervisor_id=auth.uid() and sa.study_id=p_study_id and sa.module=p_module limit 1;
  if scope_country is null then raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode='42501'; end if;
  select coalesce(array_agg(distinct btrim(t) order by btrim(t)), '{}'::text[]) into targets
    from unnest(p_target_validator_ids) t where nullif(btrim(t),'') is not null;
  if cardinality(targets)=0 or p_source_validator_id=any(targets) then raise exception 'INVALID_REASSIGNMENT_REQUEST'; end if;
  if not exists(select 1 from public.validator_study_memberships m where m.validator_id=p_source_validator_id
    and m.study_id=p_study_id and m.country_id=scope_country) then raise exception 'SOURCE_VALIDATOR_OUT_OF_SCOPE'; end if;
  select count(*) into target_count from public.validator_study_memberships m where m.validator_id=any(targets)
    and m.study_id=p_study_id and m.country_id=scope_country and m.is_active;
  if target_count <> cardinality(targets) then raise exception 'TARGET_VALIDATOR_NOT_ACTIVE_OR_OUT_OF_SCOPE'; end if;
  select b.id into active_batch from public.upload_batches b where b.study_id=p_study_id
    and b.country_id=scope_country and b.module=p_module and b.status='active'
    order by b.operation_date desc,b.id desc limit 1 for update;
  if active_batch is null then raise exception 'ACTIVE_BATCH_NOT_FOUND'; end if;
  for audit_row in select a.id,a.study,a.payload from public.audits a where a.batch_id=active_batch
    and a.assigned_validator_id=p_source_validator_id and a.status='pendiente' order by a.id for update loop
    select array_agg(m.validator_id order by coalesce((distribution->>m.validator_id)::integer,0),m.validator_id)
      into eligible from public.validator_study_memberships m where m.validator_id=any(targets) and m.study_id=p_study_id
      and m.country_id=scope_country and m.is_active and (audit_row.study not in ('Tradicional','Moderno')
        or private.smart_country_allowed(m.smart_countries, audit_row.payload->>'pais'));
    if coalesce(cardinality(eligible),0)=0 then
      raise exception 'Selecciona un destino habilitado para el país %.', audit_row.payload->>'pais';
    end if;
    target_id := eligible[1];
    update public.audits set assigned_validator_id=target_id where id=audit_row.id;
    distribution := jsonb_set(distribution,array[target_id],to_jsonb(coalesce((distribution->>target_id)::integer,0)+1));
    moved := moved+1;
  end loop;
  return jsonb_build_object('active_batch_id',active_batch,'reassigned_count',moved,'distribution',distribution);
end; $$;

revoke all on function private.set_study_validator_smart_countries(text,uuid,uuid,text[],boolean),
  public.set_study_validator_smart_countries(text,uuid,uuid,text[],boolean) from public, anon;
grant execute on function private.set_study_validator_smart_countries(text,uuid,uuid,text[],boolean),
  public.set_study_validator_smart_countries(text,uuid,uuid,text[],boolean) to authenticated;
notify pgrst, 'reload schema';
commit;
