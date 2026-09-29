-- Databricks loads into a staging table. The visible monthly export is only
-- replaced after the last batch has arrived and the row count is verified.
create table if not exists public.admin_databricks_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  period_month date not null,
  status text not null default 'starting'
    check (status in ('starting', 'running', 'complete', 'failed')),
  callback_token_hash text not null,
  token_expires_at timestamptz not null,
  rows_staged integer not null default 0 check (rows_staged >= 0),
  context_id text,
  command_id text,
  error_message text,
  started_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint admin_databricks_sync_jobs_period_month_check
    check (period_month = date_trunc('month', period_month)::date)
);

create unique index if not exists admin_databricks_sync_jobs_one_active_month_idx
  on public.admin_databricks_sync_jobs (period_month)
  where status in ('starting', 'running');
create index if not exists admin_databricks_sync_jobs_recent_idx
  on public.admin_databricks_sync_jobs (created_at desc);

create table if not exists public.admin_databricks_sync_stage (
  job_id uuid not null references public.admin_databricks_sync_jobs(id) on delete cascade,
  audit_external_id text not null check (audit_external_id ~ '^[0-9]+$'),
  record jsonb not null,
  primary key (job_id, audit_external_id)
);

alter table public.admin_databricks_sync_jobs enable row level security;
alter table public.admin_databricks_sync_stage enable row level security;
revoke all on table public.admin_databricks_sync_jobs from public, anon, authenticated;
revoke all on table public.admin_databricks_sync_stage from public, anon, authenticated;
grant select, insert, update, delete on table public.admin_databricks_sync_jobs to service_role;
grant select, insert, update, delete on table public.admin_databricks_sync_stage to service_role;

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

  if not found or v_job.status <> 'running' then
    raise exception 'SYNC_JOB_NOT_RUNNING';
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
    'alerts', v_job.period_month, 'Databricks · Reporting Cluster',
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
