-- All changes performed by this test are rolled back, including journal entries.
begin;
do $$ declare chosen record; target text; result jsonb; protected_count integer; rejected boolean:=false;
begin
 select count(*) into protected_count from public.audits where status='completada';
 begin
  perform public.resolve_previous_pending(array[1::bigint],'remove','test',null);
 exception when insufficient_privilege then rejected:=true; end;
 if not rejected then raise exception 'AUTHORIZATION_TEST_FAILED'; end if;
 select a.id,a.study_id,a.country_id,a.module,sa.supervisor_id,a.batch_id into chosen
 from public.audits a join public.upload_batches b on b.id=a.batch_id
 join public.supervisor_assignments sa on sa.study_id=a.study_id and sa.country_id=a.country_id and sa.module=a.module
 join public.profiles p on p.id=sa.supervisor_id and p.is_active and p.role='supervisor'
 where a.status<>'completada' and a.module='blocking' and b.status in ('active','archived')
 and b.operation_date<(now() at time zone 'America/Managua')::date
 and coalesce(a.pending_resolution,'') not in ('removed','replaced')
 and (a.original_operation_date is not null or not exists(select 1 from public.upload_batches latest
 where latest.study_id=a.study_id and latest.country_id=a.country_id and latest.module=a.module
 and latest.operation_date=b.operation_date and latest.status in ('active','archived') and latest.id>b.id))
 and not exists(select 1 from public.audits n join public.upload_batches nb on nb.id=n.batch_id
 where n.study_id=a.study_id and n.country_id=a.country_id and n.module=a.module and n.external_id=a.external_id
 and nb.status in ('active','archived') and n.batch_id>a.batch_id) limit 1;
 if chosen.id is null then raise exception 'NO_REPRESENTATIVE_PENDING_FOR_TEST'; end if;
 perform set_config('request.jwt.claim.sub',chosen.supervisor_id::text,true);
 -- Exercise real authenticated RLS, not just the SQL editor's database-owner role.
 perform set_config('role','authenticated',true);
 result:=public.get_pending_management(chosen.study_id,chosen.module);
 if jsonb_array_length(result->'audits')<1 then raise exception 'SCOPE_READ_FAILED'; end if;
 select m.validator_id into target from public.validator_study_memberships m join public.validators v on v.id=m.validator_id
 where m.study_id=chosen.study_id and m.country_id=chosen.country_id and m.is_active and m.removed_at is null and v.is_active limit 1;
 if target is null then raise exception 'NO_REPRESENTATIVE_VALIDATOR_FOR_TEST'; end if;
 result:=public.resolve_previous_pending(array[chosen.id],'assign','Prueba reversible de reasignación',target);
 if (result->>'changed')::integer<>1 or not exists(select 1 from public.audits a join public.upload_batches b on b.id=a.batch_id
 where a.id=chosen.id and a.pending_resolution='reassigned' and a.assigned_validator_id=target and b.status='active'
 and a.original_operation_date is not null) then raise exception 'REASSIGNMENT_TEST_FAILED'; end if;
 result:=public.resolve_previous_pending(array[chosen.id],'remove','Prueba reversible de retiro',null);
 if not exists(select 1 from public.audits where id=chosen.id and pending_resolution='removed' and assigned_validator_id is null) then raise exception 'REMOVAL_TEST_FAILED'; end if;
 perform set_config('role','postgres',true);
 if (select count(*) from public.audits where status='completada')<>protected_count then raise exception 'COMPLETED_AUDITS_CHANGED'; end if;
 if (select count(*) from public.audits)<>(select count(*) from private.demo_rollout_audits_backup) then raise exception 'AUDIT_COUNT_CHANGED'; end if;
end; $$;
rollback;
select 'auth, scoped reading, reassignment, soft removal and completed preservation: OK (rolled back)' as test_result;
