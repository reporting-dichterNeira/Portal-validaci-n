-- Live database integration QA. Every simulated identity, credential,
-- assignment and review is rolled back inside a PL/pgSQL subtransaction.
-- Existing audit rows are only read. The outer transaction returns checks.
create temporary table pqr_qa_results(check_name text) on commit drop;
do $qa$
declare checks jsonb:='[]'; admin_id uuid; analyst_user uuid:=gen_random_uuid(); other_user uuid:=gen_random_uuid();
 supervisor_user uuid:=gen_random_uuid(); supervisor_name text:='qa_pqr_'||substr(gen_random_uuid()::text,1,8);
 analyst1 jsonb; analyst2 jsonb; response jsonb; review jsonb; results jsonb; job_id uuid; other_job uuid; original jsonb;
 passed boolean;
begin
 begin
  if has_table_privilege('authenticated','private.pqr_reviews','select,insert,update,delete') or has_function_privilege('anon','public.pqr_api(text,jsonb)','execute') or has_function_privilege('authenticated','private.pqr_refresh_day(date)','execute') then raise exception 'Unexpected direct PQR privileges';end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname like 'pqr_%' and c.relkind='r' and not c.relrowsecurity) then raise exception 'PQR table missing RLS';end if;
  checks:=checks||jsonb_build_array('PQR tables have RLS and no direct client access; sampling remains owner-only');
  if private.pqr_public_payload('{"_validatorCode":"VAL-secret","meta":{"validatorCode":"VAL-secret","idPDV":"PDV-1"},"kpis":[{"name":"Precio","access_token":"VAL-secret"}]}'::jsonb)
    is distinct from '{"meta":{"idPDV":"PDV-1"},"kpis":[{"name":"Precio"}]}'::jsonb then raise exception 'Validator credentials exposed through snapshot';end if;
  checks:=checks||jsonb_build_array('Original validator credentials and internal tokens never leave the snapshot API');
  perform set_config('request.jwt.claim.sub','',true);
  begin perform public.pqr_api('dashboard');raise exception 'Anonymous request accepted';exception when insufficient_privilege then null;end;
  checks:=checks||jsonb_build_array('Unauthenticated requests are denied');
  select id into admin_id from public.profiles where is_active and role::text='admin' limit 1;
  if admin_id is null then raise exception 'QA needs existing administrator identity';end if;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  response:=public.pqr_api('dashboard');
  if response->'stats'->>'target' is null then raise exception 'Missing daily statistics';end if;
  if (response->'stats'->>'target')::integer<>ceil((response->'stats'->>'eligible')::integer*(response->'stats'->>'percentage')::numeric/100.0) then raise exception 'Incorrect 20 percent target';end if;
  checks:=checks||jsonb_build_array('Daily target reconciles eligible completions and configured percentage');
  perform private.pqr_refresh_today();perform private.pqr_refresh_today();
  if exists(select 1 from private.pqr_reviews group by day,source_key having count(*)>1) then raise exception 'Duplicate sample audit';end if;
  checks:=checks||jsonb_build_array('Repeated refreshes do not duplicate selected audits');
  if exists(select 1 from private.pqr_reviews r join public.audits a on a.id=r.source_audit_id where a.module<>'blocking' or (r.original_completed_at at time zone 'America/Bogota')::date<>r.day) then raise exception 'Wrong source module or completion day';end if;
  if exists(select 1 from private.pqr_reviews where original_sla_seconds is null and (reasons->>'fast')::boolean) then raise exception 'Missing duration classified as fast';end if;
  checks:=checks||jsonb_build_array('Only Blocking audits completed on the original Colombian review day enter the cohort');
  perform public.pqr_api('create_supervisor',jsonb_build_object('username',supervisor_name,'name','QA supervision','password','Pqr-QA-temporary-2026!'));
  analyst1:=public.pqr_api('create_analyst',jsonb_build_object('name','QA analyst one'));
  analyst2:=public.pqr_api('create_analyst',jsonb_build_object('name','QA analyst two'));
  perform public.pqr_api('start_distribution');
  if not exists(select 1 from private.pqr_reviews r where r.analyst_id=(analyst1->>'id')::uuid) or not exists(select 1 from private.pqr_reviews r where r.analyst_id=(analyst2->>'id')::uuid) then raise exception 'Distribution did not reach both analysts';end if;
  checks:=checks||jsonb_build_array('Pending assignments are distributed across the available team');
  insert into auth.users(id,aud,role,is_anonymous) values(analyst_user,'authenticated','authenticated',true),(other_user,'authenticated','authenticated',true),(supervisor_user,'authenticated','authenticated',true);
  perform set_config('request.jwt.claim.sub',supervisor_user::text,true);
  response:=public.pqr_login('supervisor',supervisor_name,'Pqr-QA-temporary-2026!');
  if response->>'role'<>'supervisor' then raise exception 'PQR supervisor login failed';end if;
  if exists(select 1 from public.profiles where id=supervisor_user) then raise exception 'Unexpected legacy profile created';end if;
  checks:=checks||jsonb_build_array('Independent supervisor credentials work without a legacy profile');
  perform set_config('request.jwt.claim.sub',analyst_user::text,true);
  response:=public.pqr_login('analyst','',analyst1->>'code');
  if response->>'role'<>'analyst' then raise exception 'Analyst code login failed';end if;
  response:=public.pqr_api('dashboard');
  if exists(select 1 from jsonb_array_elements(response->'reviews') r where r->>'analyst_id'<>analyst1->>'id') then raise exception 'Other analyst data leaked';end if;
  select id into job_id from private.pqr_reviews where analyst_id=(analyst1->>'id')::uuid and status='pending' limit 1;
  select id into other_job from private.pqr_reviews where analyst_id=(analyst2->>'id')::uuid and status='pending' limit 1;
  begin perform public.pqr_api('detail',jsonb_build_object('id',other_job));raise exception 'Cross-analyst access accepted';exception when insufficient_privilege then null;end;
  begin perform public.pqr_api('settings','{"percentage":100,"random_percentage":0}');raise exception 'Analyst changed settings';exception when insufficient_privilege then null;end;
  checks:=checks||jsonb_build_array('Analyst cannot read other assignments or change operational settings');
  select jsonb_build_object('status',a.status,'results',a.validation_results,'started',a.started_at,'completed',a.completed_at) into original from public.audits a join private.pqr_reviews r on r.source_audit_id=a.id where r.id=job_id;
  review:=public.pqr_api('start',jsonb_build_object('id',job_id));
  passed:=false;begin perform public.pqr_api('save',jsonb_build_object('id',job_id,'version',(review->>'version')::integer,'results','{}'::jsonb,'complete',true));exception when others then passed:=true;end;
  if not passed then raise exception 'Incomplete review accepted';end if;
  passed:=false;begin perform public.pqr_api('save',jsonb_build_object('id',job_id,'version',-1,'results','{}'::jsonb,'complete',false));exception when serialization_failure then passed:=true;end;
  if not passed then raise exception 'Stale version accepted';end if;
  select jsonb_object_agg(k->>'name',jsonb_build_object('evaluation','incorrect','correct_decision','aplica','comment','QA confirms the alert')) into results from jsonb_array_elements(review->'kpis') k;
  review:=public.pqr_api('save',jsonb_build_object('id',job_id,'version',(review->>'version')::integer,'results',results,'complete',true));
  if review->>'verdict'<>'errors' or review->>'status'<>'completed' or review->>'completed_at' is null then raise exception 'Incorrect completion outcome';end if;
  if (select jsonb_build_object('status',a.status,'results',a.validation_results,'started',a.started_at,'completed',a.completed_at) from public.audits a join private.pqr_reviews r on r.source_audit_id=a.id where r.id=job_id) is distinct from original then raise exception 'Original validation changed';end if;
  checks:=checks||jsonb_build_array('Completion requires every alert, enforces optimistic locking, and preserves original validation');
  response:=public.pqr_api('detail',jsonb_build_object('id',job_id));
  if response->>'status'<>'completed' then raise exception 'Completed review not readable';end if;
  begin perform public.pqr_api('save',jsonb_build_object('id',job_id,'version',(review->>'version')::integer,'results','{}'::jsonb));raise exception 'Completed review edited';exception when insufficient_privilege then null;end;
  checks:=checks||jsonb_build_array('Completed reviews remain visible and cannot be overwritten');
  response:=public.pqr_api('export');
  if not exists(select 1 from jsonb_array_elements(response->'reviews') r where r->>'id'=job_id::text and jsonb_typeof(r->'kpis')='array' and r->'review_results'=results) then raise exception 'CSV lacks per-alert review detail';end if;
  checks:=checks||jsonb_build_array('CSV includes original and reviewed answers only for assigned audits');
  perform set_config('request.jwt.claim.sub',other_user::text,true);
  perform public.pqr_login('analyst','',analyst2->>'code');
  -- Simulate a late case within this rolled-back QA transaction only.
  insert into private.pqr_days(day,percentage) values((now() at time zone 'America/Bogota')::date-1,20) on conflict do nothing;
  update private.pqr_reviews set day=(now() at time zone 'America/Bogota')::date-1,source_key=source_key||'-qa-late-'||gen_random_uuid()::text where id=other_job;
  review:=public.pqr_api('start',jsonb_build_object('id',other_job));
  select jsonb_object_agg(k->>'name',jsonb_build_object('evaluation','not_evaluable','comment','QA evidence missing')) into results from jsonb_array_elements(review->'kpis') k;
  review:=public.pqr_api('save',jsonb_build_object('id',other_job,'version',(review->>'version')::integer,'results',results,'complete',true));
  response:=public.pqr_api('dashboard',jsonb_build_object('day',(now() at time zone 'America/Bogota')::date-1));
  if (response->'stats'->>'on_time')::integer<>0 or review->>'verdict'<>'not_evaluable' then raise exception 'Late review counted as same-day or missing evidence counted correct';end if;
  checks:=checks||jsonb_build_array('Late reviews retain yesterday cohort, fail same-day SLA, and unevaluable evidence is never correct');
  perform set_config('request.jwt.claim.sub',supervisor_user::text,true);
  perform public.pqr_api('reset_code',jsonb_build_object('id',analyst1->>'id'));
  perform set_config('request.jwt.claim.sub',analyst_user::text,true);
  if private.pqr_context() is not null then raise exception 'Reset code left old session authorized';end if;
  checks:=checks||jsonb_build_array('Code rotation immediately invalidates previous analyst access');
  raise exception using errcode='P0002',message='PQR_QA_FINISHED';
 exception when no_data_found then
  if sqlerrm<>'PQR_QA_FINISHED' then raise;end if;
 end;
 insert into pg_temp.pqr_qa_results select jsonb_array_elements_text(checks);
end;$qa$;
select jsonb_agg(check_name) as checks from pg_temp.pqr_qa_results;
