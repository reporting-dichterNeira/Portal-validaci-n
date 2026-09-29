-- Scheduled Databricks runs may stage data, but only an authenticated
-- supervisor can ask the Edge Function to publish a reviewed month.
alter table public.admin_databricks_sync_jobs
  drop constraint if exists admin_databricks_sync_jobs_status_check;
alter table public.admin_databricks_sync_jobs
  add constraint admin_databricks_sync_jobs_status_check
  check (status in ('starting', 'running', 'review', 'complete', 'failed'));

create or replace function public.finish_admin_databricks_sync(
  p_job_id uuid,
  p_expected_count integer
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.admin_databricks_sync_jobs%rowtype;
  v_actual_count integer;
begin
  select * into v_job
  from public.admin_databricks_sync_jobs
  where id = p_job_id
  for update;

  if not found or v_job.status <> 'review' then
    raise exception 'SYNC_JOB_NOT_REVIEWED';
  end if;

  if exists (
    select 1 from public.admin_databricks_sync_jobs newer
    where newer.period_month = v_job.period_month
      and newer.created_at > v_job.created_at
      and newer.status in ('running', 'review', 'complete')
  ) then
    raise exception 'SYNC_NEWER_STAGE_EXISTS';
  end if;

  select count(*) into v_actual_count
  from public.admin_databricks_sync_stage
  where job_id = p_job_id;

  if p_expected_count is null or p_expected_count < 1 or
     v_actual_count <> p_expected_count then
    raise exception 'SYNC_ROW_COUNT_MISMATCH: expected %, received %',
      p_expected_count, v_actual_count;
  end if;

  if exists (
    select 1 from public.admin_analysis_imports
    where dataset_type = 'alerts'
      and period_month = v_job.period_month
      and imported_at > v_job.created_at
  ) then
    raise exception 'SYNC_NEWER_MONTHLY_IMPORT_EXISTS';
  end if;

  delete from public.admin_alert_export_records
  where period_month = v_job.period_month;

  insert into public.admin_alert_export_records (
    audit_external_id, period_month, is_alert, audit_status, alert_status,
    alert_label, pdv_id, pdv_name, pdv_note, country, channel, city,
    auditor, audit_date, wave, study
  )
  select
    stage.audit_external_id,
    v_job.period_month,
    true,
    nullif(stage.record ->> 'audit_status', ''),
    null,
    null,
    nullif(stage.record ->> 'pdv_id', ''),
    null,
    null,
    nullif(stage.record ->> 'country', ''),
    nullif(stage.record ->> 'channel', ''),
    nullif(stage.record ->> 'city', ''),
    nullif(stage.record ->> 'auditor', ''),
    nullif(stage.record ->> 'audit_date', '')::date,
    nullif(stage.record ->> 'wave', ''),
    nullif(stage.record ->> 'study', '')
  from public.admin_databricks_sync_stage as stage
  where stage.job_id = p_job_id;

  insert into public.admin_analysis_imports (
    dataset_type, period_month, source_filename, row_count, imported_at, imported_by
  ) values (
    'alerts', v_job.period_month, 'Databricks · Reporting Cluster (revisado)',
    v_actual_count, now(), v_job.started_by
  )
  on conflict (dataset_type, period_month) do update set
    source_filename = excluded.source_filename,
    row_count = excluded.row_count,
    imported_at = excluded.imported_at,
    imported_by = excluded.imported_by;

  update public.admin_databricks_sync_jobs
  set status = 'complete', rows_staged = v_actual_count,
      callback_token_hash = '', updated_at = now()
  where id = p_job_id;

  delete from public.admin_databricks_sync_stage where job_id = p_job_id;
  return v_actual_count;
end;
$$;

revoke all on function public.finish_admin_databricks_sync(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.finish_admin_databricks_sync(uuid, integer)
  to service_role;
