-- The same atomic publisher now serves daily current-month snapshots and
-- the final prior-month close. Closed months remain immutable to this flow.
create or replace function public.finish_admin_databricks_sync(
  p_job_id uuid,
  p_expected_count integer,
  p_close_month boolean
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_period date;
  v_count integer;
  v_current_month date := date_trunc('month', now() at time zone 'America/Bogota')::date;
begin
  select period_month into v_period
  from public.admin_databricks_sync_jobs
  where id = p_job_id and status = 'review';

  if v_period is null then
    raise exception 'SYNC_JOB_NOT_REVIEWED';
  end if;
  if v_period < date '2026-09-01' or exists (
    select 1 from public.admin_databricks_closed_months
    where period_month = v_period
  ) then
    raise exception 'SYNC_MONTH_FROZEN';
  end if;
  if p_close_month then
    if v_period <> (v_current_month - interval '1 month')::date then
      raise exception 'SYNC_NOT_PREVIOUS_MONTH';
    end if;
  elsif v_period <> v_current_month then
    raise exception 'SYNC_ONLY_CURRENT_MONTH';
  end if;

  v_count := public.finish_admin_databricks_sync(p_job_id, p_expected_count);
  if p_close_month then
    insert into public.admin_databricks_closed_months (period_month, sync_job_id, row_count)
    values (v_period, p_job_id, v_count);
  end if;
  update public.admin_analysis_imports
  set source_filename = case when p_close_month
    then 'Databricks · Reporting Cluster (cierre automático)'
    else 'Databricks · Reporting Cluster (sincronización diaria)'
  end
  where dataset_type = 'alerts' and period_month = v_period;
  return v_count;
end;
$$;
