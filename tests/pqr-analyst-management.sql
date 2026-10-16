-- Existing audits are read-only; every simulated identity/review rolls back.
create temporary table pqr_management_checks(result text) on commit drop;
do $qa$
declare admin_id uuid; test_user uuid:=gen_random_uuid(); analyst jsonb; response jsonb;
 pending_id uuid; completed_id uuid;
begin
 begin
  select id into strict admin_id from public.profiles where is_active and role::text='admin' limit 1;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  analyst:=public.pqr_api('create_analyst',jsonb_build_object('name','QA removable analyst'));
  insert into private.pqr_reviews
   select (jsonb_populate_record(null::private.pqr_reviews,to_jsonb(r)||jsonb_build_object(
    'id',gen_random_uuid(),'source_key','qa-removal-'||gen_random_uuid()::text,'analyst_id',analyst->>'id',
    'status','pending','started_at',null,'completed_at',null,'verdict',null,'review_results','{}'::jsonb))).*
   from private.pqr_reviews r limit 1 returning id into pending_id;
  if pending_id is null then raise exception 'QA requires a sample review';end if;
  insert into private.pqr_reviews
   select (jsonb_populate_record(null::private.pqr_reviews,to_jsonb(r)||jsonb_build_object(
    'id',gen_random_uuid(),'source_key','qa-history-'||gen_random_uuid()::text,
    'status','completed','started_at',now()-interval '2 minutes','completed_at',now(),'verdict','correct'))).*
   from private.pqr_reviews r where r.id=pending_id returning id into completed_id;
  insert into auth.users(id,aud,role,is_anonymous) values(test_user,'authenticated','authenticated',true);
  perform set_config('request.jwt.claim.sub',test_user::text,true);
  perform public.pqr_login('analyst','',analyst->>'code');
  begin
   perform public.pqr_api('delete_analyst',jsonb_build_object('id',analyst->>'id'));
   raise exception 'Analyst was allowed to remove staff';
  exception when insufficient_privilege then null;end;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  update private.pqr_reviews set status='in_progress',started_at=now() where id=pending_id;
  begin
   perform public.pqr_api('delete_analyst',jsonb_build_object('id',analyst->>'id'));
   raise exception 'In-progress deletion accepted';
  exception when raise_exception then
   if position('revisiones en curso' in sqlerrm)=0 then raise;end if;
  end;
  update private.pqr_reviews set status='pending',started_at=null where id=pending_id;
  response:=public.pqr_api('delete_analyst',jsonb_build_object('id',analyst->>'id'));
  if not exists(select 1 from private.pqr_analysts where id=(analyst->>'id')::uuid and deleted_at is not null and not active and not available) then raise exception 'Analyst not removed';end if;
  if exists(select 1 from private.pqr_reviews where id=pending_id and analyst_id=(analyst->>'id')::uuid) then raise exception 'Pending work retained by deleted analyst';end if;
  if not exists(select 1 from private.pqr_reviews where id=completed_id and analyst_id=(analyst->>'id')::uuid and status='completed') then raise exception 'Completed history lost';end if;
  perform set_config('request.jwt.claim.sub',test_user::text,true);
  begin perform public.pqr_api('context');raise exception 'Deleted session remained valid';exception when insufficient_privilege then null;end;
  response:=public.pqr_login('analyst','',analyst->>'code');
  if response->>'error' is null then raise exception 'Deleted credential accepted';end if;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  perform public.pqr_api('restore_analyst',jsonb_build_object('id',analyst->>'id'));
  if not exists(select 1 from private.pqr_analysts where id=(analyst->>'id')::uuid and deleted_at is null and not active and not available) then raise exception 'Restore must stay inactive';end if;
  perform public.pqr_api('update_analyst',jsonb_build_object('id',analyst->>'id','active',true,'available',false));
  perform set_config('request.jwt.claim.sub',test_user::text,true);
  response:=public.pqr_login('analyst','',analyst->>'code');
  if response->>'error' is null then raise exception 'Restore revived a revoked code';end if;
  raise exception 'PQR_MANAGEMENT_QA_FINISHED';
 exception when others then
  if sqlerrm<>'PQR_MANAGEMENT_QA_FINISHED' then raise;end if;
 end;
 insert into pg_temp.pqr_management_checks values('PASS: supervisor-only removal; in-progress work protected; pending work released; completed history retained; sessions/codes revoked; restore stays inactive without reviving old codes. All test data rolled back.');
end;$qa$;
select result from pg_temp.pqr_management_checks;
