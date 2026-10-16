-- All simulated accounts and login attempts roll back; no existing account changes.
create temporary table pqr_password_checks(result text) on commit drop;
do $qa$
declare admin_id uuid; test_user uuid:=gen_random_uuid(); supervisor_name text:='Qa_'||substr(gen_random_uuid()::text,1,8); response jsonb;
begin
 begin
  select id into strict admin_id from public.profiles where is_active and role::text='admin' limit 1;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  begin
   perform public.pqr_api('create_supervisor',jsonb_build_object('username',supervisor_name,'name','QA password boundary','password','Qa12345'));
   raise exception 'Seven-character password accepted';
  exception when raise_exception then
   if sqlerrm<>'La contraseña debe tener al menos 8 caracteres.' then raise;end if;
  end;
  response:=public.pqr_api('create_supervisor',jsonb_build_object('username',' '||supervisor_name||' ','name','QA password boundary','password','Qa123456'));
  if not exists(select 1 from private.pqr_supervisors where id=(response->>'id')::uuid and username=lower(supervisor_name) and password_hash<> 'Qa123456') then raise exception 'Account normalization or hashing failed';end if;
  insert into auth.users(id,aud,role,is_anonymous) values(test_user,'authenticated','authenticated',true);
  perform set_config('request.jwt.claim.sub',test_user::text,true);
  response:=public.pqr_login('supervisor',supervisor_name,'Qa123456');
  if response->>'role' is distinct from 'supervisor' then raise exception 'Eight-character password cannot log in';end if;
  if exists(select 1 from public.profiles where id=test_user) then raise exception 'Legacy profile changed';end if;
  raise exception 'PQR_PASSWORD_QA_FINISHED';
 exception when others then if sqlerrm<>'PQR_PASSWORD_QA_FINISHED' then raise;end if;end;
 insert into pg_temp.pqr_password_checks values('PASS: seven characters rejected; eight accepted and authenticate; mixed-case username normalized; password hashed; legacy profiles unchanged. All test accounts rolled back.');
end;$qa$;
select result from pg_temp.pqr_password_checks;
