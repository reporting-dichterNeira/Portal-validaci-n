-- Carry unfinished work into the next active daily batch while preserving the
-- prior batch as history. Also expose an admin-only cleanup for test audit data.

alter table public.upload_batches
  add column carried_over_count integer not null default 0,
  add column carryover_summary jsonb not null default '[]'::jsonb,
  add constraint upload_batches_carried_over_nonnegative
    check (carried_over_count >= 0),
  add constraint upload_batches_carryover_summary_array
    check (jsonb_typeof(carryover_summary) = 'array');

alter table public.audits
  add column carried_from_audit_id bigint
    references public.audits(id) on delete set null;

create index audits_carried_from_audit_id_idx
  on public.audits (carried_from_audit_id)
  where carried_from_audit_id is not null;

create or replace function public.activate_upload_batch(p_batch_id bigint)
returns public.upload_batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_batch public.upload_batches%rowtype;
  v_previous_batch_id bigint;
  v_previous_operation_date date;
  v_actual_count integer;
  v_carried_count integer := 0;
  v_carryover_summary jsonb := '[]'::jsonb;
begin
  if v_user_id is null or not (select private.is_supervisor()) then
    raise exception 'SUPERVISOR_REQUIRED' using errcode = '42501';
  end if;

  select * into v_batch
  from public.upload_batches
  where id = p_batch_id
  for update;

  if not found
    or v_batch.status <> 'draft'
    or v_batch.created_by <> v_user_id
    or not (select private.supervisor_has_audit_scope(
      v_batch.study_id, v_batch.country_id, v_batch.module
    )) then
    raise exception 'UPLOAD_BATCH_NOT_AVAILABLE' using errcode = '42501';
  end if;

  select b.id, b.operation_date
  into v_previous_batch_id, v_previous_operation_date
  from public.upload_batches b
  where b.module = v_batch.module
    and b.study_id = v_batch.study_id
    and b.country_id = v_batch.country_id
    and b.status = 'active'
    and b.id <> p_batch_id
  order by b.operation_date desc, b.id desc
  limit 1
  for update;

  if v_previous_batch_id is not null
    and v_batch.operation_date > v_previous_operation_date then
    with carried as (
      insert into public.audits as target (
        module,
        batch_id,
        external_id,
        study,
        study_id,
        country_id,
        assigned_validator_id,
        status,
        audit_date,
        validation_date,
        payload,
        validation_results,
        started_at,
        completed_at,
        duration_seconds,
        created_by,
        carried_from_audit_id
      )
      select
        old.module,
        p_batch_id,
        old.external_id,
        old.study,
        old.study_id,
        old.country_id,
        old.assigned_validator_id,
        old.status,
        v_batch.operation_date,
        null,
        old.payload || jsonb_build_object(
          '_carriedOver', true,
          '_carriedFromDate', v_previous_operation_date::text
        ),
        old.validation_results,
        null,
        null,
        null,
        v_user_id,
        old.id
      from public.audits old
      where old.batch_id = v_previous_batch_id
        and old.status <> 'completada'::public.audit_status
      on conflict (batch_id, external_id) do update
      set assigned_validator_id = excluded.assigned_validator_id,
          status = excluded.status,
          validation_date = null,
          validation_results = excluded.validation_results,
          started_at = null,
          completed_at = null,
          duration_seconds = null,
          carried_from_audit_id = excluded.carried_from_audit_id,
          payload = target.payload || jsonb_build_object(
            '_carriedOver', true,
            '_carriedFromDate', excluded.payload ->> '_carriedFromDate'
          )
      returning assigned_validator_id
    ), per_validator as (
      select
        carried.assigned_validator_id as validator_id,
        coalesce(v.name, 'Sin asignar') as validator_name,
        count(*)::integer as item_count
      from carried
      left join public.validators v on v.id = carried.assigned_validator_id
      group by carried.assigned_validator_id, v.name
    )
    select
      coalesce(sum(item_count), 0)::integer,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'validator_id', validator_id,
            'validator_name', validator_name,
            'count', item_count
          ) order by validator_name
        ),
        '[]'::jsonb
      )
    into v_carried_count, v_carryover_summary
    from per_validator;
  end if;

  select count(*)::integer into v_actual_count
  from public.audits
  where batch_id = p_batch_id;

  if v_actual_count < 1 then
    raise exception 'UPLOAD_BATCH_EMPTY' using errcode = '22023';
  end if;

  update public.upload_batches
  set status = 'archived', archived_at = now()
  where module = v_batch.module
    and study_id = v_batch.study_id
    and country_id = v_batch.country_id
    and status = 'active'
    and id <> p_batch_id;

  update public.upload_batches
  set status = 'active',
      row_count = v_actual_count,
      carried_over_count = v_carried_count,
      carryover_summary = v_carryover_summary,
      activated_at = now(),
      archived_at = null
  where id = p_batch_id
  returning * into v_batch;

  return v_batch;
end;
$$;

revoke all on function public.activate_upload_batch(bigint) from public, anon;
grant execute on function public.activate_upload_batch(bigint) to authenticated;

create or replace function public.purge_all_audit_data(p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_audits_deleted integer := 0;
  v_batches_deleted integer := 0;
begin
  if (select auth.uid()) is null or not (select private.is_admin()) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  if p_confirmation is distinct from 'ELIMINAR PRUEBAS' then
    raise exception 'INVALID_PURGE_CONFIRMATION' using errcode = '22023';
  end if;

  delete from public.audits;
  get diagnostics v_audits_deleted = row_count;

  delete from public.upload_batches;
  get diagnostics v_batches_deleted = row_count;

  return jsonb_build_object(
    'audits_deleted', v_audits_deleted,
    'batches_deleted', v_batches_deleted
  );
end;
$$;

revoke all on function public.purge_all_audit_data(text) from public, anon;
grant execute on function public.purge_all_audit_data(text) to authenticated;
