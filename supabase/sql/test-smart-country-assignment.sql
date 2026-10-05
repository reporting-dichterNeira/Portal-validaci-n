-- Execute in SQL Editor as postgres. All fixtures/settings roll back.
begin;
do $$
declare scope record; test_validator text := 'TEST-COUNTRY-' || gen_random_uuid()::text;
  test_batch bigint; rejected boolean; stored_country text;
begin
  select sa.*,s.name as study_name into scope from public.supervisor_assignments sa
    join public.studies s on s.id=sa.study_id join public.profiles p on p.id=sa.supervisor_id
    where sa.module='smart' and s.name in ('Moderno','Tradicional') and p.is_active limit 1;
  if not found then raise exception 'No Smart KO supervisor scope available for test'; end if;
  insert into public.validators(id,code,name,study,study_id,country_id)
    values(test_validator,'VAL-'||upper(substr(gen_random_uuid()::text,1,8)),'Prueba transaccional de país',scope.study_name,scope.study_id,scope.country_id);
  insert into public.upload_batches(module,study_id,country_id,operation_date,source_filename,status,created_by)
    values('smart',scope.study_id,scope.country_id,date '2026-10-05','Prueba transaccional de país','draft',scope.supervisor_id)
    returning id into test_batch;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',scope.supervisor_id,'role','authenticated')::text,true);
  perform public.set_study_validator_smart_country(test_validator,scope.study_id,scope.country_id,'PANAMA',true);
  select smart_country into stored_country from public.validator_study_memberships
    where validator_id=test_validator and study_id=scope.study_id and country_id=scope.country_id;
  if stored_country <> 'Panamá' then raise exception 'Country preference not persisted'; end if;
  insert into public.audits(module,batch_id,external_id,study,study_id,country_id,assigned_validator_id,payload)
    values('smart',test_batch,'990000000001',scope.study_name,scope.study_id,scope.country_id,test_validator,'{"pais":"PANAMA"}'::jsonb);
  select payload->>'pais' into stored_country from public.audits where batch_id=test_batch and external_id='990000000001';
  if stored_country <> 'Panamá' then raise exception 'Audit country not persisted canonically'; end if;
  rejected:=false;
  begin
    insert into public.audits(module,batch_id,external_id,study,study_id,country_id,assigned_validator_id,payload)
      values('smart',test_batch,'990000000002',scope.study_name,scope.study_id,scope.country_id,test_validator,'{"pais":"Costa Rica"}'::jsonb);
  exception when sqlstate '22023' then rejected:=true; end;
  if not rejected then raise exception 'Incompatible country assignment was allowed'; end if;
  rejected:=false;
  begin
    insert into public.audits(module,batch_id,external_id,study,study_id,country_id,payload)
      values('smart',test_batch,'990000000003',scope.study_name,scope.study_id,scope.country_id,'{"pais":"1097"}'::jsonb);
  exception when sqlstate '22023' then rejected:=true; end;
  if not rejected then raise exception 'Numeric ID_PAIS was allowed'; end if;
  perform set_config('request.jwt.claims','{}',true);
  rejected:=false;
  begin
    perform public.set_study_validator_smart_country(test_validator,scope.study_id,scope.country_id,'Costa Rica',null);
  exception when insufficient_privilege then rejected:=true; end;
  if not rejected then raise exception 'Unauthenticated country write was allowed'; end if;
end; $$;
rollback;
select 'OK: país guardado, asignación incorrecta e ID_PAIS rechazados, autenticación requerida; pruebas revertidas' as resultado;
