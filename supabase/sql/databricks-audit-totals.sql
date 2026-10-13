begin;
create or replace function private.get_databricks_audit_totals(p_filters jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role::text in ('admin','visualizer','commercial')) then
  raise exception 'VISUALIZATION_ACCESS_REQUIRED' using errcode='42501';
 end if;
 with source as (
 select r.*, i.source_filename,i.imported_at,
 case when lower(r.study) ~ 'ko[ _]trad[ _]ch([ _]|$)|chile|embonor' then 'Chile'
 when lower(r.study) like '%lindley%' then 'Lindley'
 when lower(r.study) like '%moderno%' then 'KO Moderno CAM'
 when lower(r.study) like '%trad%' then 'KO Tradicional CAM'
 end as study_name
 from public.admin_alert_export_records r join public.admin_analysis_imports i
 on i.dataset_type='alerts' and i.period_month=r.period_month
 where (coalesce(p_filters->>'month','')='' or r.period_month= ((p_filters->>'month')||'-01')::date)
 and (coalesce(p_filters->>'from','')='' or r.audit_date >= (p_filters->>'from')::date)
 and (coalesce(p_filters->>'to','')='' or r.audit_date <= (p_filters->>'to')::date)
 ), selected as (
 select * from source s where s.study_name is not null
 and (not (p_filters ? 'studies') or jsonb_array_length(p_filters->'studies')=0 or s.study_name in (select jsonb_array_elements_text(p_filters->'studies')))
 and (coalesce(p_filters->>'geography','all')='all' or
 case when s.study_name in ('Chile','Lindley') then coalesce(s.region,'') else coalesce(s.country,'') end = coalesce(nullif(p_filters->>'geography','__missing__'),''))
 and (coalesce(p_filters->>'region','all')='all' or coalesce(nullif(s.region,''),'Sin región')=p_filters->>'region')
 and (coalesce(p_filters->>'channel','all')='all' or coalesce(nullif(s.channel,''),'Sin canal')=p_filters->>'channel')
 and (coalesce(p_filters->>'subchannel','all')='all' or coalesce(nullif(s.subchannel,''),'Sin subcanal')=p_filters->>'subchannel')
 ), counts as (
 select study_name,count(distinct nullif(ltrim(audit_external_id,'0'),'')) as export_total,
 count(distinct nullif(ltrim(audit_external_id,'0'),'')) filter(where source_filename ilike 'Databricks%') as databricks_total,
 bool_and(source_filename ilike 'Databricks%') as verified,
 max(imported_at) as refreshed_at
 from selected group by study_name
 )
 select jsonb_build_object('studies',coalesce((select jsonb_agg(to_jsonb(c)) from counts c),'[]'::jsonb),
 'snapshots',coalesce((select jsonb_agg(jsonb_build_object('month',i.period_month,'source',i.source_filename,'refreshed_at',i.imported_at))
 from public.admin_analysis_imports i where i.dataset_type='alerts'
 and (coalesce(p_filters->>'month','')='' or i.period_month=((p_filters->>'month')||'-01')::date)),'[]'::jsonb)) into result;
 return result;
end; $$;
create or replace function public.get_databricks_audit_totals(p_filters jsonb default '{}'::jsonb)
returns jsonb language sql stable security invoker set search_path='' as $$
 select private.get_databricks_audit_totals(p_filters);
$$;
revoke all on function private.get_databricks_audit_totals(jsonb),public.get_databricks_audit_totals(jsonb) from public,anon;
grant execute on function private.get_databricks_audit_totals(jsonb),public.get_databricks_audit_totals(jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
