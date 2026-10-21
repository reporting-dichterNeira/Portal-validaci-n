-- Read-only checks of cache completeness, access and month-specific refresh.
begin;
create temporary table cached_metrics_results(check_name text,detail jsonb);
do $test$
declare f jsonb; result jsonb; started timestamptz; cached_at timestamptz; month_key date;
begin
 if has_table_privilege('authenticated','private.metrics_inventory_snapshots','select')
  or has_table_privilege('anon','private.metrics_inventory_snapshots','select')
  or has_table_privilege('authenticated','private.metrics_inventory_months','select')
  or has_function_privilege('authenticated','private.refresh_metrics_inventory_month(date,boolean)','execute') then
  raise exception 'Private inventory cache is exposed';end if;
 insert into cached_metrics_results values('private_access','{"ok":true}');
 select min(period_month) into month_key from private.metrics_inventory_months
  where period_month<date_trunc('month',now() at time zone 'America/Bogota')::date;
 select refreshed_at into cached_at from private.metrics_inventory_months where period_month=month_key;
 perform private.refresh_metrics_inventory_month(month_key);
 if (select refreshed_at from private.metrics_inventory_months where period_month=month_key) is distinct from cached_at then
  raise exception 'A closed month was unnecessarily refreshed';end if;
 insert into cached_metrics_results values('closed_month_reused',jsonb_build_object('ok',true,'month',month_key));
 if not exists(select 1 from cron.job where jobname='metrics-inventory-current-month' and active
  and command like '%refresh_metrics_inventory_month(date_trunc%') then raise exception 'Current month refresh is not scheduled';end if;
 insert into cached_metrics_results values('current_month_refresh','{"ok":true,"interval_minutes":5}');
 perform set_config('request.jwt.claim.sub',(select id::text from public.profiles where is_active and role::text='commercial' limit 1),true);
 for f in select value from jsonb_array_elements('[{}, {"month":"2026-08"}, {"month":"2026-09"}, {"month":"2026-10"},
  {"include_auditors":true,"include_channel_segments":true}, {"country":"Chile"}, {"country":"Perú"}, {"country":"Colombia"}, {"country":"Ecuador"},
  {"country":"Guatemala"}, {"country":"Panamá"}, {"country":"Costa Rica"}, {"country":"El Salvador"},
  {"country":"Honduras"}, {"country":"Nicaragua"}, {"country":"República Dominicana"},
  {"studies":["Chile"],"month":"2026-08"}, {"studies":["Lindley"],"month":"2026-09"}]') loop
  started:=clock_timestamp();result:=public.get_databricks_audit_totals(f);
  if jsonb_typeof(result)<>'object' then raise exception 'Invalid response for %',f;end if;
  insert into cached_metrics_results values('cached_totals',jsonb_build_object('filters',f,'ms',round(extract(epoch from clock_timestamp()-started)*1000,1),
   'total',(select coalesce(sum((r->>'databricks_total')::bigint),0) from jsonb_array_elements(result->'studies')r)));
 end loop;
 perform set_config('request.jwt.claim.sub','',true);
 begin
  perform public.get_databricks_audit_totals('{}');
  raise exception 'Unauthenticated request was accepted';
 exception when insufficient_privilege then
  insert into cached_metrics_results values('authentication_required','{"ok":true}');
 end;
end $test$;
select jsonb_build_object('checks',(select jsonb_agg(jsonb_build_object('check',check_name,'detail',detail)) from cached_metrics_results),
 'latest_refresh',(select jsonb_build_object('status',d.status,'started',d.start_time,'finished',d.end_time,'message',d.return_message)
 from cron.job_run_details d join cron.job j using(jobid) where j.jobname='metrics-inventory-current-month' order by d.start_time desc limit 1)) as verification;
rollback;
