-- Every supervisor belongs to exactly one operational module. Existing
-- supervisors keep the regular Smart flow so the rollout does not remove
-- their current access.
alter table public.supervisor_assignments
  add column if not exists module public.audit_module not null default 'smart';

create or replace function private.supervisor_has_audit_scope(
  p_study_id uuid,
  p_country_id uuid,
  p_module public.audit_module
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_study_id is not null
    and p_country_id is not null
    and p_module is not null
    and exists (
      select 1
      from public.supervisor_assignments sa
      join public.profiles p on p.id = sa.supervisor_id
      where sa.supervisor_id = (select auth.uid())
        and sa.study_id = p_study_id
        and sa.country_id = p_country_id
        and sa.module = p_module
        and p.role = 'supervisor'::public.app_role
        and p.is_active = true
    );
$$;

revoke all on function private.supervisor_has_audit_scope(
  uuid, uuid, public.audit_module
) from public, anon;
grant execute on function private.supervisor_has_audit_scope(
  uuid, uuid, public.audit_module
) to authenticated;

drop policy if exists upload_batches_select_by_role_and_scope on public.upload_batches;
create policy upload_batches_select_by_role_and_scope
on public.upload_batches for select to authenticated
using (
  (select private.is_admin())
  or (select private.supervisor_has_audit_scope(study_id, country_id, module))
  or (
    status = 'active'
    and (select private.validator_has_batch(id))
  )
);

drop policy if exists upload_batches_insert_by_scope on public.upload_batches;
create policy upload_batches_insert_by_scope
on public.upload_batches for insert to authenticated
with check (
  (select private.is_admin())
  or (
    created_by = (select auth.uid())
    and (select private.supervisor_has_audit_scope(study_id, country_id, module))
  )
);

drop policy if exists upload_batches_update_by_scope on public.upload_batches;
create policy upload_batches_update_by_scope
on public.upload_batches for update to authenticated
using (
  (select private.is_admin())
  or (select private.supervisor_has_audit_scope(study_id, country_id, module))
)
with check (
  (select private.is_admin())
  or (select private.supervisor_has_audit_scope(study_id, country_id, module))
);

drop policy if exists audits_select_by_role_scope_and_history on public.audits;
drop policy if exists audits_select_active_by_role_and_scope on public.audits;
create policy audits_select_by_role_scope_and_history
on public.audits for select to authenticated
using (
  (select private.is_admin())
  or (select private.supervisor_has_audit_scope(study_id, country_id, module))
  or (
    (select private.batch_is_active(batch_id))
    and assigned_validator_id = (select private.current_validator_id())
  )
);

drop policy if exists audits_insert_by_role_and_scope on public.audits;
create policy audits_insert_by_role_and_scope
on public.audits for insert to authenticated
with check (
  (select private.is_admin())
  or (select private.supervisor_has_audit_scope(study_id, country_id, module))
);

drop policy if exists audits_update_by_role_and_scope on public.audits;
create policy audits_update_by_role_and_scope
on public.audits for update to authenticated
using (
  (select private.is_admin())
  or (select private.supervisor_has_audit_scope(study_id, country_id, module))
)
with check (
  (select private.is_admin())
  or (select private.supervisor_has_audit_scope(study_id, country_id, module))
);

create or replace function public.create_upload_batch(
  p_module public.audit_module,
  p_operation_date date,
  p_source_filename text,
  p_row_count integer
)
returns public.upload_batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_study_id uuid;
  v_country_id uuid;
  v_assigned_module public.audit_module;
  v_result public.upload_batches%rowtype;
begin
  if v_user_id is null or not (select private.is_supervisor()) then
    raise exception 'SUPERVISOR_REQUIRED' using errcode = '42501';
  end if;

  if p_operation_date is null then
    raise exception 'OPERATION_DATE_REQUIRED' using errcode = '22023';
  end if;

  if p_row_count is null or p_row_count < 1 or p_row_count > 50000 then
    raise exception 'INVALID_ROW_COUNT' using errcode = '22023';
  end if;

  select sa.study_id, sa.country_id, sa.module
  into v_study_id, v_country_id, v_assigned_module
  from public.supervisor_assignments sa
  where sa.supervisor_id = v_user_id;

  if v_study_id is null or v_country_id is null or v_assigned_module is null then
    raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode = '42501';
  end if;

  if p_module is distinct from v_assigned_module then
    raise exception 'MODULE_NOT_ASSIGNED' using errcode = '42501';
  end if;

  insert into public.upload_batches (
    module, study_id, country_id, operation_date,
    source_filename, row_count, status, created_by
  ) values (
    v_assigned_module, v_study_id, v_country_id, p_operation_date,
    left(coalesce(p_source_filename, ''), 255), p_row_count, 'draft', v_user_id
  )
  returning * into v_result;

  return v_result;
end;
$$;

create or replace function public.activate_upload_batch(p_batch_id bigint)
returns public.upload_batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_batch public.upload_batches%rowtype;
  v_actual_count integer;
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
      activated_at = now(),
      archived_at = null
  where id = p_batch_id
  returning * into v_batch;

  return v_batch;
end;
$$;

create or replace function public.archive_active_batches(p_module public.audit_module)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_study_id uuid;
  v_country_id uuid;
  v_assigned_module public.audit_module;
  v_count integer;
begin
  if v_user_id is null or not (select private.is_supervisor()) then
    raise exception 'SUPERVISOR_REQUIRED' using errcode = '42501';
  end if;

  select sa.study_id, sa.country_id, sa.module
  into v_study_id, v_country_id, v_assigned_module
  from public.supervisor_assignments sa
  where sa.supervisor_id = v_user_id;

  if p_module is distinct from v_assigned_module then
    raise exception 'MODULE_NOT_ASSIGNED' using errcode = '42501';
  end if;

  update public.upload_batches
  set status = 'archived', archived_at = now()
  where module = v_assigned_module
    and study_id = v_study_id
    and country_id = v_country_id
    and status = 'active';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.get_validator_history(
  p_date_from date,
  p_date_to date,
  p_module public.audit_module default null,
  p_validator_id text default null
)
returns table (
  validator_id text,
  validator_code text,
  validator_name text,
  operation_date date,
  module public.audit_module,
  total_audits bigint,
  completed_audits bigint,
  in_progress_audits bigint,
  pending_audits bigint,
  timed_audits bigint,
  total_duration_seconds bigint,
  average_duration_seconds integer,
  first_activity_at timestamptz,
  last_activity_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_is_admin boolean := (select private.is_admin());
  v_is_supervisor boolean := (select private.is_supervisor());
  v_study_id uuid;
  v_country_id uuid;
  v_assigned_module public.audit_module;
begin
  if v_user_id is null or not (v_is_admin or v_is_supervisor) then
    raise exception 'STAFF_REQUIRED' using errcode = '42501';
  end if;

  if p_date_from is null or p_date_to is null or p_date_from > p_date_to then
    raise exception 'INVALID_DATE_RANGE' using errcode = '22023';
  end if;

  if p_date_to - p_date_from > 3650 then
    raise exception 'DATE_RANGE_TOO_LARGE' using errcode = '22023';
  end if;

  if v_is_supervisor then
    select sa.study_id, sa.country_id, sa.module
    into v_study_id, v_country_id, v_assigned_module
    from public.supervisor_assignments sa
    where sa.supervisor_id = v_user_id;

    if v_assigned_module is null
      or (p_module is not null and p_module is distinct from v_assigned_module) then
      raise exception 'MODULE_NOT_ASSIGNED' using errcode = '42501';
    end if;
  end if;

  return query
  select
    v.id,
    v.code,
    v.name,
    b.operation_date,
    a.module,
    count(*)::bigint,
    count(*) filter (where a.status = 'completada'::public.audit_status)::bigint,
    count(*) filter (where a.status = 'en_progreso'::public.audit_status)::bigint,
    count(*) filter (where a.status = 'pendiente'::public.audit_status)::bigint,
    count(a.duration_seconds)::bigint,
    coalesce(sum(a.duration_seconds), 0)::bigint,
    coalesce(round(avg(a.duration_seconds) filter (where a.duration_seconds is not null)), 0)::integer,
    min(coalesce(a.started_at, a.created_at)),
    max(coalesce(a.completed_at, a.started_at, a.updated_at))
  from public.audits a
  join public.upload_batches b on b.id = a.batch_id
  join public.validators v on v.id = a.assigned_validator_id
  where b.status in ('active', 'archived')
    and b.operation_date between p_date_from and p_date_to
    and (p_module is null or a.module = p_module)
    and (not v_is_supervisor or a.module = v_assigned_module)
    and (p_validator_id is null or a.assigned_validator_id = p_validator_id)
    and (
      v_is_admin
      or (
        a.study_id = v_study_id
        and a.country_id = v_country_id
        and a.module = v_assigned_module
      )
    )
  group by v.id, v.code, v.name, b.operation_date, a.module
  order by b.operation_date desc, v.name, a.module;
end;
$$;

revoke all on function public.get_validator_history(
  date, date, public.audit_module, text
) from public, anon;
grant execute on function public.get_validator_history(
  date, date, public.audit_module, text
) to authenticated;
