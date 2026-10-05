begin;

-- country_id is the supervisor's access scope (often GLB), NOT the country
-- of the audit. Keep the actual country in payload.pais and the Smart-only
-- assignment restriction on this study's membership.
alter table public.validator_study_memberships
  add column if not exists smart_country text not null default '';

create or replace function private.audit_country_key(value text)
returns text language sql immutable strict set search_path = '' as $$
  select regexp_replace(lower(translate(btrim(value), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')), '[^a-z]', '', 'g');
$$;

create or replace function private.normalize_audit_country(value text)
returns text language sql immutable set search_path = '' as $$
  select case private.audit_country_key(coalesce(value, ''))
    when '' then '' when 'glb' then '' when 'global' then '' when 'sindato' then '' when 'sinpais' then '' when 'na' then ''
    when 'pa' then 'Panamá' when 'panama' then 'Panamá'
    when 'cr' then 'Costa Rica' when 'costarica' then 'Costa Rica'
    when 'gt' then 'Guatemala' when 'guatemala' then 'Guatemala'
    when 'sv' then 'El Salvador' when 'elsalvador' then 'El Salvador'
    when 'hn' then 'Honduras' when 'honduras' then 'Honduras'
    when 'ni' then 'Nicaragua' when 'nicaragua' then 'Nicaragua'
    when 'pe' then 'Perú' when 'peru' then 'Perú'
    when 'cl' then 'Chile' when 'chile' then 'Chile'
    when 'co' then 'Colombia' when 'colombia' then 'Colombia'
    when 'ec' then 'Ecuador' when 'ecuador' then 'Ecuador'
    when 'mx' then 'México' when 'mexico' then 'México'
    when 'do' then 'República Dominicana' when 'republicadominicana' then 'República Dominicana'
    else btrim(value) end;
$$;

create or replace function private.enforce_smart_audit_country()
returns trigger language plpgsql security definer set search_path = '' as $$
declare actual_country text; restricted_country text; operation_date date; changed_assignment boolean;
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
    select m.smart_country into restricted_country from public.validator_study_memberships m
    where m.validator_id = new.assigned_validator_id and m.study_id = new.study_id and m.country_id = new.country_id;
    if coalesce(restricted_country, '') <> '' and private.audit_country_key(restricted_country) <> private.audit_country_key(coalesce(actual_country, '')) then
      raise exception 'El validador solo revisa Smart de %. La auditoría pertenece a %.', restricted_country, actual_country using errcode = '22023';
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists audits_smart_country on public.audits;
create trigger audits_smart_country before insert or update of payload, study, assigned_validator_id on public.audits
for each row execute function private.enforce_smart_audit_country();

create or replace function private.set_study_validator_smart_country(
  p_validator_id text, p_study_id uuid, p_country_id uuid, p_smart_country text, p_active boolean
) returns void language plpgsql security definer set search_path = '' as $$
declare selected_country text; study_name text;
begin
  if auth.uid() is null or not private.supervisor_has_scope(p_study_id, p_country_id)
    or not exists(select 1 from public.supervisor_assignments sa where sa.supervisor_id=auth.uid()
      and sa.study_id=p_study_id and sa.country_id=p_country_id and sa.module='smart') then
    raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode='42501';
  end if;
  select s.name into study_name from public.studies s where s.id=p_study_id;
  if study_name not in ('Tradicional','Moderno') then raise exception 'El filtro de país solo aplica a KO Tradicional y KO Moderno.'; end if;
  selected_country := private.normalize_audit_country(p_smart_country);
  if nullif(btrim(p_smart_country), '') is not null and coalesce(selected_country,'') = '' then raise exception 'País inválido.'; end if;
  perform 1 from public.validators where id=p_validator_id for update;
  perform 1 from public.validator_study_memberships m where m.validator_id=p_validator_id
    and m.study_id=p_study_id and m.country_id=p_country_id for update;
  if not found then raise exception 'VALIDATOR_OUT_OF_SCOPE' using errcode='42501'; end if;
  if coalesce(selected_country,'') <> '' and exists(select 1 from public.audits a join public.upload_batches b on b.id=a.batch_id
    where a.assigned_validator_id=p_validator_id and a.study_id=p_study_id and a.country_id=p_country_id
    and a.module='smart' and a.status='en_progreso' and b.status='active'
    and private.audit_country_key(coalesce(a.payload->>'pais','')) <> private.audit_country_key(selected_country)) then
    raise exception 'Termina las auditorías en progreso de otro país antes de cambiar el país.';
  end if;
  update public.validator_study_memberships set smart_country=coalesce(selected_country,'')
    where validator_id=p_validator_id and study_id=p_study_id and country_id=p_country_id;
  if p_active is not null then
    perform private.manage_validator_membership(p_validator_id,p_study_id,p_country_id,p_active,false);
  end if;
  -- Remove only incompatible pending assignments; never modify completed work.
  update public.audits a set assigned_validator_id=null from public.upload_batches b
    where b.id=a.batch_id and b.status='active' and a.module='smart' and a.status='pendiente'
    and a.assigned_validator_id=p_validator_id and a.study_id=p_study_id and a.country_id=p_country_id
    and coalesce(selected_country,'') <> ''
    and private.audit_country_key(coalesce(a.payload->>'pais','')) <> private.audit_country_key(selected_country);
end; $$;

create or replace function public.set_study_validator_smart_country(
  p_validator_id text, p_study_id uuid, p_country_id uuid, p_smart_country text, p_active boolean default null
) returns void language sql security invoker set search_path = '' as $$
  select private.set_study_validator_smart_country(p_validator_id,p_study_id,p_country_id,p_smart_country,p_active);
$$;

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
        or m.smart_country='' or private.audit_country_key(m.smart_country)=private.audit_country_key(coalesce(audit_row.payload->>'pais','')));
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
create or replace function public.reassign_smart_pending_by_country(
  p_study_id uuid, p_module public.audit_module, p_source_validator_id text, p_target_validator_ids text[]
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.reassign_smart_pending_by_country(p_study_id,p_module,p_source_validator_id,p_target_validator_ids);
$$;

revoke all on function private.enforce_smart_audit_country() from public, anon, authenticated;
revoke all on function private.audit_country_key(text), private.normalize_audit_country(text),
  private.set_study_validator_smart_country(text,uuid,uuid,text,boolean),
  public.set_study_validator_smart_country(text,uuid,uuid,text,boolean),
  private.reassign_smart_pending_by_country(uuid,public.audit_module,text,text[]),
  public.reassign_smart_pending_by_country(uuid,public.audit_module,text,text[]) from public, anon;
grant execute on function private.set_study_validator_smart_country(text,uuid,uuid,text,boolean),
  public.set_study_validator_smart_country(text,uuid,uuid,text,boolean),
  private.reassign_smart_pending_by_country(uuid,public.audit_module,text,text[]),
  public.reassign_smart_pending_by_country(uuid,public.audit_module,text,text[]) to authenticated;

notify pgrst, 'reload schema';
commit;
