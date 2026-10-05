-- SQL Editor as postgres. Entire fixture and all settings are rolled back.
begin;
do $$
declare scope record; other_study record; test_id text:='TEST-REMOVE-'||gen_random_uuid()::text;
  aid bigint; rejected boolean;
begin
  select sa.*,s.name as study_name,b.id as batch_id,b.module as batch_module into strict scope
    from public.supervisor_assignments sa join public.profiles p on p.id=sa.supervisor_id
    join public.studies s on s.id=sa.study_id join public.upload_batches b
      on b.study_id=sa.study_id and b.country_id=sa.country_id and b.module=sa.module
    where p.is_active and p.role='supervisor' and b.status='active' limit 1;
  select id,name into strict other_study from public.studies where id<>scope.study_id limit 1;
  insert into public.validators(id,code,name,study,study_id,country_id)
    values(test_id,'VAL-'||upper(substr(gen_random_uuid()::text,1,8)),'Prueba eliminación recuperable',scope.study_name,scope.study_id,scope.country_id);
  insert into public.validator_study_memberships(validator_id,study_id,country_id,is_active)
    values(test_id,other_study.id,scope.country_id,true);
  insert into public.audits(module,batch_id,external_id,study,study_id,country_id,assigned_validator_id,payload)
    values(scope.batch_module,scope.batch_id,'990000009001',scope.study_name,scope.study_id,scope.country_id,test_id,'{"pais":"Panamá"}') returning id into aid;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',scope.supervisor_id,'role','authenticated')::text,true);
  rejected:=false;
  begin perform public.remove_study_validator(test_id,scope.study_id,scope.country_id);
  exception when sqlstate '22023' then rejected:=true; end;
  assert rejected,'Pending work did not block removal';
  update public.audits set status='en_progreso' where id=aid;
  rejected:=false;
  begin perform public.remove_study_validator(test_id,scope.study_id,scope.country_id);
  exception when sqlstate '22023' then rejected:=true; end;
  assert rejected,'In-progress work did not block removal';
  update public.audits set status='completada' where id=aid;
  perform public.remove_study_validator(test_id,scope.study_id,scope.country_id);
  assert exists(select 1 from public.validator_study_memberships where validator_id=test_id and study_id=scope.study_id and removed_at is not null and not is_active),'Roster removal not saved';
  assert exists(select 1 from public.validator_study_memberships where validator_id=test_id and study_id=other_study.id and removed_at is null and is_active),'Other study changed';
  assert exists(select 1 from public.audits where id=aid and assigned_validator_id=test_id and status='completada'),'History changed';
  assert exists(select 1 from public.validators where id=test_id and is_active),'Other study identity deactivated';
  rejected:=false;
  begin
    insert into public.audits(module,batch_id,external_id,study,study_id,country_id,assigned_validator_id,payload)
      values(scope.batch_module,scope.batch_id,'990000009002',scope.study_name,scope.study_id,scope.country_id,test_id,'{"pais":"Panamá"}');
  exception when sqlstate '22023' then rejected:=true; end;
  assert rejected,'Stale browser assignment accepted';
  assert exists(select 1 from public.available_study_validators(scope.study_id,scope.country_id) where id=test_id),'Removed identity unavailable for restore';
  perform public.add_existing_study_validator(test_id,scope.study_id,scope.country_id);
  assert exists(select 1 from public.validator_study_memberships where validator_id=test_id and study_id=scope.study_id and removed_at is null and is_active),'Restore failed';
  -- Removing the only remaining membership must also be recoverable.
  update public.validator_study_memberships set is_active=false where validator_id=test_id and study_id=other_study.id;
  perform public.remove_study_validator(test_id,scope.study_id,scope.country_id);
  assert exists(select 1 from public.available_study_validators(scope.study_id,scope.country_id) where id=test_id),'Last-study identity unavailable for restore';
  perform public.add_existing_study_validator(test_id,scope.study_id,scope.country_id);
  perform set_config('request.jwt.claims','{}',true);
  rejected:=false;
  begin perform public.remove_study_validator(test_id,scope.study_id,scope.country_id);
  exception when insufficient_privilege then rejected:=true; end;
  assert rejected,'Unauthenticated removal allowed';
  assert not has_function_privilege('anon','public.remove_study_validator(text,uuid,uuid)','EXECUTE'),'Anonymous RPC allowed';
end; $$;
rollback;
select 'PASS: unfinished work blocked, history and other studies retained, restore and stale assignment protection, authentication; all fixtures rolled back' as verification;
