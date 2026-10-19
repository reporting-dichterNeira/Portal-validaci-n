begin;
create temporary table metrics_baseline(filters jsonb primary key,data jsonb,before_ms numeric,after_ms numeric);
do $before$
declare f jsonb; response jsonb; started timestamptz;
begin
 perform set_config('request.jwt.claim.sub',(select id::text from public.profiles where role::text='commercial' and is_active limit 1),true);
 for f in select value from jsonb_array_elements('[{}, {"month":"2026-10"}, {"month":"2026-09"}, {"studies":["Chile"]}, {"country":"Perú"}, {"from":"2026-10-05","to":"2026-10-15"}, {"month":"2026-10","include_auditors":true}, {"include_channel_segments":true}, {"studies":["Lindley"],"region":"REGION LIMA"}]') loop
 started:=clock_timestamp(); response:=public.get_databricks_audit_totals(f);
 -- Result array order is unspecified. Compare every returned value, sorted.
 select jsonb_object_agg(k,case when jsonb_typeof(v)='array' then coalesce((select jsonb_agg(item order by item::text) from jsonb_array_elements(v)item),'[]'::jsonb) else v end) into response from jsonb_each(response)e(k,v);
 insert into metrics_baseline values(f,response,extract(epoch from clock_timestamp()-started)*1000,null);
 end loop;
end $before$;
alter function private.get_databricks_audit_totals(jsonb) set jit=off;
alter function private.get_databricks_audit_totals(jsonb) set plan_cache_mode=force_custom_plan;
do $after$
declare f jsonb; response jsonb; started timestamptz; original jsonb;
begin
 for f,original in select filters,data from metrics_baseline loop
 started:=clock_timestamp(); response:=public.get_databricks_audit_totals(f);
 select jsonb_object_agg(k,case when jsonb_typeof(v)='array' then coalesce((select jsonb_agg(item order by item::text) from jsonb_array_elements(v)item),'[]'::jsonb) else v end) into response from jsonb_each(response)e(k,v);
 if response is distinct from original then raise exception 'Metrics changed for %',f; end if;
 update metrics_baseline set after_ms=extract(epoch from clock_timestamp()-started)*1000 where filters=f;
 end loop;
 perform set_config('request.jwt.claim.sub','',true);
 begin
 perform public.get_databricks_audit_totals('{}'::jsonb);
 raise exception 'Unauthenticated request unexpectedly allowed';
 exception when insufficient_privilege then null;
 end;
end $after$;
select filters,round(before_ms,1) as before_ms,round(after_ms,1) as after_ms,true as same_results from metrics_baseline;
rollback;
