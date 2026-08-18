-- Allow supervisors to consult every active or archived audit in their own
-- assigned scope. Validators remain restricted to their currently active batch.

drop policy if exists audits_select_active_by_role_and_scope on public.audits;

create policy audits_select_by_role_scope_and_history
on public.audits for select to authenticated
using (
  (select private.is_admin())
  or (select private.supervisor_has_scope(study_id, country_id))
  or (
    (select private.batch_is_active(batch_id))
    and assigned_validator_id = (select private.current_validator_id())
  )
);

-- The historical report is read in keyset order and explicitly filtered by
-- scope/module. These indexes keep reads bounded as the daily history grows.
create index if not exists audits_history_scope_page_idx
  on public.audits (study_id, country_id, module, id);

create index if not exists audits_history_external_lookup_idx
  on public.audits (module, lower(external_id), id desc);

create index if not exists audits_history_pdv_lookup_idx
  on public.audits (module, lower((payload ->> 'idPDV')), id desc)
  where (payload ->> 'idPDV') is not null;

create or replace function public.search_audit_history(
  p_query text,
  p_module public.audit_module default null,
  p_limit integer default 25
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
begin
  if (select auth.uid()) is null
    or not ((select private.is_admin()) or (select private.is_supervisor())) then
    raise exception 'STAFF_REQUIRED' using errcode = '42501';
  end if;

  if v_query = '' or length(v_query) > 200 then
    raise exception 'INVALID_SEARCH_QUERY' using errcode = '22023';
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
    and (
      lower(a.external_id) = v_query
      or lower(coalesce(a.payload ->> 'idPDV', '')) = v_query
    )
  order by b.operation_date desc, a.id desc
  limit v_limit;
end;
$$;

revoke all on function public.search_audit_history(
  text, public.audit_module, integer
) from public, anon, authenticated;

grant execute on function public.search_audit_history(
  text, public.audit_module, integer
) to authenticated;

-- The aggregate history remains a small response even across several years.
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
    select sa.study_id, sa.country_id
    into v_study_id, v_country_id
    from public.supervisor_assignments sa
    where sa.supervisor_id = v_user_id;
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
      v_is_admin
      or (a.study_id = v_study_id and a.country_id = v_country_id)
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
