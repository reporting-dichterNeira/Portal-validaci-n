-- Normalized administrative imports. The portal keeps the current useful
-- columns only; raw exports and bulky question-level details are not stored.

create table if not exists public.admin_analysis_imports (
  dataset_type text primary key check (dataset_type in ('alerts', 'editions')),
  source_filename text not null,
  row_count integer not null default 0 check (row_count >= 0),
  imported_at timestamptz not null default now(),
  imported_by uuid references auth.users(id) on delete set null
);

create table if not exists public.admin_alert_export_records (
  id bigint generated always as identity primary key,
  audit_external_id text not null,
  is_alert boolean not null default false,
  audit_status text,
  alert_status text,
  alert_label text,
  pdv_id text,
  pdv_name text,
  country text,
  channel text,
  city text,
  auditor text,
  audit_date date,
  wave text,
  study text
);

create table if not exists public.admin_edit_export_records (
  id bigint generated always as identity primary key,
  audit_external_id text not null,
  study text,
  country text,
  audit_status text,
  wave text,
  modifications_count integer not null default 0 check (modifications_count >= 0),
  status_changes_count integer not null default 0 check (status_changes_count >= 0),
  first_validation_started_at timestamptz,
  first_validation_completed_at timestamptz,
  first_validator text,
  last_validation_started_at timestamptz,
  last_validation_completed_at timestamptz,
  last_validator text
);

create index if not exists admin_alert_export_records_audit_id_idx
  on public.admin_alert_export_records (audit_external_id);
create index if not exists admin_alert_export_records_alert_idx
  on public.admin_alert_export_records (is_alert, auditor, city, country);
create index if not exists admin_edit_export_records_audit_id_idx
  on public.admin_edit_export_records (audit_external_id);

alter table public.admin_analysis_imports enable row level security;
alter table public.admin_alert_export_records enable row level security;
alter table public.admin_edit_export_records enable row level security;

revoke all on table public.admin_analysis_imports from anon, authenticated;
revoke all on table public.admin_alert_export_records from anon, authenticated;
revoke all on table public.admin_edit_export_records from anon, authenticated;

grant select, insert, update, delete on table public.admin_analysis_imports to authenticated;
grant select, insert, update, delete on table public.admin_alert_export_records to authenticated;
grant select, insert, update, delete on table public.admin_edit_export_records to authenticated;
grant usage, select on sequence public.admin_alert_export_records_id_seq to authenticated;
grant usage, select on sequence public.admin_edit_export_records_id_seq to authenticated;

create policy admin_analysis_imports_admin_only
on public.admin_analysis_imports for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

create policy admin_alert_export_records_admin_only
on public.admin_alert_export_records for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

create policy admin_edit_export_records_admin_only
on public.admin_edit_export_records for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));
