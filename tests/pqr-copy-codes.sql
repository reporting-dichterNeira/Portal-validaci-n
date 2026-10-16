-- Credentials and simulated identities stay inside a rolled-back subtransaction.
create temporary table pqr_copy_checks(result text) on commit drop;
do $qa$
declare admin_id uuid; test_user uuid:=gen_random_uuid(); analyst jsonb; response jsonb; rotated jsonb;
 secret_id uuid; original_hash text; changed_at timestamptz; vault_before bigint; review_percentage numeric;
begin
 select count(*) into vault_before from vault.secrets;
 begin
  if has_table_privilege('anon','vault.decrypted_secrets','select') or has_table_privilege('authenticated','vault.decrypted_secrets','select') then raise exception 'Clients can read Vault directly';end if;
  select id into strict admin_id from public.profiles where is_active and role::text='admin' limit 1;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  analyst:=public.pqr_api('create_analyst',jsonb_build_object('name','QA recoverable code'));
  select code_secret_id,code_hash,credentials_changed_at into secret_id,original_hash,changed_at from private.pqr_analysts where id=(analyst->>'id')::uuid;
  if secret_id is null or exists(select 1 from vault.secrets where id=secret_id and secret=analyst->>'code') then raise exception 'Code not encrypted';end if;
  response:=public.pqr_api('get_code',jsonb_build_object('id',analyst->>'id'));
  if response->>'code' is distinct from analyst->>'code' then raise exception 'Code recovery mismatch';end if;
  perform public.pqr_api('get_code',jsonb_build_object('id',analyst->>'id'));
  if exists(select 1 from private.pqr_analysts where id=(analyst->>'id')::uuid and (code_hash<>original_hash or credentials_changed_at<>changed_at)) then raise exception 'Copy rotated credentials';end if;
  response:=public.pqr_api('dashboard');
  if exists(select 1 from jsonb_array_elements(response->'analysts') a where a ?| array['code','code_hash','code_secret_id']) then raise exception 'Credentials leaked in staff list';end if;
  if exists(select 1 from private.pqr_events where detail::text like '%'||(analyst->>'code')||'%') then raise exception 'Plain code logged in event';end if;
  insert into auth.users(id,aud,role,is_anonymous) values(test_user,'authenticated','authenticated',true);
  perform set_config('request.jwt.claim.sub',test_user::text,true);
  begin perform public.pqr_api('get_code',jsonb_build_object('id',analyst->>'id'));raise exception 'Unclaimed session read code';exception when insufficient_privilege then null;end;
  perform public.pqr_login('analyst','',analyst->>'code');
  begin perform public.pqr_api('get_code',jsonb_build_object('id',analyst->>'id'));raise exception 'Analyst read a code';exception when insufficient_privilege then null;end;
  -- Simulate a pre-upgrade code without changing its existing credential.
  update private.pqr_analysts set code_secret_id=null where id=(analyst->>'id')::uuid;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  response:=public.pqr_api('get_code',jsonb_build_object('id',analyst->>'id'));
  if not coalesce((response->>'requires_new_code')::boolean,false) then raise exception 'Legacy code must report unavailable without rotation';end if;
  if exists(select 1 from private.pqr_analysts where id=(analyst->>'id')::uuid and code_hash<>original_hash) then raise exception 'Legacy code rotated silently';end if;
  perform set_config('request.jwt.claim.sub',test_user::text,true);
  response:=public.pqr_login('analyst','',analyst->>'code');
  if response->>'role' is distinct from 'analyst' then raise exception 'Legacy login broken';end if;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  response:=public.pqr_api('get_code',jsonb_build_object('id',analyst->>'id'));
  if response->>'code' is distinct from analyst->>'code' then raise exception 'Legacy login did not enable exact code recovery';end if;
  rotated:=public.pqr_api('reset_code',jsonb_build_object('id',analyst->>'id'));
  response:=public.pqr_api('get_code',jsonb_build_object('id',analyst->>'id'));
  if response->>'code' is distinct from rotated->>'code' or response->>'code'=analyst->>'code' then raise exception 'Recovery kept obsolete code';end if;
  select code_secret_id into secret_id from private.pqr_analysts where id=(analyst->>'id')::uuid;
  perform public.pqr_api('delete_analyst',jsonb_build_object('id',analyst->>'id'));
  if exists(select 1 from vault.decrypted_secrets where id=secret_id and decrypted_secret=rotated->>'code') then raise exception 'Deleted code remains recoverable';end if;
  begin
   perform public.pqr_api('get_code',jsonb_build_object('id',analyst->>'id'));raise exception 'Deleted code readable';
  exception when raise_exception then if sqlerrm<>'ANALYST_NOT_FOUND' then raise;end if;end;
  select percentage into review_percentage from private.pqr_settings where singleton;
  perform public.pqr_api('settings',jsonb_build_object('percentage',review_percentage));
  if exists(select 1 from private.pqr_settings where random_percentage<>0 or percentage<>review_percentage) then raise exception 'Percentage-only settings failed';end if;
  perform public.pqr_api('settings',jsonb_build_object('percentage',review_percentage,'random_percentage',90));
  if exists(select 1 from private.pqr_settings where random_percentage<>0) then raise exception 'Old clients can reactivate random selection';end if;
  raise exception 'PQR_COPY_QA_FINISHED';
 exception when others then if sqlerrm<>'PQR_COPY_QA_FINISHED' then raise;end if;end;
 if (select count(*) from vault.secrets)<>vault_before then raise exception 'QA left secrets behind';end if;
 insert into pg_temp.pqr_copy_checks values('PASS: encrypted codes; manager-only recovery without rotation; no code in dashboard/events; legacy login enables recovery without changing the code; rotation/deletion invalidate stored copies; percentage-only risk selection. All test data rolled back.');
end;$qa$;
select result from pg_temp.pqr_copy_checks;
