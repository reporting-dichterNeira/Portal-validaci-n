-- Reassign only pending audits from one validator to one or more active
-- colleagues. Pending audits are distributed round-robin, preserving every
-- completed or in-progress audit and every other validator assignment.

create or replace function public.reassign_pending_audits(
  p_study_id uuid,
  p_module public.audit_module,
  p_source_validator_id text,
  p_target_validator_ids text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_country_id uuid;
  v_active_batch_id bigint;
  v_target_validator_ids text[];
  v_valid_target_count integer;
  v_reassigned_count integer := 0;
  v_distribution jsonb := '{}'::jsonb;
begin
  if v_user_id is null or not (select private.is_supervisor()) then
    raise exception 'SUPERVISOR_REQUIRED' using errcode = '42501';
  end if;

  if p_study_id is null
    or p_module is null
    or nullif(btrim(p_source_validator_id), '') is null
    or p_target_validator_ids is null
    or cardinality(p_target_validator_ids) = 0 then
    raise exception 'INVALID_REASSIGNMENT_REQUEST' using errcode = '22023';
  end if;

  select coalesce(array_agg(target_id order by first_position), '{}'::text[])
  into v_target_validator_ids
  from (
    select nullif(btrim(raw_target_id), '') as target_id, min(position) as first_position
    from unnest(p_target_validator_ids) with ordinality as targets(raw_target_id, position)
    where nullif(btrim(raw_target_id), '') is not null
    group by nullif(btrim(raw_target_id), '')
  ) normalized_targets;

  if cardinality(v_target_validator_ids) = 0
    or p_source_validator_id = any(v_target_validator_ids) then
    raise exception 'INVALID_REASSIGNMENT_REQUEST' using errcode = '22023';
  end if;

  select sa.country_id
  into v_country_id
  from public.supervisor_assignments sa
  where sa.supervisor_id = v_user_id
    and sa.study_id = p_study_id
    and sa.module = p_module
  limit 1;

  if v_country_id is null then
    raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.validators v
    where v.id = p_source_validator_id
      and v.study_id = p_study_id
      and v.country_id = v_country_id
  ) then
    raise exception 'SOURCE_VALIDATOR_OUT_OF_SCOPE' using errcode = '42501';
  end if;

  select count(*)
  into v_valid_target_count
  from public.validators v
  where v.id = any(v_target_validator_ids)
    and v.study_id = p_study_id
    and v.country_id = v_country_id
    and v.is_active = true;

  if v_valid_target_count <> cardinality(v_target_validator_ids) then
    raise exception 'TARGET_VALIDATOR_NOT_ACTIVE_OR_OUT_OF_SCOPE' using errcode = '42501';
  end if;

  select b.id
  into v_active_batch_id
  from public.upload_batches b
  where b.study_id = p_study_id
    and b.country_id = v_country_id
    and b.module = p_module
    and b.status = 'active'
  order by b.operation_date desc, b.id desc
  limit 1
  for update;

  if v_active_batch_id is null then
    raise exception 'ACTIVE_BATCH_NOT_FOUND' using errcode = '22023';
  end if;

  with pending_audits as (
    select a.id, row_number() over (order by a.id) as sequence_number
    from public.audits a
    where a.batch_id = v_active_batch_id
      and a.module = p_module
      and a.study_id = p_study_id
      and a.country_id = v_country_id
      and a.assigned_validator_id = p_source_validator_id
      and a.status = 'pendiente'::public.audit_status
  ), reassigned_audits as (
    update public.audits a
    set assigned_validator_id = v_target_validator_ids[
      1 + ((pending_audits.sequence_number - 1) % cardinality(v_target_validator_ids))
    ]
    from pending_audits
    where a.id = pending_audits.id
    returning a.assigned_validator_id
  ), distribution as (
    select target_ids.target_validator_id, count(reassigned_audits.assigned_validator_id)::integer as assigned_count
    from unnest(v_target_validator_ids) as target_ids(target_validator_id)
    left join reassigned_audits
      on reassigned_audits.assigned_validator_id = target_ids.target_validator_id
    group by target_ids.target_validator_id
  )
  select coalesce(sum(assigned_count), 0)::integer,
    coalesce(jsonb_object_agg(target_validator_id, assigned_count), '{}'::jsonb)
  into v_reassigned_count, v_distribution
  from distribution;

  return jsonb_build_object(
    'active_batch_id', v_active_batch_id,
    'reassigned_count', v_reassigned_count,
    'target_validator_ids', v_target_validator_ids,
    'distribution', v_distribution
  );
end;
$$;

revoke all on function public.reassign_pending_audits(
  uuid, public.audit_module, text, text[]
) from public, anon;

grant execute on function public.reassign_pending_audits(
  uuid, public.audit_module, text, text[]
) to authenticated;
