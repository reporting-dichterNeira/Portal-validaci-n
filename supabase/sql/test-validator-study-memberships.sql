-- Integration test against existing scopes. All fixtures and mutations roll back.
begin;
create temporary table qa_membership_scope on commit drop as
select sa.supervisor_id, sa.study_id, sa.country_id, b.id batch_id, b.module, study.name as study
from public.supervisor_assignments sa join public.profiles p on p.id=sa.supervisor_id
join public.studies study on study.id=sa.study_id
join public.upload_batches b on b.study_id=sa.study_id and b.country_id=sa.country_id and b.module=sa.module
where p.is_active and p.role='supervisor' and b.status='active' limit 1;
grant select on qa_membership_scope to authenticated;
do $$ declare scope record; original record; begin
  select * into strict scope from qa_membership_scope;
  select * into strict original from public.validators where study_id<>scope.study_id and country_id is not null limit 1;
  insert into public.validators(id,code,name,study,study_id,country_id) values
    ('qa-multi-existing','VAL-QAMULTI01','QA existing validator',original.study,original.study_id,original.country_id),
    ('qa-multi-source','VAL-QAMULTI02','QA source validator',scope.study,scope.study_id,scope.country_id);
  insert into public.audits(module,external_id,study,study_id,country_id,batch_id,assigned_validator_id,status)
  values(scope.module,'qa-multi-audit',scope.study,scope.study_id,scope.country_id,scope.batch_id,'qa-multi-source','pendiente');
  assert not has_table_privilege('anon','public.validator_study_memberships','select'), 'Anonymous roster access';
  assert not has_function_privilege('anon','public.available_study_validators(uuid,uuid)','execute'), 'Anonymous directory access';
  assert not has_function_privilege('anon','public.add_existing_study_validator(text,uuid,uuid)','execute'), 'Anonymous assignment';
end; $$;
select set_config('request.jwt.claim.sub',(select supervisor_id::text from qa_membership_scope),true);
set local role authenticated;
do $$ declare scope record; result jsonb; begin
  select * into strict scope from qa_membership_scope;
  assert exists(select 1 from public.available_study_validators(scope.study_id,scope.country_id) where id='qa-multi-existing'), 'Directory missing candidate';
  perform public.add_existing_study_validator('qa-multi-existing',scope.study_id,scope.country_id);
  perform public.add_existing_study_validator('qa-multi-existing',scope.study_id,scope.country_id);
  assert (select count(*) from public.validator_study_memberships where validator_id='qa-multi-existing' and study_id=scope.study_id)=1, 'Duplicate membership';
  assert not exists(select 1 from public.available_study_validators(scope.study_id,scope.country_id) where id='qa-multi-existing'), 'Already assigned candidate';
  assert exists(select 1 from public.validators where id='qa-multi-existing' and code='VAL-QAMULTI01'), 'Identity not visible through RLS';
  perform public.set_study_validator_active('qa-multi-existing',scope.study_id,scope.country_id,false);
  assert (select is_active from public.validators where id='qa-multi-existing'), 'Other study deactivated';
  perform public.set_study_validator_active('qa-multi-existing',scope.study_id,scope.country_id,true);
  result:=public.reassign_pending_audits(scope.study_id,scope.module,'qa-multi-source',array['qa-multi-existing']);
  assert (result->>'reassigned_count')::int=1, 'Reassignment failed';
  assert exists(select 1 from public.audits where external_id='qa-multi-audit' and assigned_validator_id='qa-multi-existing'), 'Audit not assigned';
  begin
    perform public.add_existing_study_validator('qa-multi-existing','00000000-0000-0000-0000-000000000001',scope.country_id);
    raise exception 'Unexpected out-of-scope assignment';
  exception when insufficient_privilege then null;
  end;
end; $$;
reset role;
do $$ begin
  assert (select count(*) from public.validator_study_memberships where validator_id='qa-multi-existing' and is_active)=2, 'Original study lost';
  assert (select v.study_id<>s.study_id from public.validators v cross join qa_membership_scope s where v.id='qa-multi-existing'), 'Original identity overwritten';
end; $$;
select 'PASS: directory, RLS, duplicate prevention, same code, independent activation, reassignment, scope rejection' as verification;
rollback;
