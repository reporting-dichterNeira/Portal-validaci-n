-- Run in SQL Editor after the upgrade. All QA identities, configuration,
-- assignments and samples roll back; original Blocking audits are read only.
create temporary table pqr_study_qa_results(check_name text) on commit drop;
do $qa$
declare checks jsonb:='[]'; admin_id uuid; qa1 uuid:=gen_random_uuid(); qa2 uuid:=gen_random_uuid();
 qa_user uuid:=gen_random_uuid(); d date:=(now() at time zone 'America/Bogota')::date;
 response jsonb; cfg jsonb; protected_before jsonb; history_before jsonb; selected_before integer;
 original_before jsonb; protected_id uuid; job_id uuid; passed boolean;
begin
 begin
  perform pg_advisory_xact_lock(186321,d-date '2026-01-01');
  select id into admin_id from public.profiles where is_active and role::text='admin' limit 1;
  if admin_id is null then raise exception 'QA needs existing admin identity';end if;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  select jsonb_agg(to_jsonb(r) order by r.id) into protected_before from private.pqr_reviews r
   where r.status<>'pending' or r.started_at is not null or r.review_results<>'{}'::jsonb;
  select jsonb_agg(to_jsonb(r) order by r.id) into history_before from private.pqr_reviews r where r.day<d;
  select jsonb_agg(jsonb_build_array(id,status,assigned_validator_id,validation_results,started_at,completed_at) order by id)
   into original_before from public.audits where module='blocking' and completed_at>=d::timestamp at time zone 'America/Bogota';
  insert into private.pqr_analysts(id,name,code_hash) values(qa1,'QA estudio A',gen_random_uuid()::text),(qa2,'QA estudio B',gen_random_uuid()::text);
  cfg:=jsonb_build_array(jsonb_build_object('study','Moderno','analyst_id',qa1,'percentage',11),
   jsonb_build_object('study','Tradicional','analyst_id',qa1,'percentage',23),
   jsonb_build_object('study','Chile','analyst_id',qa2,'percentage',37),
   jsonb_build_object('study','Lindley','analyst_id',qa2,'percentage',0));
  response:=public.pqr_api('study_settings',jsonb_build_object('studies',cfg));
  response:=public.pqr_api('start_distribution');
  if exists(select 1 from private.pqr_day_studies where day=d and target<>ceil(eligible*percentage/100.0)) then raise exception 'Wrong per-study rounding';end if;
  if (response->'stats'->>'target')::integer<>(select sum(target) from private.pqr_day_studies where day=d) then raise exception 'Total target is not sum of study targets';end if;
  if exists(select 1 from private.pqr_reviews r join private.pqr_study_settings s on s.study=r.study
   where r.day=d and r.status='pending' and r.started_at is null and r.review_results='{}'::jsonb and r.analyst_id is distinct from s.analyst_id) then raise exception 'Cross-study automatic assignment';end if;
  checks:=checks||jsonb_build_array('Independent 11%, 23%, 37% and 0% quotas round up per study; total reconciles; shared analyst owns two studies');
  if (select jsonb_agg(to_jsonb(r) order by r.id) from private.pqr_reviews r where r.status<>'pending' or r.started_at is not null or r.review_results<>'{}'::jsonb) is distinct from protected_before then raise exception 'Started review changed';end if;
  if (select jsonb_agg(to_jsonb(r) order by r.id) from private.pqr_reviews r where r.day<d) is distinct from history_before then raise exception 'Prior-day assignment changed';end if;
  checks:=checks||jsonb_build_array('Started, completed, drafted and previous-day assignments are preserved');
  passed:=false;begin perform public.pqr_api('study_settings',jsonb_build_object('studies',cfg||jsonb_build_array(cfg->0)));exception when others then passed:=true;end;
  if not passed then raise exception 'Duplicate configuration accepted';end if;
  passed:=false;begin perform public.pqr_api('study_settings',jsonb_build_object('studies',jsonb_set(cfg,'{0,percentage}','101')));exception when others then passed:=true;end;
  if not passed then raise exception 'Invalid percentage accepted';end if;
  passed:=false;begin perform public.pqr_api('study_settings',jsonb_build_object('studies',jsonb_set(cfg,'{0,analyst_id}',to_jsonb(gen_random_uuid()))));exception when others then passed:=true;end;
  if not passed then raise exception 'Unknown analyst accepted';end if;
  checks:=checks||jsonb_build_array('Duplicate studies, invalid percentages and nonexistent analysts are rejected atomically');
  -- Force a known unassigned, unstarted case to verify pause never spills over.
  select id into job_id from private.pqr_reviews where day=d and analyst_id=qa2 and status='pending' and started_at is null limit 1;
  if job_id is null then raise exception 'QA needs at least one eligible unstarted audit today';end if;
  update private.pqr_analysts set available=false where id=qa2;
  update private.pqr_reviews set analyst_id=null where id=job_id;
  perform private.pqr_refresh_today();
  if (select analyst_id from private.pqr_reviews where id=job_id) is not null then raise exception 'Paused study assigned to unrelated analyst';end if;
  update private.pqr_analysts set available=true where id=qa2;
  perform private.pqr_refresh_today();
  if (select analyst_id from private.pqr_reviews where id=job_id) is distinct from qa2 then raise exception 'Resume did not route to study owner';end if;
  passed:=false;begin perform public.pqr_api('reassign',jsonb_build_object('id',job_id,'analyst_id',qa1));exception when others then passed:=true;end;
  if not passed then raise exception 'Cross-study manual assignment accepted';end if;
  checks:=checks||jsonb_build_array('Pausing waits for the study owner; resuming assigns to that owner; cross-study manual assignment is rejected');
  select count(*) into selected_before from private.pqr_reviews where day=d;
  perform private.pqr_refresh_today();perform private.pqr_refresh_today();
  if (select count(*) from private.pqr_reviews where day=d)<>selected_before or exists(select 1 from private.pqr_reviews group by day,source_key having count(*)>1) then raise exception 'Refresh duplicated or expanded full sample';end if;
  checks:=checks||jsonb_build_array('Repeated refreshes keep the per-study sample idempotent');
  insert into auth.users(id,aud,role,is_anonymous) values(qa_user,'authenticated','authenticated',true);
  insert into private.pqr_sessions(user_id,analyst_id) values(qa_user,qa2);
  perform set_config('request.jwt.claim.sub',qa_user::text,true);
  response:=public.pqr_api('dashboard');
  if exists(select 1 from jsonb_array_elements(response->'study_settings') s where s->>'analyst_id'<>qa2::text) or jsonb_array_length(response->'study_stats')<>0 then raise exception 'Other analyst configuration leaked';end if;
  passed:=false;begin perform public.pqr_api('study_settings',jsonb_build_object('studies',cfg));exception when insufficient_privilege then passed:=true;end;
  if not passed then raise exception 'Analyst changed study configuration';end if;
  checks:=checks||jsonb_build_array('Analysts see only their own study configuration and cannot configure distribution');
  if has_table_privilege('authenticated','private.pqr_study_settings','select,insert,update,delete') or has_table_privilege('anon','private.pqr_day_studies','select,insert,update,delete') then raise exception 'Direct configuration access exposed';end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in ('pqr_study_settings','pqr_day_studies') and not c.relrowsecurity) then raise exception 'Missing RLS';end if;
  if (select jsonb_agg(jsonb_build_array(id,status,assigned_validator_id,validation_results,started_at,completed_at) order by id) from public.audits where module='blocking' and completed_at>=d::timestamp at time zone 'America/Bogota') is distinct from original_before then raise exception 'Original validator operation changed';end if;
  checks:=checks||jsonb_build_array('New tables are private with RLS; original Blocking decisions and assignments remain unchanged');
  raise exception using errcode='P0002',message='PQR_STUDY_QA_FINISHED';
 exception when no_data_found then if sqlerrm<>'PQR_STUDY_QA_FINISHED' then raise;end if;end;
 insert into pg_temp.pqr_study_qa_results select jsonb_array_elements_text(checks);
end;$qa$;
select jsonb_agg(check_name) as checks from pg_temp.pqr_study_qa_results;
