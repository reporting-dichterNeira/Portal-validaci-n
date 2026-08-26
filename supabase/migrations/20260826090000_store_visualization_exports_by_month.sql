-- Keep the latest consolidated version for each reference month.  Operational
-- alert/audit history is intentionally untouched; this applies only to the
-- two normalized datasets used by the Visualizations portal.

alter table public.admin_analysis_imports
  add column if not exists period_month date;

update public.admin_analysis_imports
set period_month = date_trunc('month', imported_at)::date
where period_month is null;

alter table public.admin_analysis_imports
  alter column period_month set default date_trunc('month', current_date)::date,
  alter column period_month set not null;

alter table public.admin_analysis_imports
  drop constraint if exists admin_analysis_imports_pkey;

alter table public.admin_analysis_imports
  add constraint admin_analysis_imports_pkey primary key (dataset_type, period_month),
  add constraint admin_analysis_imports_period_month_check
    check (period_month = date_trunc('month', period_month)::date);

alter table public.admin_alert_export_records
  add column if not exists period_month date;

update public.admin_alert_export_records records
set period_month = coalesce(
  (select imports.period_month
   from public.admin_analysis_imports imports
   where imports.dataset_type = 'alerts'
   order by imports.period_month desc
   limit 1),
  date_trunc('month', current_date)::date
)
where period_month is null;

alter table public.admin_alert_export_records
  alter column period_month set not null,
  add constraint admin_alert_export_records_period_month_check
    check (period_month = date_trunc('month', period_month)::date);

alter table public.admin_edit_export_records
  add column if not exists period_month date;

update public.admin_edit_export_records records
set period_month = coalesce(
  (select imports.period_month
   from public.admin_analysis_imports imports
   where imports.dataset_type = 'editions'
   order by imports.period_month desc
   limit 1),
  date_trunc('month', current_date)::date
)
where period_month is null;

alter table public.admin_edit_export_records
  alter column period_month set not null,
  add constraint admin_edit_export_records_period_month_check
    check (period_month = date_trunc('month', period_month)::date);

create index if not exists admin_alert_export_records_period_audit_idx
  on public.admin_alert_export_records (period_month, audit_external_id);

create index if not exists admin_edit_export_records_period_audit_idx
  on public.admin_edit_export_records (period_month, audit_external_id);
