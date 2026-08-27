-- Restore validator access to their own aggregate productivity after the
-- visualization-role update. The validator identity comes only from the
-- authenticated validator session, never from a client parameter.

create or replace function public.get_validator_history(
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
  v_is_visualizer boolean := (select private.is_standard_visualization_user());
  v_validator_id text := (select private.current_validator_id());
  v_country_id uuid;
  v_assigned_module public.audit_module;
begin
  if v_user_id is null or not (v_is_admin or v_is_supervisor or v_is_visualizer or v_validator_id is not null) then
    raise exception 'STAFF_REQUIRED' using errcode = '42501';
  end if;
  if p_date_from is null or p_date_to is null or p_date_from > p_date_to then
    raise exception 'INVALID_DATE_RANGE' using errcode = '22023';
  end if;
  if p_date_to - p_date_from > 3650 then
    raise exception 'DATE_RANGE_TOO_LARGE' using errcode = '22023';
  end if;
  if v_is_supervisor then
    if p_study_id is null then raise exception 'STUDY_REQUIRED' using errcode = '22023'; end if;
    select sa.country_id, sa.module into v_country_id, v_assigned_module
      from public.supervisor_assignments sa
      where sa.supervisor_id = v_user_id and sa.study_id = p_study_id
        and (p_module is null or sa.module = p_module)
      limit 1;
    if v_assigned_module is null then raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode = '42501'; end if;
  end if;
  return query
  select v.id, v.code, v.name, b.operation_date, a.module,
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
      v_is_admin or v_is_visualizer
      or (v_is_supervisor and a.study_id = p_study_id and a.country_id = v_country_id and a.module = v_assigned_module)
      or (v_validator_id is not null and a.assigned_validator_id = v_validator_id)
    )
  group by v.id, v.code, v.name, b.operation_date, a.module
  order by b.operation_date desc, v.name, a.module;
end;
$$;

revoke all on function public.get_validator_history(date, date, public.audit_module, text, uuid) from public, anon;
grant execute on function public.get_validator_history(date, date, public.audit_module, text, uuid) to authenticated;
