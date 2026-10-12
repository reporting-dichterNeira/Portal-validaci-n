begin;
-- Existing permissions, scope checks, row locks and decision history are retained.
do $patch$
declare listing text; resolving text;
begin
 listing:=pg_get_functiondef('public.get_pending_management(uuid,public.audit_module)'::regprocedure);
 resolving:=pg_get_functiondef('private.resolve_previous_pending(bigint[],text,text,text)'::regprocedure);
 if position('ALL_DAYS_PENDING_TRACKING' in listing)=0 then
  if position('and coalesce(a.original_operation_date,b.operation_date)<(now() at time zone ''America/Managua'')::date' in listing)=0 then
   raise exception 'Unexpected pending listing definition; nothing changed';
  end if;
  listing:=replace(listing,'and coalesce(a.original_operation_date,b.operation_date)<(now() at time zone ''America/Managua'')::date','-- ALL_DAYS_PENDING_TRACKING');
  listing:=replace(listing,'''validator_name'',coalesce(v.name,''Sin asignar'')',
   '''load_batch_id'',coalesce((select origin.id from public.upload_batches origin where origin.study_id=a.study_id and origin.country_id=a.country_id and origin.module=a.module and origin.operation_date=a.original_operation_date and origin.source_filename=a.original_source_filename and origin.created_at=a.original_uploaded_at limit 1),a.batch_id),''validator_name'',coalesce(v.name,''Sin asignar'')');
  execute listing;
 end if;
 if position('ALL_DAYS_PENDING_TRACKING' in resolving)=0 then
  if position('or coalesce(a.original_operation_date,old_batch.operation_date)>=(now() at time zone ''America/Managua'')::date' in resolving)=0 then
   raise exception 'Unexpected pending action definition; nothing changed';
  end if;
  resolving:=replace(resolving,'or coalesce(a.original_operation_date,old_batch.operation_date)>=(now() at time zone ''America/Managua'')::date','/* ALL_DAYS_PENDING_TRACKING */');
  execute resolving;
 end if;
end $patch$;
notify pgrst,'reload schema';
commit;
select position('ALL_DAYS_PENDING_TRACKING' in pg_get_functiondef('public.get_pending_management(uuid,public.audit_module)'::regprocedure))>0 as seguimiento_incluye_hoy,
position('ALL_DAYS_PENDING_TRACKING' in pg_get_functiondef('private.resolve_previous_pending(bigint[],text,text,text)'::regprocedure))>0 as decisiones_incluyen_hoy;
