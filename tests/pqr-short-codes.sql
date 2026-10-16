-- All test identities, codes, sessions and assignment side effects roll back.
create temporary table pqr_short_code_checks(result text) on commit drop;
do $qa$
declare admin_id uuid; test_user uuid:=gen_random_uuid(); analyst jsonb; rotated jsonb; response jsonb;
 old_code text:='PQR-'||upper(encode(extensions.gen_random_bytes(12),'hex'));
begin
 begin
  select id into strict admin_id from public.profiles where is_active and role::text='admin' limit 1;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  analyst:=public.pqr_api('create_analyst',jsonb_build_object('name','QA short code'));
  if analyst->>'code' !~ '^PQR-[2-9A-HJ-NP-Z]{12}$' then raise exception 'Unexpected new code format';end if;
  insert into auth.users(id,aud,role,is_anonymous) values(test_user,'authenticated','authenticated',true);
  perform set_config('request.jwt.claim.sub',test_user::text,true);
  response:=public.pqr_login('analyst','',lower(analyst->>'code'));
  if response->>'role' is distinct from 'analyst' then raise exception 'Short code login failed';end if;
  -- A stored long code still authenticates without changing login or its hash.
  update private.pqr_analysts set code_hash=encode(extensions.digest(old_code,'sha256'),'hex') where id=(analyst->>'id')::uuid;
  response:=public.pqr_login('analyst','',old_code);
  if response->>'role' is distinct from 'analyst' then raise exception 'Legacy code rejected';end if;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  rotated:=public.pqr_api('reset_code',jsonb_build_object('id',analyst->>'id'));
  if rotated->>'code' !~ '^PQR-[2-9A-HJ-NP-Z]{12}$' then raise exception 'Unexpected rotated code format';end if;
  perform set_config('request.jwt.claim.sub',test_user::text,true);
  response:=public.pqr_login('analyst','',rotated->>'code');
  if response->>'role' is distinct from 'analyst' then raise exception 'Rotated code login failed';end if;
  response:=public.pqr_login('analyst','',old_code);
  if response->>'error' is null then raise exception 'Replaced credential still accepted';end if;
  raise exception 'PQR_SHORT_QA_FINISHED';
 exception when others then
  if sqlerrm<>'PQR_SHORT_QA_FINISHED' then raise;end if;
 end;
 insert into pg_temp.pqr_short_code_checks values('PASS: new and rotated codes use 12 readable random characters; lowercase entry and existing long codes work; replaced codes are rejected. All test data rolled back.');
end;$qa$;
select result from pg_temp.pqr_short_code_checks;
