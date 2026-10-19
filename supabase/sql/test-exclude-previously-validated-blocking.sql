-- Run after the fix. All fixture rows and updates are rolled back.
begin;
do $test$
declare source public.audits%rowtype; other_batch bigint; fixture_id text;
 first_row bigint; second_row bigint; smart_row bigint;
begin
 select a.* into strict source from public.audits a
 join public.upload_batches b on b.id=a.batch_id
 where a.module='blocking' and a.status='completada' and b.status in ('active','archived')
 and exists(select 1 from public.upload_batches smart where smart.study_id=a.study_id
   and smart.country_id=a.country_id and smart.module='smart' and smart.status in ('active','archived'))
 and exists(select 1 from public.upload_batches other where other.study_id=a.study_id
   and other.country_id=a.country_id and other.module='blocking' and other.id<>a.batch_id
   and other.status in ('active','archived')) limit 1;
 select id into strict other_batch from public.upload_batches b
 where b.study_id=source.study_id and b.country_id=source.country_id
 and b.module='blocking' and b.id<>source.batch_id and b.status in ('active','archived') limit 1;
 fixture_id:='999999999999999999';
 if exists(select 1 from public.audits where external_id=fixture_id) then raise exception 'Fixture ID is already in use'; end if;
 insert into public.audits(module,batch_id,external_id,study,study_id,country_id,status,payload,validation_results)
 values('blocking',source.batch_id,fixture_id,source.study,source.study_id,source.country_id,'pendiente',source.payload,'{}') returning id into first_row;
 insert into public.audits(module,batch_id,external_id,study,study_id,country_id,status,payload,validation_results)
 values('blocking',other_batch,fixture_id,source.study,source.study_id,source.country_id,'pendiente',source.payload,'{}') returning id into second_row;
 -- Smart must stay independent, even with the same ID, study and country.
 insert into public.audits(module,batch_id,external_id,study,study_id,country_id,status,payload,validation_results)
 select 'smart',b.id,fixture_id,a.study,source.study_id,source.country_id,'pendiente',a.payload,'{}'
 from public.upload_batches b join public.audits a on a.batch_id=b.id
 where b.module='smart' and b.study_id=source.study_id
 and b.country_id=source.country_id and b.status in ('active','archived') limit 1 returning id into smart_row;
 if smart_row is null then raise exception 'No Smart batch for independence test'; end if;
 if exists(select 1 from public.audits where id in(first_row,second_row) and pending_resolution is not null) then raise exception 'Unvalidated duplicates were excluded'; end if;
 update public.audits set status='completada',completed_at=now() where id=first_row;
 if not exists(select 1 from public.audits where id=second_row and status='pendiente' and pending_resolution='replaced'
   and payload#>>'{_previousBlockingValidation,audit_row_id}'=first_row::text) then raise exception 'Completion did not exclude Blocking repeat'; end if;
 if not exists(select 1 from public.audits where id=smart_row and status='pendiente' and pending_resolution is null) then raise exception 'Smart was changed'; end if;
 -- Simulate a repeated import trying to reopen the excluded row.
 update public.audits set pending_resolution=null where id=second_row;
 if not exists(select 1 from public.audits where id=second_row and pending_resolution='replaced') then raise exception 'Reimport reopened a completed ID'; end if;
end $test$;
rollback;
select 'Bloqueantes: completado excluye repetido; Smart independiente; fixtures revertidas' as resultado;
