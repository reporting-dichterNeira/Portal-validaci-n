-- Archived or retired cases cannot block current roster changes.
do $$
declare definition text; revised text;
begin
 select pg_get_functiondef('private.set_validator_module(text,uuid,uuid,text,boolean,boolean)'::regprocedure) into definition;
 revised:=replace(definition,
  $old$a.module::text=p_module and a.status='en_progreso'$old$,
  $new$a.module::text=p_module and a.status='en_progreso' and coalesce(a.pending_resolution,'') not in ('removed','replaced') and exists(select 1 from public.upload_batches current_batch where current_batch.id=a.batch_id and current_batch.status='active')$new$);
 if revised=definition then raise exception 'EXPECTED_PROGRESS_GUARD_NOT_FOUND'; end if;
 execute revised;
end $$;
