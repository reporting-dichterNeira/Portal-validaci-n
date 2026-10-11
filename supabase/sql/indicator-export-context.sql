-- Add context to future snapshots only. Do not republish closed historical months.
begin;
insert into private.demo_rollout_functions_backup(signature,definition)
select p.oid::regprocedure::text,pg_get_functiondef(p.oid)
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='finish_admin_databricks_sync'
and not exists(select 1 from private.demo_rollout_functions_backup b where b.signature=p.oid::regprocedure::text);
do $$ declare source text; updated text; begin
 select pg_get_functiondef('public.finish_admin_databricks_sync(uuid,integer)'::regprocedure) into source;
 if position('subchannel' in source)=0 then
  updated:=replace(source,'auditor, audit_date, wave, study','auditor, audit_date, wave, study, region, subchannel');
  updated:=replace(updated,$needle$nullif(stage.record ->> 'study', '')$needle$,
   $replacement$nullif(stage.record ->> 'study', ''),
    nullif(stage.record ->> 'region', ''),
    nullif(stage.record ->> 'subchannel', '')$replacement$);
  if updated=source or position('subchannel' in updated)=0 or position($check$stage.record ->> 'region'$check$ in updated)=0 then
   raise exception 'PUBLISHER_FORMAT_NOT_RECOGNIZED';
  end if;
  execute updated;
 end if;
end; $$;
notify pgrst,'reload schema';
commit;
select position('subchannel' in pg_get_functiondef('public.finish_admin_databricks_sync(uuid,integer)'::regprocedure))>0 as dimensions_enabled;
