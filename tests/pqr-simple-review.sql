-- All QA changes, sessions, evaluations and exclusions roll back.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $qa$
declare r private.pqr_reviews%rowtype; actor uuid:=gen_random_uuid(); other_actor uuid:=gen_random_uuid();
 other_analyst uuid; response jsonb; results jsonb; before_source jsonb; evaluation text; rejected boolean;
begin
 assert not has_table_privilege('authenticated','private.pqr_active_reviews','select,insert,update,delete');
 assert not has_table_privilege('anon','private.pqr_active_reviews','select');
 assert (select 'security_invoker=true'=any(reloptions) from pg_class where oid='private.pqr_active_reviews'::regclass);
 select * into strict r from private.pqr_active_reviews x where x.analyst_id is not null and x.status<>'completed'
  and not exists(select 1 from jsonb_array_elements(x.kpis) k where coalesce(x.original_results->(k->>'name')->>'status','') not in ('aplica','no_aplica'))
  order by x.day desc limit 1;
 select to_jsonb(a) into before_source from public.audits a where a.id=r.source_audit_id;
 insert into auth.users(id,aud,role,is_anonymous) values(actor,'authenticated','authenticated',true),(other_actor,'authenticated','authenticated',true);
 insert into private.pqr_sessions(user_id,analyst_id) values(actor,r.analyst_id);
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 response:=public.pqr_api('start',jsonb_build_object('id',r.id));
 foreach evaluation in array array['correct','incorrect'] loop
  select jsonb_object_agg(k->>'name',jsonb_build_object('evaluation',evaluation,'correct_decision','','comment','')) into results from jsonb_array_elements(r.kpis) k;
  rejected:=false;
  begin perform public.pqr_api('save',jsonb_build_object('id',r.id,'version',-1,'results',results));exception when serialization_failure then rejected:=true;end;
  assert rejected,'Version check must remain intact';
  response:=public.pqr_api('save',jsonb_build_object('id',r.id,'version',(response->>'version')::integer,'results',results,'complete',false));
  assert response->'review_results'=results,'Optional blank details must save for both decisions';
 end loop;
 rejected:=false;
 begin perform public.pqr_api('save',jsonb_build_object('id',r.id,'version',(response->>'version')::integer,'results','{}'::jsonb,'complete',true));exception when raise_exception then rejected:=true;end;
 assert rejected,'Every KPI is still required at completion';
 response:=public.pqr_api('save',jsonb_build_object('id',r.id,'version',(response->>'version')::integer,'results',results,'complete',true));
 assert response->>'status'='completed' and response->>'verdict'='errors';
 rejected:=false;
 begin perform public.pqr_api('save',jsonb_build_object('id',r.id,'version',(response->>'version')::integer,'results',results));exception when insufficient_privilege then rejected:=true;end;
 assert rejected,'Completed work must remain read-only';
 execute 'reset role';
 select id into other_analyst from private.pqr_analysts where id<>r.analyst_id and active and deleted_at is null limit 1;
 assert other_analyst is not null;
 insert into private.pqr_sessions(user_id,analyst_id) values(other_actor,other_analyst);
 perform set_config('request.jwt.claim.sub',other_actor::text,true);
 execute 'set local role authenticated';
 rejected:=false;
 begin perform public.pqr_api('detail',jsonb_build_object('id',r.id));exception when insufficient_privilege then rejected:=true;end;
 assert rejected,'Analysts must never read another analyst assignment';
 execute 'reset role';
 update private.pqr_reviews set excluded_at=clock_timestamp(),exclusion_reason='QA rollback only' where id=r.id;
 assert not exists(select 1 from private.pqr_active_reviews where id=r.id);
 assert exists(select 1 from private.pqr_reviews where id=r.id and review_results=results);
 assert exists(select 1 from private.pqr_events where review_id=r.id);
 perform set_config('request.jwt.claim.sub',actor::text,true);
 execute 'set local role authenticated';
 rejected:=false;
 begin perform public.pqr_api('detail',jsonb_build_object('id',r.id));exception when insufficient_privilege then rejected:=true;end;
 assert rejected,'Excluded review must not be accessible by direct ID';
 response:=public.pqr_api('dashboard',jsonb_build_object('day',r.day));
 assert not exists(select 1 from jsonb_array_elements(response->'reviews') x where x->>'id'=r.id::text);
 response:=public.pqr_api('export',jsonb_build_object('day',r.day));
 assert not exists(select 1 from jsonb_array_elements(response->'reviews') x where x->>'id'=r.id::text);
 execute 'reset role';
 perform private.pqr_refresh_day(r.day);
 assert not exists(select 1 from private.pqr_active_reviews where source_key=r.source_key and day=r.day),'Refresh must not reselect an excluded source';
 assert before_source is not distinct from (select to_jsonb(a) from public.audits a where a.id=r.source_audit_id),'Source audit must remain unchanged';
end;$qa$;
select 'PQR_SIMPLE_REVIEW_OPTIONAL_DETAIL_EXCLUSION_PRIVACY_VERSION_SOURCE_OK' as verification;
rollback;
