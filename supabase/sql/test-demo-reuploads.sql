-- Synthetic transaction fixture. No batch/audit/decision is committed.
begin;
do $$ declare scope record; old_batch public.upload_batches; fresh public.upload_batches; correction public.upload_batches;
 protected_count integer; partial jsonb := '{"A":{"status":"aplica","decisionAt":"2026-10-08T12:00:00Z"}}';
 payload jsonb := '{"pais":"Panamá","kpis":[{"name":"A","needsReview":true}]}';
begin
 if exists(select 1 from public.audits where external_id in ('999999900001','999999900002')) then raise exception 'TEST_ID_COLLISION'; end if;
 select count(*) into protected_count from public.audits where status='completada';
 select sa.*,s.name as study from public.supervisor_assignments sa join public.profiles p on p.id=sa.supervisor_id
 join public.studies s on s.id=sa.study_id where sa.module='blocking' and p.role='supervisor' and p.is_active limit 1 into scope;
 if scope.supervisor_id is null then raise exception 'NO_TEST_SCOPE'; end if;
 perform set_config('request.jwt.claim.sub',scope.supervisor_id::text,true);
 perform set_config('role','authenticated',true);
 old_batch:=public.create_upload_batch(scope.study_id,scope.module,(now() at time zone 'America/Managua')::date-1,'Prueba transaccional original.csv',2);
 insert into public.audits(external_id,study,study_id,country_id,module,batch_id,status,payload,validation_results)
 values('999999900001',scope.study,scope.study_id,old_batch.country_id,scope.module,old_batch.id,'en_progreso',payload,partial),
 ('999999900002',scope.study,scope.study_id,old_batch.country_id,scope.module,old_batch.id,'completada',payload,partial);
 perform public.activate_upload_batch(old_batch.id,'discard');
 fresh:=public.create_upload_batch(scope.study_id,scope.module,(now() at time zone 'America/Managua')::date,'Prueba transaccional repetida.csv',2);
 insert into public.audits(external_id,study,study_id,country_id,module,batch_id,payload)
 values('999999900001',scope.study,scope.study_id,fresh.country_id,scope.module,fresh.id,payload),
 ('999999900002',scope.study,scope.study_id,fresh.country_id,scope.module,fresh.id,payload);
 perform public.activate_upload_batch(fresh.id,'discard');
 if not exists(select 1 from public.audits where batch_id=fresh.id and external_id='999999900001'
 and validation_results=partial and status='en_progreso' and original_uploaded_at=old_batch.created_at
 and original_operation_date=old_batch.operation_date) then raise exception 'PARTIAL_DECISION_NOT_PRESERVED'; end if;
 if not exists(select 1 from public.audits where batch_id=fresh.id and external_id='999999900002'
 and validation_results=partial and status='completada') then raise exception 'COMPLETED_DECISION_NOT_PRESERVED'; end if;
 if not exists(select 1 from public.audits where batch_id=old_batch.id and external_id='999999900001'
 and pending_resolution='replaced' and assigned_validator_id is null) then raise exception 'DUPLICATE_NOT_RETIRED'; end if;
 correction:=public.create_upload_batch(scope.study_id,scope.module,(now() at time zone 'America/Managua')::date,'Prueba transaccional corregida.csv',2);
 insert into public.audits(external_id,study,study_id,country_id,module,batch_id,payload)
 values('999999900001',scope.study,scope.study_id,correction.country_id,scope.module,correction.id,
 '{"pais":"Panamá","kpis":[{"name":"B","needsReview":true}]}'),
 ('999999900002',scope.study,scope.study_id,correction.country_id,scope.module,correction.id,payload);
 perform public.activate_upload_batch(correction.id,'discard');
 if not exists(select 1 from public.audits where batch_id=correction.id and external_id='999999900001'
 and status='pendiente' and validation_results='{}'::jsonb) then raise exception 'CORRECTION_INHERITED_OLD_DECISIONS'; end if;
 perform set_config('role','postgres',true);
 if (select count(*) from public.audits where status='completada' and external_id not in ('999999900001','999999900002'))<>protected_count then
  raise exception 'EXISTING_COMPLETED_AUDITS_CHANGED'; end if;
end; $$;
rollback;
select 'authenticated RLS, repeated upload, partial/completed preservation, correction: OK (rolled back)' as test_result;
