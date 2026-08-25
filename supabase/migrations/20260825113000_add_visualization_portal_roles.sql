-- Dedicated read-only roles for the Visualizations portal.  Commercial users
-- only receive the executive dashboard in the UI; visualizers receive the
-- operational dashboards and the normalized external analysis imports.

create or replace function private.is_visualization_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.profiles p
      where p.id = (select auth.uid())
        and p.is_active = true
        and p.role in (
          'admin'::public.app_role,
          'visualizer'::public.app_role,
          'commercial'::public.app_role
        )
    );
$$;

create or replace function private.is_standard_visualization_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.profiles p
      where p.id = (select auth.uid())
        and p.is_active = true
        and p.role in ('admin'::public.app_role, 'visualizer'::public.app_role)
    );
$$;

create or replace function private.is_analysis_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.profiles p
      where p.id = (select auth.uid())
        and p.is_active = true
        and p.role in ('admin'::public.app_role, 'visualizer'::public.app_role)
    );
$$;

revoke all on function private.is_visualization_user() from public, anon;
revoke all on function private.is_standard_visualization_user() from public, anon;
revoke all on function private.is_analysis_user() from public, anon;
grant execute on function private.is_visualization_user() to authenticated;
grant execute on function private.is_standard_visualization_user() to authenticated;
grant execute on function private.is_analysis_user() to authenticated;

-- The portal receives read access only.  All existing mutation policies stay
-- restricted to administrators and scoped supervisors.
drop policy if exists upload_batches_select_by_role_and_scope on public.upload_batches;
create policy upload_batches_select_by_role_and_scope
on public.upload_batches for select to authenticated
using (
  (select private.is_visualization_user())
  or (select private.supervisor_has_audit_scope(study_id, country_id, module))
  or (status = 'active' and (select private.validator_has_batch(id)))
);

drop policy if exists audits_select_by_role_scope_and_history on public.audits;
drop policy if exists audits_select_active_by_role_and_scope on public.audits;
create policy audits_select_by_role_scope_and_history
on public.audits for select to authenticated
using (
  (select private.is_visualization_user())
  or (select private.supervisor_has_audit_scope(study_id, country_id, module))
  or (
    (select private.batch_is_active(batch_id))
    and assigned_validator_id = (select private.current_validator_id())
  )
);

drop policy if exists validators_select_by_role_and_scope on public.validators;
create policy validators_select_by_role_and_scope
on public.validators for select to authenticated
using (
  (select private.is_visualization_user())
  or id = (select private.current_validator_id())
  or (select private.supervisor_has_scope(study_id, country_id))
);

create policy profiles_select_visualization_supervisors
on public.profiles for select to authenticated
using (
  (select private.is_standard_visualization_user())
  and role = 'supervisor'::public.app_role
);

create policy supervisor_assignments_select_visualization
on public.supervisor_assignments for select to authenticated
using ((select private.is_standard_visualization_user()));

create policy countries_select_visualization
on public.countries for select to authenticated
using ((select private.is_standard_visualization_user()));

create policy studies_select_visualization
on public.studies for select to authenticated
using ((select private.is_standard_visualization_user()));

-- External exports are intentionally available only to the operational
-- visualizer role (never to the commercial-only role).
drop policy if exists admin_analysis_imports_admin_only on public.admin_analysis_imports;
drop policy if exists admin_alert_export_records_admin_only on public.admin_alert_export_records;
drop policy if exists admin_edit_export_records_admin_only on public.admin_edit_export_records;

create policy admin_analysis_imports_analysis_only
on public.admin_analysis_imports for all to authenticated
using ((select private.is_analysis_user()))
with check ((select private.is_analysis_user()));

create policy admin_alert_export_records_analysis_only
on public.admin_alert_export_records for all to authenticated
using ((select private.is_analysis_user()))
with check ((select private.is_analysis_user()));

create policy admin_edit_export_records_analysis_only
on public.admin_edit_export_records for all to authenticated
using ((select private.is_analysis_user()))
with check ((select private.is_analysis_user()));

-- Operational visualizers may read the compact productivity aggregate without
-- receiving any write path. Supervisors retain their assigned-study scope.
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
  v_country_id uuid;
  v_assigned_module public.audit_module;
begin
  if v_user_id is null or not (v_is_admin or v_is_supervisor or v_is_visualizer) then
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
    )
  group by v.id, v.code, v.name, b.operation_date, a.module
  order by b.operation_date desc, v.name, a.module;
end;
$$;

revoke all on function public.get_validator_history(date, date, public.audit_module, text, uuid) from public, anon;
grant execute on function public.get_validator_history(date, date, public.audit_module, text, uuid) to authenticated;
