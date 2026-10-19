begin;
create temporary table live_context_tests(check_name text,result jsonb);
do $$
begin
 if has_function_privilege('authenticated','public.ingest_report_context(jsonb)','EXECUTE')
  or has_function_privilege('anon','public.ingest_report_context(jsonb)','EXECUTE')
  or has_function_privilege('authenticated','public.report_context_sync_ids(text,integer)','EXECUTE')
  or has_function_privilege('anon','public.report_context_sync_ids(text,integer)','EXECUTE')
  or has_table_privilege('authenticated','private.audit_report_context_cache','SELECT') then
  raise exception 'Reporting synchronization is exposed to portal users';
 end if;
end $$;
set local role service_role;
select public.report_context_sync_ids('',1);
reset role;
do $$ declare p record; data jsonb; item jsonb; begin
 for p in select distinct on(role) id,role from public.profiles
  where is_active and role::text in ('admin','commercial') order by role,id loop
  perform set_config('request.jwt.claim.sub',p.id::text,true);
  data:=public.get_audit_report_context('[{"id":"5601215","study":"Chile"}]');
  item:=data->0;
  if jsonb_array_length(data)<>1 or item->>'region' is distinct from 'TALCA'
   or item->>'channel' is distinct from 'HOME MARKET TRADICIONAL' or item->>'segmento' is distinct from 'ORO' then
   raise exception 'Late arrival metadata is incomplete for %: %',p.role,data;
  end if;
  insert into live_context_tests values(p.role::text,item-'auditor');
 end loop;
 begin
  perform public.ingest_report_context('[{"audit_external_id":"99999999999999999999999","study":"Chile","source_rows":1}]');
  raise exception 'Unknown identity accepted';
 exception when invalid_parameter_value then null;end;
end $$;
select * from live_context_tests;
rollback;
