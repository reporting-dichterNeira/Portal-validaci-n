-- Test every actual country against the effective verified inventory, with
-- a consistent snapshot while the background metadata refresh can continue.
begin isolation level repeatable read;
create temporary table expected_country_ids as
with labels as materialized (
 select study,private.report_context_study(study) as canonical_study
 from (select distinct study from public.admin_alert_export_records) keys
)
select distinct l.canonical_study as study,r.audit_external_id,
 case when l.canonical_study='Chile' then 'Chile'
      when l.canonical_study='Lindley' then 'Perú'
      when lower(case when c.audit_external_id is null then r.country else c.metadata->>'country' end)
        like any(array['%guatemala%','%embocen%']) then 'Guatemala'
      else private.normalize_audit_country(case when c.audit_external_id is null then r.country else c.metadata->>'country' end) end as country
from public.admin_alert_export_records r join public.admin_analysis_imports i
 on i.dataset_type='alerts' and i.period_month=r.period_month
join labels l on l.study=r.study
left join private.audit_report_context_cache c on c.audit_external_id=r.audit_external_id
 and c.study=l.canonical_study
where l.canonical_study is not null
 and lower(btrim(coalesce(r.audit_status,''))) <> 'incidencia'
 and nullif(ltrim(r.audit_external_id,'0'),'') is not null
 and (c.audit_external_id is not null or i.source_filename ilike 'Databricks%');
create temporary table country_total_checks(country text,total_source bigint,total_rpc bigint,elapsed_ms numeric);
do $$ declare country_name text; expected bigint; response jsonb; actual bigint; started timestamptz;
begin
 perform set_config('request.jwt.claim.sub',(select id::text from public.profiles where is_active and role::text='commercial' limit 1),true);
 for country_name,expected in select country,count(*) from expected_country_ids
  where nullif(country,'') is not null group by country order by country loop
  started:=clock_timestamp();
  response:=public.get_databricks_audit_totals(jsonb_build_object('country',country_name,'include_channel_segments',true));
  select coalesce(sum((s->>'databricks_total')::bigint),0) into actual from jsonb_array_elements(response->'studies') s;
  if actual<>expected then raise exception 'Country %: expected %, received %',country_name,expected,actual;end if;
  insert into country_total_checks values(country_name,expected,actual,extract(epoch from clock_timestamp()-started)*1000);
 end loop;
 if (select count(*) from country_total_checks)<8 then raise exception 'Incomplete country coverage';end if;
end $$;
select country,total_source,total_rpc,round(elapsed_ms,1) as elapsed_ms,true as matches_source from country_total_checks order by country;
rollback;
