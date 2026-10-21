-- Private, typed Databricks inventory snapshots. Closed months are read once;
-- only the current month's source/version is checked by the scheduled worker.
-- No operational audits, decisions, source exports or access policies change.
begin;
create table if not exists private.metrics_inventory_snapshots (
 source_record_id bigint primary key,
 period_month date not null,
 audit_date date,
 study text,
 audit_external_id text not null,
 country text,region text,channel text,subchannel text,segmento text,auditor text,
 source_filename text not null,
 imported_at timestamptz not null
);
create index if not exists metrics_inventory_snapshots_month_idx
 on private.metrics_inventory_snapshots(period_month,audit_date);
create table if not exists private.metrics_inventory_months (
 period_month date primary key,
 source_filename text not null,
 imported_at timestamptz not null,
 context_version timestamptz,
 refreshed_at timestamptz not null,
 row_count bigint not null
);
alter table private.metrics_inventory_snapshots enable row level security;
alter table private.metrics_inventory_months enable row level security;
revoke all on private.metrics_inventory_snapshots,private.metrics_inventory_months from public,anon,authenticated;

create or replace function private.refresh_metrics_inventory_month(p_month date,p_force boolean default false)
returns bigint language plpgsql security invoker set search_path='' set jit=off set plan_cache_mode=force_custom_plan as $refresh$
declare source_row record; cached record; context_version timestamptz; inserted bigint;
 current_month date:=date_trunc('month',now() at time zone 'America/Bogota')::date;
begin
 if p_month is null or p_month<>date_trunc('month',p_month)::date then raise exception 'A month start is required';end if;
 select * into cached from private.metrics_inventory_months where period_month=p_month;
 if not p_force and p_month<current_month and found then return cached.row_count;end if;
 if not pg_try_advisory_xact_lock(hashtextextended('metrics-inventory:'||p_month::text,0)) then return coalesce(cached.row_count,0);end if;
 select i.source_filename,i.imported_at into source_row from public.admin_analysis_imports i where i.dataset_type='alerts' and i.period_month=p_month;
 if not found then return 0;end if;
 select max(c.verified_at) into context_version from private.audit_report_context_cache c;
 if not p_force and cached.imported_at=source_row.imported_at and cached.context_version is not distinct from context_version then return cached.row_count;end if;
 delete from private.metrics_inventory_snapshots where period_month=p_month;
 insert into private.metrics_inventory_snapshots
 with labels as materialized (
  select study,private.report_context_study(study) canonical_study
  from (select distinct study from public.admin_alert_export_records where period_month=p_month) keys
 )
 select r.id,r.period_month,r.audit_date,r.study,r.audit_external_id,
  case when lower(case when c.audit_external_id is null then r.country else c.metadata->>'country' end) like any(array['%guatemala%','%embocen%']) then 'Guatemala'
   else case when c.audit_external_id is null then r.country else c.metadata->>'country' end end,
  case when c.audit_external_id is null then r.region else c.metadata->>'region' end,
  case when c.audit_external_id is null then r.channel else c.metadata->>'channel' end,
  case when c.audit_external_id is null then r.subchannel else c.metadata->>'subchannel' end,
  case when c.audit_external_id is null then r.segmento else c.metadata->>'segmento' end,
  case when c.audit_external_id is null then r.auditor else c.metadata->>'auditor' end,
  case when c.audit_external_id is null then source_row.source_filename else 'Databricks · catálogo verificado' end,
  source_row.imported_at
 from public.admin_alert_export_records r join labels l on l.study=r.study
 left join private.audit_report_context_cache c on c.audit_external_id=r.audit_external_id and c.study=l.canonical_study
 where r.period_month=p_month and lower(btrim(coalesce(r.audit_status,'')))<>'incidencia';
 get diagnostics inserted=row_count;
 insert into private.metrics_inventory_months values(p_month,source_row.source_filename,source_row.imported_at,context_version,clock_timestamp(),inserted)
 on conflict(period_month) do update set source_filename=excluded.source_filename,imported_at=excluded.imported_at,
  context_version=excluded.context_version,refreshed_at=excluded.refreshed_at,row_count=excluded.row_count;
 return inserted;
end $refresh$;
revoke all on function private.refresh_metrics_inventory_month(date,boolean) from public,anon,authenticated;
commit;

-- Initialize each published month once before switching the reporting reader.
-- Re-running this does not re-read already memorized closed months.
select i.period_month,private.refresh_metrics_inventory_month(i.period_month) as cached_rows
from public.admin_analysis_imports i where i.dataset_type='alerts' order by i.period_month;
analyze private.metrics_inventory_snapshots;
