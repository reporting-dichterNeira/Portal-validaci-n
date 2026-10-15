-- Preserve the existing publisher and filtered aggregate; add only segmento.
begin;
set local lock_timeout='5s';
alter table public.admin_alert_export_records add column if not exists segmento text;
comment on column public.admin_alert_export_records.segmento is 'Databricks storeview.slv_sv_ceres_ag_export.segmento; independent of subcanal_modelo.';
create table if not exists private.segment_rollout_functions_backup(signature text primary key,definition text not null,created_at timestamptz not null default now());
alter table private.segment_rollout_functions_backup enable row level security;
revoke all on private.segment_rollout_functions_backup from public,anon,authenticated;
insert into private.segment_rollout_functions_backup(signature,definition)
select oid::regprocedure::text,pg_get_functiondef(oid) from pg_proc
where oid in ('public.finish_admin_databricks_sync(uuid,integer)'::regprocedure,'private.get_databricks_audit_totals(jsonb)'::regprocedure)
on conflict(signature) do nothing;
do $patch$
declare definition text; patched text;
begin
  definition:=pg_get_functiondef('public.finish_admin_databricks_sync(uuid,integer)'::regprocedure);
  if position('stage.record ->> ''segmento''' in definition)=0 then
    patched:=replace(definition,'region, subchannel','region, subchannel, segmento');
    if patched=definition then raise exception 'Publisher column anchor not found'; end if;
    definition:=patched;
    patched:=replace(definition,$old$nullif(stage.record ->> 'subchannel', '')$old$,
      $new$nullif(stage.record ->> 'subchannel', ''), nullif(stage.record ->> 'segmento', '')$new$);
    if patched=definition then raise exception 'Publisher value anchor not found'; end if;
    execute patched;
  end if;
  definition:=pg_get_functiondef('private.get_databricks_audit_totals(jsonb)'::regprocedure);
  if position('channel_segment_totals_ready' in definition)=0 then
    patched:=regexp_replace(definition,$re$\),\s*counts as \($re$,$new$), channel_segment_counts as (
      select study_name,
        coalesce(nullif(upper(translate(regexp_replace(btrim(channel),'[[:space:]]+',' ','g'),'ÁÉÍÓÚáéíóú','AEIOUaeiou')),''),'Sin canal identificado') as channel,
        coalesce(nullif(upper(translate(regexp_replace(btrim(segmento),'[[:space:]]+',' ','g'),'ÁÉÍÓÚáéíóú','AEIOUaeiou')),''),'Sin segmento identificado') as segmento,
        count(distinct nullif(ltrim(audit_external_id,'0'),'')) as databricks_total
      from selected where coalesce(p_filters->>'include_channel_segments','false')='true'
        and source_filename ilike 'Databricks%'
      group by study_name,2,3
    ), counts as ($new$);
    if patched=definition then raise exception 'Aggregate counts anchor not found'; end if;
    definition:=patched;
    patched:=regexp_replace(definition,$re$'snapshots'\s*,$re$,$new$'channel_segments',coalesce((select jsonb_agg(to_jsonb(g)) from channel_segment_counts g),'[]'::jsonb),
      'channel_segment_totals_ready',coalesce(p_filters->>'include_channel_segments','false')='true','snapshots',$new$);
    if patched=definition then raise exception 'Aggregate response anchor not found'; end if;
    execute patched;
  end if;
end;
$patch$;
notify pgrst,'reload schema';
commit;
