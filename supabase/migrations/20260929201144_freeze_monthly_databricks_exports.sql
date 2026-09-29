-- The closing snapshot is published once. The first automated month is
-- September 2026; earlier published exports are frozen at rollout.
alter table public.admin_databricks_sync_jobs
  add column if not exists close_month boolean not null default false;

create table if not exists public.admin_databricks_closed_months (
  period_month date primary key,
  finalized_at timestamptz not null default now(),
  sync_job_id uuid references public.admin_databricks_sync_jobs(id) on delete set null,
  row_count integer not null default 0 check (row_count >= 0),
  constraint admin_databricks_closed_months_period_check
    check (period_month = date_trunc('month', period_month)::date)
);

insert into public.admin_databricks_closed_months (period_month, row_count)
select period_month, row_count
from public.admin_analysis_imports
where dataset_type = 'alerts' and period_month < date '2026-09-01'
on conflict (period_month) do nothing;

alter table public.admin_databricks_closed_months enable row level security;
revoke all on table public.admin_databricks_closed_months from public, anon, authenticated;
grant select, insert on table public.admin_databricks_closed_months to service_role;

-- Keep the reviewed two-argument publisher for its atomic replacement and
-- row-count checks. This wrapper adds calendar and immutable-close rules.
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
    update public.admin_analysis_imports
    set source_filename = 'Databricks · Reporting Cluster (cierre automático)'
    where dataset_type = 'alerts' and period_month = v_period;
  end if;
  return v_count;
end;
$$;

revoke all on function public.finish_admin_databricks_sync(uuid, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.finish_admin_databricks_sync(uuid, integer, boolean)
  to service_role;
