-- Read-only integration checks under actual authenticated-role permissions.
-- Only temporary test tables are written; the transaction is rolled back.
begin;
create temporary table connection_test_profiles as
select distinct on(role) id,role::text as role from public.profiles
where is_active and role::text in ('admin','commercial','supervisor') order by role,id;
create temporary table connection_test_results(role text,check_name text,detail jsonb);
grant select on connection_test_profiles to authenticated;
grant insert,select on connection_test_results to authenticated;
set local role authenticated;
do $test$
declare p record; result jsonb; plan jsonb; module_name text; started timestamptz;
begin
 for p in select * from connection_test_profiles loop
  perform set_config('request.jwt.claim.sub',p.id::text,true);
  started:=clock_timestamp();
  result:=public.get_databricks_audit_totals('{"month":"2026-10"}');
  if jsonb_typeof(result)<>'object' then raise exception 'Invalid totals response';end if;
  insert into connection_test_results values(p.role,'monthly_totals',jsonb_build_object('ok',true,'ms',extract(epoch from clock_timestamp()-started)*1000));
  result:=public.get_audit_report_context('[{"id":"5692890","study":"Chile"}]');
  if p.role in ('admin','commercial') and not exists(select 1 from jsonb_array_elements(result)r where r->>'region'='TEMUCO' and r->>'channel'='HOME MARKET TRADICIONAL') then raise exception 'Incorrect Databricks metadata';end if;
  insert into connection_test_results values(p.role,'report_context',jsonb_build_object('ok',true,'rows',jsonb_array_length(result)));
  foreach module_name in array array['smart','blocking'] loop
   execute format('explain(analyze,buffers,format json) select a.id,a.payload,a.validation_results,b.operation_date,v.name from public.audits a join public.upload_batches b on b.id=a.batch_id and b.status in (''active'',''archived'') left join public.validators v on v.id=a.assigned_validator_id where a.module=%L::public.audit_module and a.id>0 order by a.id limit 500',module_name) into plan;
   insert into connection_test_results values(p.role,'history_'||module_name,jsonb_build_object('ok',true,'ms',plan->0->'Execution Time','rows',plan->0->'Plan'->'Actual Rows'));
  end loop;
  if p.role='admin' then
   result:=public.pqr_api('context','{}');
   if result->>'role' is distinct from 'admin' then raise exception 'PQR admin context unavailable';end if;
   insert into connection_test_results values(p.role,'pqr_context','{"ok":true}');
  end if;
 end loop;
end $test$;
reset role;
do $test$
declare missing text[];
begin
 select array_agg(name) into missing from unnest(array[
 'claim_validator_code','available_module_validators','set_validator_module','resolve_previous_pending',
 'create_upload_batch','activate_upload_batch','save_audit_progress_v2','save_audit_progress','remove_study_validator',
 'set_study_validator_smart_country','set_study_validator_smart_countries','reassign_pending_audits',
 'reassign_smart_pending_by_country','archive_active_batches','get_validator_history','purge_all_audit_data',
 'delete_upload_batch','search_audit_history','search_global_audit_history','get_visible_batch_uploaders',
 'get_pending_carryover_summary','get_pending_management','get_databricks_audit_totals','get_audit_report_context',
 'pqr_api','pqr_login','finish_admin_databricks_sync'])r(name)
 where not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=r.name);
 if missing is not null then raise exception 'Missing portal RPCs: %',missing;end if;
 insert into connection_test_results values('all','rpc_catalog','{"ok":true,"checked":27}');
 if (select count(*) from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename in ('audits','upload_batches'))<>2 then raise exception 'Realtime publication incomplete';end if;
 insert into connection_test_results values('all','realtime_tables','{"ok":true,"checked":2}');
end $test$;
select * from connection_test_results order by role,check_name;
rollback;
