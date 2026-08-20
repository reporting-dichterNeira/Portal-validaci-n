-- Allow one supervisor to operate several studies while every action remains
-- explicitly scoped to the study selected in the portal.

alter table public.supervisor_assignments
  drop constraint if exists supervisor_assignments_one_scope_per_supervisor;

alter table public.supervisor_assignments
  drop constraint if exists supervisor_assignments_unique_scope;

alter table public.supervisor_assignments
  add constraint supervisor_assignments_unique_scope
  unique (supervisor_id, study_id, country_id, module);

-- Uploads must name the study selected by the supervisor. Authorization still
-- comes from the assignment table, never from client-provided labels.
drop function if exists public.create_upload_batch(
  public.audit_module, date, text, integer
);

create function public.create_upload_batch(
  p_study_id uuid,
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
  v_country_id uuid;
  v_result public.upload_batches%rowtype;
begin
  if v_user_id is null or not (select private.is_supervisor()) then
    raise exception 'SUPERVISOR_REQUIRED' using errcode = '42501';
  end if;

  if p_study_id is null then
    raise exception 'STUDY_REQUIRED' using errcode = '22023';
  end if;

  if p_operation_date is null then
    raise exception 'OPERATION_DATE_REQUIRED' using errcode = '22023';
  end if;

  if p_row_count is null or p_row_count < 1 or p_row_count > 50000 then
    raise exception 'INVALID_ROW_COUNT' using errcode = '22023';
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

  insert into public.upload_batches (
    module, study_id, country_id, operation_date,
    source_filename, row_count, status, created_by
  ) values (
    p_module, p_study_id, v_country_id, p_operation_date,
    left(coalesce(p_source_filename, ''), 255), p_row_count, 'draft', v_user_id
  )
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.create_upload_batch(
  uuid, public.audit_module, date, text, integer
) from public, anon;
grant execute on function public.create_upload_batch(
  uuid, public.audit_module, date, text, integer
) to authenticated;

drop function if exists public.archive_active_batches(public.audit_module);

create function public.archive_active_batches(
  p_study_id uuid,
  p_module public.audit_module
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_country_id uuid;
  v_count integer;
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

  if v_country_id is null then
    raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode = '42501';
  end if;

  update public.upload_batches
  set status = 'archived', archived_at = now()
  where module = p_module
    and study_id = p_study_id
    and country_id = v_country_id
    and status = 'active';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.archive_active_batches(
  uuid, public.audit_module
) from public, anon;
grant execute on function public.archive_active_batches(
  uuid, public.audit_module
) to authenticated;

drop function if exists public.search_audit_history(
  text, public.audit_module, integer
);

create function public.search_audit_history(
  p_query text,
  p_module public.audit_module default null,
  p_limit integer default 25,
  p_study_id uuid default null
)
returns table (
  id bigint,
  batch_id bigint,
  module public.audit_module,
  external_id text,
  study text,
  study_id uuid,
  country_id uuid,
  assigned_validator_id text,
  status public.audit_status,
  audit_date date,
  validation_date date,
  payload jsonb,
  validation_results jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  duration_seconds integer,
  created_at timestamptz,
  updated_at timestamptz,
  batch_operation_date date,
  batch_status text,
  batch_source_filename text,
  validator_code text,
  validator_name text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_is_admin boolean := (select private.is_admin());
  v_is_supervisor boolean := (select private.is_supervisor());
begin
  if (select auth.uid()) is null or not (v_is_admin or v_is_supervisor) then
    raise exception 'STAFF_REQUIRED' using errcode = '42501';
  end if;

  if v_query = '' or length(v_query) > 200 then
    raise exception 'INVALID_SEARCH_QUERY' using errcode = '22023';
  end if;

  if v_is_supervisor and (
    p_study_id is null
    or not exists (
      select 1
      from public.supervisor_assignments sa
      where sa.supervisor_id = (select auth.uid())
        and sa.study_id = p_study_id
        and (p_module is null or sa.module = p_module)
    )
  ) then
    raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode = '42501';
  end if;

  return query
  select
    a.id,
    a.batch_id,
    a.module,
    a.external_id,
    a.study,
    a.study_id,
    a.country_id,
    a.assigned_validator_id,
    a.status,
    a.audit_date,
    a.validation_date,
    a.payload,
    a.validation_results,
    a.started_at,
    a.completed_at,
    a.duration_seconds,
    a.created_at,
    a.updated_at,
    b.operation_date,
    b.status,
    b.source_filename,
    v.code,
    v.name
  from public.audits a
  join public.upload_batches b on b.id = a.batch_id
  left join public.validators v on v.id = a.assigned_validator_id
  where b.status in ('active', 'archived')
    and (p_module is null or a.module = p_module)
    and (p_study_id is null or a.study_id = p_study_id)
    and (
      lower(a.external_id) = v_query
      or lower(coalesce(a.payload ->> 'idPDV', '')) = v_query
    )
  order by b.operation_date desc, a.id desc
  limit v_limit;
end;
$$;

revoke all on function public.search_audit_history(
  text, public.audit_module, integer, uuid
) from public, anon, authenticated;
grant execute on function public.search_audit_history(
  text, public.audit_module, integer, uuid
) to authenticated;

drop function if exists public.get_validator_history(
  date, date, public.audit_module, text
);

create function public.get_validator_history(
  p_date_from date,
  p_date_to date,
  p_module public.audit_module default null,
  p_validator_id text default null,
  p_study_id uuid default null
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
    if p_study_id is null then
      raise exception 'STUDY_REQUIRED' using errcode = '22023';
    end if;

    select sa.country_id, sa.module
    into v_country_id, v_assigned_module
    from public.supervisor_assignments sa
    where sa.supervisor_id = v_user_id
      and sa.study_id = p_study_id
      and (p_module is null or sa.module = p_module)
    limit 1;

    if v_assigned_module is null then
      raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode = '42501';
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
    and (p_validator_id is null or a.assigned_validator_id = p_validator_id)
    and (
      (v_is_admin and (p_study_id is null or a.study_id = p_study_id))
      or (
        v_is_supervisor
        and a.study_id = p_study_id
        and a.country_id = v_country_id
        and a.module = v_assigned_module
      )
    )
  group by v.id, v.code, v.name, b.operation_date, a.module
  order by b.operation_date desc, v.name, a.module;
end;
$$;

revoke all on function public.get_validator_history(
  date, date, public.audit_module, text, uuid
) from public, anon;
grant execute on function public.get_validator_history(
  date, date, public.audit_module, text, uuid
) to authenticated;
