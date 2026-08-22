-- Move only pending audits from one validator to a specific active colleague.
-- The scope and current active batch are resolved server-side; the browser never
-- chooses a batch, country, or audit list to update.

create or replace function public.reassign_pending_audits(
  p_study_id uuid,
  p_module public.audit_module,
  p_source_validator_id text,
  p_target_validator_id text
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
  v_reassigned_count integer := 0;
begin
  if v_user_id is null or not (select private.is_supervisor()) then
    raise exception 'SUPERVISOR_REQUIRED' using errcode = '42501';
  end if;

  if p_study_id is null
    or p_module is null
    or nullif(btrim(p_source_validator_id), '') is null
    or nullif(btrim(p_target_validator_id), '') is null
    or p_source_validator_id = p_target_validator_id then
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

  if not exists (
    select 1
    from public.validators v
    where v.id = p_target_validator_id
      and v.study_id = p_study_id
      and v.country_id = v_country_id
      and v.is_active = true
  ) then
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

  update public.audits a
  set assigned_validator_id = p_target_validator_id
  where a.batch_id = v_active_batch_id
    and a.module = p_module
    and a.study_id = p_study_id
    and a.country_id = v_country_id
    and a.assigned_validator_id = p_source_validator_id
    and a.status = 'pendiente'::public.audit_status;

  get diagnostics v_reassigned_count = row_count;

  return jsonb_build_object(
    'active_batch_id', v_active_batch_id,
    'reassigned_count', v_reassigned_count
  );
end;
$$;

revoke all on function public.reassign_pending_audits(
  uuid, public.audit_module, text, text
) from public, anon;
grant execute on function public.reassign_pending_audits(
  uuid, public.audit_module, text, text
) to authenticated;
