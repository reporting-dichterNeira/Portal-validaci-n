-- Run after cache-metrics-inventory.sql. Verify the complete response against
-- the live reader before switching it. The public RPC and its auth stay intact.
begin;
set local statement_timeout='90s';
create temporary table metrics_cache_verification(filters jsonb,before_ms numeric,after_ms numeric,equal_response boolean);
create table if not exists private.metrics_inventory_reader_backup(version text primary key,definition text not null,saved_at timestamptz default now());
alter table private.metrics_inventory_reader_backup enable row level security;
revoke all on private.metrics_inventory_reader_backup from public,anon,authenticated;
do $verify$
declare original text; candidate text; start_pos integer; end_pos integer; f jsonb;
 old_result jsonb; new_result jsonb; started timestamptz; old_ms numeric; new_ms numeric; metric_key text;
begin
 if exists(select 1 from public.admin_analysis_imports i left join private.metrics_inventory_months m using(period_month)
  where i.dataset_type='alerts' and m.period_month is null) then raise exception 'Initialize all published months before switching';end if;
 original:=pg_get_functiondef('private.get_databricks_audit_totals(jsonb)'::regprocedure);
 if position('/* cached-inventory-months */' in original)>0 then return;end if;
 start_pos:=position('with report_study_keys as materialized' in original);
 end_pos:=position(' study_keys as materialized' in original)+1;
 if start_pos=0 or end_pos<=start_pos then raise exception 'Live inventory CTE not recognized';end if;
 candidate:=left(original,start_pos-1)||$base$
 with base as materialized (
  select r.study,r.audit_external_id,r.country,r.region,r.channel,r.subchannel,r.segmento,r.auditor,r.source_filename,r.imported_at
  from private.metrics_inventory_snapshots r /* cached-inventory-months */
  where (coalesce(p_filters->>'month','')='' or r.period_month=((p_filters->>'month')||'-01')::date)
   and (coalesce(p_filters->>'from','')='' or r.audit_date >= (p_filters->>'from')::date)
   and (coalesce(p_filters->>'to','')='' or r.audit_date <= (p_filters->>'to')::date)
 ), $base$||substring(original from end_pos);
 candidate:=replace(candidate,'from public.admin_analysis_imports i where i.dataset_type=''alerts''',
  'from private.metrics_inventory_months i where true');
 candidate:=replace(candidate,'private.get_databricks_audit_totals(','private.metrics_inventory_reader_probe(');
 execute candidate;
 revoke all on function private.metrics_inventory_reader_probe(jsonb) from public,anon,authenticated;
 perform set_config('request.jwt.claim.sub',(select id::text from public.profiles where is_active and role::text='commercial' limit 1),true);
 for f in select value from jsonb_array_elements('[
  {"include_auditors":true,"include_channel_segments":true},
  {"studies":["Chile"],"month":"2026-08"},
  {"studies":["Lindley"],"month":"2026-09","country":"Perú"},
  {"month":"2026-10","country":"Guatemala","include_auditors":true},
  {"month":"2026-10","region":"TALCA","channel":"HOME MARKET TRADICIONAL","include_channel_segments":true},
  {"studies":["Chile"],"month":"2026-10","from":"2026-10-01","to":"2026-10-10"}
 ]') loop
  started:=clock_timestamp();old_result:=private.get_databricks_audit_totals(f);old_ms:=extract(epoch from clock_timestamp()-started)*1000;
  started:=clock_timestamp();new_result:=private.metrics_inventory_reader_probe(f);new_ms:=extract(epoch from clock_timestamp()-started)*1000;
  -- JSON aggregate arrays have no specified SQL order; compare their complete
  -- contents canonically. The dashboard applies its own volume ranking.
  for metric_key in select key from jsonb_each(old_result) where jsonb_typeof(value)='array' loop
   old_result:=jsonb_set(old_result,array[metric_key],coalesce((select jsonb_agg(v order by v::text) from jsonb_array_elements(old_result->metric_key)v),'[]'));
   new_result:=jsonb_set(new_result,array[metric_key],coalesce((select jsonb_agg(v order by v::text) from jsonb_array_elements(new_result->metric_key)v),'[]'));
  end loop;
  if old_result is distinct from new_result then raise exception 'Cached inventory differs for % in %',f,
   (select array_agg(key) from jsonb_each(old_result) where value is distinct from new_result->key);end if;
  if new_ms>=7000 then raise exception 'Cached reader is still too slow: %ms',new_ms;end if;
  insert into metrics_cache_verification values(f,old_ms,new_ms,true);
 end loop;
 insert into private.metrics_inventory_reader_backup(version,definition) values('before-monthly-cache-2026-10-21',original) on conflict(version) do nothing;
 execute replace(candidate,'private.metrics_inventory_reader_probe(','private.get_databricks_audit_totals(');
 drop function private.metrics_inventory_reader_probe(jsonb);
end $verify$;
select cron.schedule('metrics-inventory-current-month','*/5 * * * *',
 $$select private.refresh_metrics_inventory_month(date_trunc('month',now() at time zone 'America/Bogota')::date);$$);
notify pgrst,'reload schema';
select * from metrics_cache_verification;
commit;
