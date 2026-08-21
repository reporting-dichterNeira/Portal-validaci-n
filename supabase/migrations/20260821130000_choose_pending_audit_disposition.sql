-- Let the assigned supervisor decide what happens to unfinished work before
-- activating tomorrow's batch. Discarding means closing it out of the active
-- operation while preserving the original batch in history.

alter table public.upload_batches
  add column if not exists pending_disposition text not null default 'not_applicable',
  add column if not exists discarded_pending_count integer not null default 0;

alter table public.upload_batches
  drop constraint if exists upload_batches_pending_disposition_check,
  add constraint upload_batches_pending_disposition_check
    check (pending_disposition in ('not_applicable', 'carry', 'discard')),
  drop constraint if exists upload_batches_discarded_pending_nonnegative,
  add constraint upload_batches_discarded_pending_nonnegative
    check (discarded_pending_count >= 0);

create or replace function public.get_pending_carryover_summary(
  p_study_id uuid,
  p_module public.audit_module,
  p_operation_date date
)
returns table (
  previous_batch_id bigint,
  previous_operation_date date,
  pending_count integer,
  pending_summary jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_country_id uuid;
  v_previous_batch_id bigint;
  v_previous_operation_date date;
  v_pending_count integer;
begin
  if v_user_id is null or not (select private.is_supervisor()) then
    raise exception 'SUPERVISOR_REQUIRED' using errcode = '42501';
  end if;

  select sa.country_id
  into v_country_id
  from public.supervisor_assignments sa
  where sa.supervisor_id = v_user_id
    and sa.study_id = p_study_id
    and sa.module = p_module
  limit 1;

  if v_country_id is null or p_operation_date is null then
    raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode = '42501';
  end if;

  select b.id, b.operation_date
  into v_previous_batch_id, v_previous_operation_date
  from public.upload_batches b
  where b.study_id = p_study_id
    and b.country_id = v_country_id
    and b.module = p_module
    and b.status = 'active'
    and b.operation_date < p_operation_date
  order by b.operation_date desc, b.id desc
  limit 1;

  if v_previous_batch_id is null then
    return;
  end if;

  select count(*)::integer
  into v_pending_count
  from public.audits a
  where a.batch_id = v_previous_batch_id
    and a.status <> 'completada'::public.audit_status;

  if v_pending_count < 1 then
    return;
  end if;

  return query
  with by_validator as (
    select
      a.assigned_validator_id as validator_id,
      coalesce(v.name, 'Sin asignar') as validator_name,
      count(*)::integer as item_count
    from public.audits a
    left join public.validators v on v.id = a.assigned_validator_id
    where a.batch_id = v_previous_batch_id
      and a.status <> 'completada'::public.audit_status
    group by a.assigned_validator_id, v.name
  )
  select
    v_previous_batch_id,
    v_previous_operation_date,
    v_pending_count,
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
  from by_validator;
end;
$$;

revoke all on function public.get_pending_carryover_summary(
  uuid, public.audit_module, date
) from public, anon;
grant execute on function public.get_pending_carryover_summary(
  uuid, public.audit_module, date
) to authenticated;

create or replace function public.activate_upload_batch(
  p_batch_id bigint,
  p_carryover_action text default 'carry'
)
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
  v_action text := lower(coalesce(nullif(btrim(p_carryover_action), ''), 'carry'));
  v_actual_count integer;
  v_pending_count integer := 0;
  v_carried_count integer := 0;
  v_discarded_count integer := 0;
  v_pending_disposition text := 'not_applicable';
  v_carryover_summary jsonb := '[]'::jsonb;
begin
  if v_user_id is null or not (select private.is_supervisor()) then
    raise exception 'SUPERVISOR_REQUIRED' using errcode = '42501';
  end if;

  if v_action not in ('carry', 'discard') then
    raise exception 'INVALID_PENDING_DISPOSITION' using errcode = '22023';
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
    select count(*)::integer
    into v_pending_count
    from public.audits old
    where old.batch_id = v_previous_batch_id
      and old.status <> 'completada'::public.audit_status;

    if v_pending_count > 0 then
      v_pending_disposition := v_action;
      if v_action = 'discard' then
        v_discarded_count := v_pending_count;
      else
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
    end if;
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
      pending_disposition = v_pending_disposition,
      discarded_pending_count = v_discarded_count,
      activated_at = now(),
      archived_at = null
  where id = p_batch_id
  returning * into v_batch;

  return v_batch;
end;
$$;

revoke all on function public.activate_upload_batch(bigint, text) from public, anon;
grant execute on function public.activate_upload_batch(bigint, text) to authenticated;
