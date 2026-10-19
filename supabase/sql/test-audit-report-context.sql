begin;
create temporary table report_context_results(role text,checked_rows integer,elapsed_ms numeric);
do $test$
declare profile record; data jsonb; started timestamptz; identity jsonb;
begin
 for profile in select distinct on(p.role) p.id,p.role::text as role from public.profiles p
 where p.is_active and p.role::text in ('admin','visualizer','commercial') order by p.role,p.id loop
 perform set_config('request.jwt.claim.sub',profile.id::text,true);
 started:=clock_timestamp();
 data:=public.get_audit_report_context('[{"id":"5689246","study":"Chile"},{"id":"5692890","study":"Chile"},{"id":"5695658","study":"Chile"},{"id":"5695983","study":"Chile"}]');
 if jsonb_array_length(data)<>4 or not exists(select 1 from jsonb_array_elements(data)r
 where r->>'audit_external_id'='5692890' and r->>'region'='TEMUCO' and r->>'channel'='HOME MARKET TRADICIONAL') then raise exception 'Incorrect requested metadata for %',profile.role; end if;
 if public.get_audit_report_context('[{"id":"5692890","study":"Moderno"}]')<>'[]'::jsonb then raise exception 'Cross-study match'; end if;
 insert into report_context_results values(profile.role,4,extract(epoch from clock_timestamp()-started)*1000);
 end loop;
 for profile in select p.id from public.profiles p where p.is_active and p.role::text='supervisor'
 and not exists(select 1 from public.supervisor_assignments sa join public.audits a
 on a.study_id=sa.study_id and a.country_id=sa.country_id and a.module=sa.module
 where sa.supervisor_id=p.id and a.external_id='5692890' and a.study='Chile') limit 1 loop
 perform set_config('request.jwt.claim.sub',profile.id::text,true);
 if public.get_audit_report_context('[{"id":"5692890","study":"Chile"}]')<>'[]'::jsonb then raise exception 'Supervisor outside scope allowed'; end if;
 end loop;
 -- Also test a realistic bounded request under the commercial role.
 perform set_config('request.jwt.claim.sub',(select id::text from public.profiles where is_active and role::text='commercial' limit 1),true);
 select jsonb_agg(jsonb_build_object('id',external_id,'study',study)) into identity
 from(select distinct external_id,study from public.audits limit 500)a;
 perform public.get_audit_report_context(identity);
 begin
 perform public.get_audit_report_context((select jsonb_agg(jsonb_build_object('id','5692890','study','Chile')) from generate_series(1,501)));
 raise exception 'Oversized request allowed'; exception when invalid_parameter_value then null; end;
 perform set_config('request.jwt.claim.sub','',true);
 begin
 perform public.get_audit_report_context('[]');raise exception 'Unauthenticated access allowed';
 exception when insufficient_privilege then null;end;
 if has_function_privilege('anon','public.get_audit_report_context(jsonb)','EXECUTE') then raise exception 'Anonymous RPC access allowed'; end if;
end $test$;
select * from report_context_results;
rollback;
