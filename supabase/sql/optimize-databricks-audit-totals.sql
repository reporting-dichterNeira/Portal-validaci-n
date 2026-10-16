-- Optimize the existing metrics aggregate without changing authorization,
-- filters, denominators or returned fields. Narrow the shared input and
-- normalize the distinct study/territory labels once, instead of per audit.
-- Verified against the previous function with six real filter combinations.
begin;
CREATE OR REPLACE FUNCTION private.get_databricks_audit_totals(p_filters jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
declare result jsonb;
begin
 if auth.uid() is null or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role::text in ('admin','supervisor','visualizer','commercial')) then raise exception 'VISUALIZATION_ACCESS_REQUIRED' using errcode='42501'; end if;
 with base as materialized (
 select r.study,r.audit_external_id,r.country,r.region,r.channel,r.subchannel,r.segmento,r.auditor,
 i.source_filename,i.imported_at
 from public.admin_alert_export_records r join public.admin_analysis_imports i
 on i.dataset_type='alerts' and i.period_month=r.period_month where (coalesce(p_filters->>'month','')='' or r.period_month=((p_filters->>'month')||'-01')::date)
   and (coalesce(p_filters->>'from','')='' or r.audit_date >= (p_filters->>'from')::date)
   and (coalesce(p_filters->>'to','')='' or r.audit_date <= (p_filters->>'to')::date)
 ), study_keys as materialized (select distinct study from base),
 study_labels as materialized (select study,case
   when lower(study) ~ 'ko[ _]trad[ _]ch([ _]|$)|chile|embonor' then 'Chile'
   when lower(study) like '%lindley%' then 'Lindley'
   when lower(study) like '%moderno%' then 'KO Moderno CAM'
   when lower(study) like '%trad%' then 'KO Tradicional CAM' end as study_name from study_keys),
 source as (select b.*,l.study_name from base b join study_labels l on b.study=l.study),
selected as ( select * from source s where s.study_name is not null
   and (not (p_filters ? 'studies') or jsonb_array_length(p_filters->'studies')=0 or s.study_name in (select jsonb_array_elements_text(p_filters->'studies')))
   and (coalesce(p_filters->>'geography','all')='all' or upper(translate(regexp_replace(btrim(case when s.study_name in ('Chile','Lindley') then coalesce(s.region,'') else coalesce(s.country,'') end), '[[:space:]]+', ' ', 'g'), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')) = upper(translate(regexp_replace(btrim(coalesce(nullif(p_filters->>'geography','__missing__'),'')), '[[:space:]]+', ' ', 'g'), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')))
   and (coalesce(p_filters->>'country','all')='all' or lower(translate(btrim(case when s.study_name='Chile' then 'Chile' when s.study_name='Lindley' then 'Perú' else coalesce(s.country,'') end), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')) = lower(translate(coalesce(nullif(p_filters->>'country','__missing__'),''), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')))
   and (coalesce(p_filters->>'region','all')='all' or upper(translate(regexp_replace(btrim(coalesce(nullif(s.region,''),'Sin región')), '[[:space:]]+', ' ', 'g'), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')) = upper(translate(regexp_replace(btrim(p_filters->>'region'), '[[:space:]]+', ' ', 'g'), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')) /* normalized-report-regions */)
   and (coalesce(p_filters->>'channel','all')='all' or coalesce(nullif(s.channel,''),'Sin canal')=p_filters->>'channel')
   and (coalesce(p_filters->>'subchannel','all')='all' or coalesce(nullif(s.subchannel,''),'Sin subcanal')=p_filters->>'subchannel') ), territory_keys as materialized (
 select distinct study_name,coalesce(region,'') as region,coalesce(country,'') as country from selected
 ), territory_labels as materialized (select k.*,case when study_name in ('Chile','Lindley') then coalesce(nullif(upper(translate(regexp_replace(btrim(region), '[[:space:]]+', ' ', 'g'), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')),''),'Sin región identificada') else coalesce(nullif(case
   when lower(country) like '%guatemala%' or lower(country) like '%embocen%' then 'Guatemala' else private.normalize_audit_country(country) end,''),'Sin país identificado') end as geography from territory_keys k
 ), territory_source as (
 select s.audit_external_id,s.source_filename,s.study_name,t.geography from selected s join territory_labels t
 on s.study_name=t.study_name and coalesce(s.region,'')=t.region and coalesce(s.country,'')=t.country
 ),
 territory_counts as ( select study_name, geography, count(distinct nullif(ltrim(audit_external_id,'0'),'')) filter(where source_filename ilike 'Databricks%') as databricks_total, bool_and(source_filename ilike 'Databricks%') as verified from territory_source group by study_name, geography ),
 auditor_counts as ( select lower(regexp_replace(btrim(auditor), '[[:space:]]+', ' ', 'g')) as auditor, count(distinct (study_name, nullif(ltrim(audit_external_id,'0'),''))) as databricks_total from selected where coalesce(p_filters->>'include_auditors','false')='true' and source_filename ilike 'Databricks%' and nullif(btrim(auditor),'') is not null and nullif(ltrim(audit_external_id,'0'),'') is not null group by lower(regexp_replace(btrim(auditor), '[[:space:]]+', ' ', 'g')) ),
 channel_segment_counts as ( select study_name, coalesce(nullif(upper(translate(regexp_replace(btrim(channel),'[[:space:]]+',' ','g'),'ÁÉÍÓÚáéíóú','AEIOUaeiou')),''),'Sin canal identificado') as channel, coalesce(nullif(upper(translate(regexp_replace(btrim(segmento),'[[:space:]]+',' ','g'),'ÁÉÍÓÚáéíóú','AEIOUaeiou')),''),'Sin segmento identificado') as segmento, count(distinct nullif(ltrim(audit_external_id,'0'),'')) as databricks_total from selected where coalesce(p_filters->>'include_channel_segments','false')='true' and source_filename ilike 'Databricks%' group by study_name,2,3 ),
 counts as ( select study_name,count(distinct nullif(ltrim(audit_external_id,'0'),'')) as export_total,count(distinct nullif(ltrim(audit_external_id,'0'),'')) filter(where source_filename ilike 'Databricks%') as databricks_total,bool_and(source_filename ilike 'Databricks%') as verified,max(imported_at) as refreshed_at from selected group by study_name ) select jsonb_build_object('studies',coalesce((select jsonb_agg(to_jsonb(c)) from counts c),'[]'::jsonb),'territories',coalesce((select jsonb_agg(to_jsonb(t)) from territory_counts t),'[]'::jsonb), 'territory_totals_ready',true,'auditors',coalesce((select jsonb_agg(to_jsonb(a)) from auditor_counts a),'[]'::jsonb), 'auditor_totals_ready',coalesce(p_filters->>'include_auditors','false')='true','channel_segments',coalesce((select jsonb_agg(to_jsonb(g)) from channel_segment_counts g),'[]'::jsonb), 'channel_segment_totals_ready',coalesce(p_filters->>'include_channel_segments','false')='true','snapshots',coalesce((select jsonb_agg(jsonb_build_object('month',i.period_month,'source',i.source_filename,'refreshed_at',i.imported_at)) from public.admin_analysis_imports i where i.dataset_type='alerts'
   and (coalesce(p_filters->>'month','')='' or i.period_month=((p_filters->>'month')||'-01')::date)),'[]'::jsonb)) into result;
 return result;
end;
$function$;
notify pgrst,'reload schema';
commit;
