-- Tests only simulated accounts inside a rolled-back subtransaction.
create temporary table pqr_supervisor_checks(result text) on commit drop;
do $qa$
declare admin_id uuid; test_user uuid:=gen_random_uuid(); supervisor_name text:='qa_'||substr(gen_random_uuid()::text,1,8);
 supervisor_id uuid; response jsonb; original_changed timestamptz; original_profile jsonb; action text;
begin
 begin
  select id,to_jsonb(p) into strict admin_id,original_profile from public.profiles p where is_active and role::text='admin' limit 1;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  response:=public.pqr_api('create_supervisor',jsonb_build_object('username',supervisor_name,'name','QA management','password','Start888'));
  supervisor_id:=(response->>'id')::uuid;
  perform public.pqr_api('create_supervisor',jsonb_build_object('username',supervisor_name||'_dup','name','QA duplicate','password','Start888'));
  insert into auth.users(id,aud,role,is_anonymous) values(test_user,'authenticated','authenticated',true);
  perform set_config('request.jwt.claim.sub',test_user::text,true);
  perform public.pqr_login('supervisor',supervisor_name,'Start888');
  foreach action in array array['create_supervisor','update_supervisor','reset_supervisor_password','delete_supervisor','restore_supervisor'] loop
   begin perform public.pqr_api(action,jsonb_build_object('id',supervisor_id));raise exception 'Supervisor modified admin-only accounts';exception when insufficient_privilege then null;end;
  end loop;
  response:=public.pqr_api('dashboard');
  if response->'supervisors'<>'[]'::jsonb then raise exception 'Supervisor can list admin accounts';end if;
  perform set_config('request.jwt.claim.sub','',true);
  begin perform public.pqr_api('delete_supervisor',jsonb_build_object('id',supervisor_id));raise exception 'Anonymous removal allowed';exception when insufficient_privilege then null;end;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  select credentials_changed_at into original_changed from private.pqr_supervisors where id=supervisor_id;
  perform public.pqr_api('update_supervisor',jsonb_build_object('id',supervisor_id,'name','QA renamed','username',supervisor_name,'active',true));
  if exists(select 1 from private.pqr_supervisors where id=supervisor_id and credentials_changed_at<>original_changed) then raise exception 'Name-only edit invalidated session';end if;
  begin
   perform public.pqr_api('update_supervisor',jsonb_build_object('id',supervisor_id,'name','QA renamed','username',supervisor_name||'_dup','active',true));raise exception 'Duplicate username accepted';
  exception when raise_exception then if sqlerrm<>'Ese usuario PQR ya existe.' then raise;end if;end;
  perform public.pqr_api('update_supervisor',jsonb_build_object('id',supervisor_id,'name','QA renamed','username',' '||upper(supervisor_name)||'_NEW ','active',true));
  perform set_config('request.jwt.claim.sub',test_user::text,true);
  begin perform public.pqr_api('context');raise exception 'Renamed account session survived';exception when insufficient_privilege then null;end;
  response:=public.pqr_login('supervisor',supervisor_name,'Start888');
  if response->>'error' is null then raise exception 'Old username works';end if;
  response:=public.pqr_login('supervisor',supervisor_name||'_new','Start888');
  if response->>'role' is distinct from 'supervisor' then raise exception 'Normalized username failed';end if;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  begin
   perform public.pqr_api('reset_supervisor_password',jsonb_build_object('id',supervisor_id,'password','short77'));raise exception 'Short reset password accepted';
  exception when raise_exception then if sqlerrm<>'La contraseña debe tener al menos 8 caracteres.' then raise;end if;end;
  perform public.pqr_api('reset_supervisor_password',jsonb_build_object('id',supervisor_id,'password','Reset888'));
  perform set_config('request.jwt.claim.sub',test_user::text,true);
  begin perform public.pqr_api('context');raise exception 'Reset kept old session';exception when insufficient_privilege then null;end;
  response:=public.pqr_login('supervisor',supervisor_name||'_new','Start888');
  if response->>'error' is null then raise exception 'Previous password works';end if;
  response:=public.pqr_login('supervisor',supervisor_name||'_new','Reset888');
  if response->>'role' is distinct from 'supervisor' then raise exception 'Reset password failed';end if;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  perform public.pqr_api('update_supervisor',jsonb_build_object('id',supervisor_id,'name','QA renamed','username',supervisor_name||'_new','active',false));
  perform set_config('request.jwt.claim.sub',test_user::text,true);
  begin perform public.pqr_api('context');raise exception 'Inactive session survived';exception when insufficient_privilege then null;end;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  perform public.pqr_api('delete_supervisor',jsonb_build_object('id',supervisor_id));
  if not exists(select 1 from private.pqr_supervisors where id=supervisor_id and not active and deleted_at is not null) then raise exception 'Removal lost row or left access';end if;
  response:=public.pqr_api('dashboard');
  if exists(select 1 from jsonb_array_elements(response->'supervisors') x where x ? 'password_hash' or x ? 'password') then raise exception 'Password exposed';end if;
  if exists(select 1 from private.pqr_events where detail::text like '%Reset888%' or detail::text like '%Start888%') then raise exception 'Password logged';end if;
  perform public.pqr_api('restore_supervisor',jsonb_build_object('id',supervisor_id));
  if not exists(select 1 from private.pqr_supervisors where id=supervisor_id and not active and deleted_at is null) then raise exception 'Restore must stay inactive';end if;
  perform public.pqr_api('update_supervisor',jsonb_build_object('id',supervisor_id,'name','QA renamed','username',supervisor_name||'_new','active',true));
  perform set_config('request.jwt.claim.sub',test_user::text,true);
  response:=public.pqr_login('supervisor',supervisor_name||'_new','Reset888');
  if response->>'error' is null then raise exception 'Restore revived old password';end if;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  perform public.pqr_api('reset_supervisor_password',jsonb_build_object('id',supervisor_id,'password','Restore8'));
  perform set_config('request.jwt.claim.sub',test_user::text,true);
  response:=public.pqr_login('supervisor',supervisor_name||'_new','Restore8');
  if response->>'role' is distinct from 'supervisor' then raise exception 'Restored account cannot authenticate after reset';end if;
  if (select to_jsonb(p) from public.profiles p where id=admin_id) is distinct from original_profile then raise exception 'Legacy administrator changed';end if;
  raise exception 'PQR_SUPERVISOR_QA_FINISHED';
 exception when others then if sqlerrm<>'PQR_SUPERVISOR_QA_FINISHED' then raise;end if;end;
 insert into pg_temp.pqr_supervisor_checks values('PASS: administrator-only edits/reset/removal/restore; unique normalized usernames; name-only edits preserve sessions; username/state/password changes revoke access; eight-character reset; deleted credentials cannot revive; passwords never returned/logged; existing profiles unchanged. All test accounts rolled back.');
end;$qa$;
select result from pg_temp.pqr_supervisor_checks;
