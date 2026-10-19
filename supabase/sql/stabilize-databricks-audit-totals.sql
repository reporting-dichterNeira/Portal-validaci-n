-- Run this first statement separately (outside a transaction). Concurrent
-- creation keeps the daily Databricks synchronization writable.
create index concurrently if not exists admin_alert_export_records_metrics_cover_idx
on public.admin_alert_export_records(period_month,audit_date)
include(study,audit_external_id,country,region,channel,subchannel,segmento,auditor);

-- Keep the function body, authorization and response contract unchanged.
-- Avoid JIT overhead and replan for each actual combination of optional filters.
alter function private.get_databricks_audit_totals(jsonb) set jit=off;
alter function private.get_databricks_audit_totals(jsonb) set plan_cache_mode=force_custom_plan;
analyze public.admin_alert_export_records;
