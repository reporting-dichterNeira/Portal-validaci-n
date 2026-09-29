-- These tables predate the Databricks integration and explicitly revoke
-- service_role. The atomic publisher requires only these table privileges.
-- RLS remains enabled and no anon/authenticated privileges are added.
grant select, insert, update, delete
  on public.admin_analysis_imports,
     public.admin_alert_export_records
  to service_role;
grant usage, select on sequence public.admin_alert_export_records_id_seq
  to service_role;
