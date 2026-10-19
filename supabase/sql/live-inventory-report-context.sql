-- Reclassify existing monthly IDs using live verified metadata. The frozen
-- snapshots, their dates, statuses, IDs, counts and source files are unchanged.
-- Preserve the current aggregate's authorization and every existing filter.
begin;
do $$ declare definition text; patched text; begin
 definition:=pg_get_functiondef('private.get_databricks_audit_totals(jsonb)'::regprocedure);
 if position('/* live-inventory-context-v3 */' in definition)>0 then return;end if;
 if position('/* live-inventory-context */' in definition)>0 then
  patched:=replace(definition,
   $old$case when c.audit_external_id is null then r.country else c.metadata->>'country' end as country$old$,
   $new$case when lower(case when c.audit_external_id is null then r.country else c.metadata->>'country' end)
     like any(array['%guatemala%','%embocen%']) then 'Guatemala'
     else case when c.audit_external_id is null then r.country else c.metadata->>'country' end end as country$new$);
  if patched=definition then raise exception 'Country projection not recognized';end if;
  definition:=replace(patched,'/* live-inventory-context */','/* live-inventory-context-v2 */');
 end if;
 if position('/* live-inventory-context-v2 */' in definition)=0 then
 patched:=replace(definition,
  'select r.study,r.audit_external_id,r.country,r.region,r.channel,r.subchannel,r.segmento,r.auditor,
 i.source_filename,i.imported_at',
  $replacement$select r.study,r.audit_external_id,
 case when lower(case when c.audit_external_id is null then r.country else c.metadata->>'country' end)
   like any(array['%guatemala%','%embocen%']) then 'Guatemala'
   else case when c.audit_external_id is null then r.country else c.metadata->>'country' end end as country,
 case when c.audit_external_id is null then r.region else c.metadata->>'region' end as region,
 case when c.audit_external_id is null then r.channel else c.metadata->>'channel' end as channel,
 case when c.audit_external_id is null then r.subchannel else c.metadata->>'subchannel' end as subchannel,
 case when c.audit_external_id is null then r.segmento else c.metadata->>'segmento' end as segmento,
 case when c.audit_external_id is null then r.auditor else c.metadata->>'auditor' end as auditor,
 case when c.audit_external_id is null then i.source_filename else 'Databricks · catálogo verificado' end as source_filename,
 i.imported_at /* live-inventory-context-v2 */$replacement$);
 if patched=definition then raise exception 'Inventory projection not recognized';end if;
 definition:=patched;
 patched:=replace(definition,
  'from public.admin_alert_export_records r join public.admin_analysis_imports i',
  'from public.admin_alert_export_records r
 left join private.audit_report_context_cache c on c.audit_external_id=r.audit_external_id
   and c.study=private.report_context_study(r.study)
 join public.admin_analysis_imports i');
 if patched=definition then raise exception 'Inventory source not recognized';end if;
 definition:=patched;
 end if;
 patched:=replace(definition,'with base as materialized (',
  'with report_study_keys as materialized (select distinct study from public.admin_alert_export_records),
 report_study_labels as materialized (select study,private.report_context_study(study) as canonical_study from report_study_keys),
 base as materialized (');
 if patched=definition then raise exception 'Inventory CTE not recognized';end if;
 definition:=patched;
 patched:=replace(definition,
  'from public.admin_alert_export_records r
 left join private.audit_report_context_cache c on c.audit_external_id=r.audit_external_id
   and c.study=private.report_context_study(r.study)',
  'from public.admin_alert_export_records r join report_study_labels report_study on report_study.study=r.study
 left join private.audit_report_context_cache c on c.audit_external_id=r.audit_external_id
   and c.study=report_study.canonical_study');
 if patched=definition then raise exception 'Inventory metadata join not recognized';end if;
 patched:=replace(patched,'/* live-inventory-context-v2 */','/* live-inventory-context-v3 */');
 execute patched;
end $$;
notify pgrst,'reload schema';
commit;
