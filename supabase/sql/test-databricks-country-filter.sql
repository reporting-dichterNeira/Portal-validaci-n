-- Read-only verification: country totals must match the source, and anonymous
-- callers must still be rejected. Claim settings are local to this transaction.
do $verify$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
  begin
    perform public.get_databricks_audit_totals('{}'::jsonb);
    raise exception 'Unexpected anonymous access';
  exception when insufficient_privilege then null;
  end;
end;
$verify$;

with auth_context as materialized (
  select set_config('request.jwt.claim.sub', (select id::text from public.profiles where is_active and role::text='admin' limit 1), true)
), countries(country) as (values ('all'), ('Chile'), ('Perú'), ('Panamá')),
source as (
  select r.*,
    case when lower(r.study) ~ 'ko[ _]trad[ _]ch([ _]|$)|chile|embonor' then 'Chile'
      when lower(r.study) like '%lindley%' then 'Lindley'
      when lower(r.study) like '%moderno%' then 'KO Moderno CAM'
      when lower(r.study) like '%trad%' then 'KO Tradicional CAM' end as study_name
  from public.admin_alert_export_records r join public.admin_analysis_imports i
    on i.dataset_type='alerts' and i.period_month=r.period_month
  where r.period_month='2026-10-01' and i.source_filename ilike 'Databricks%'
), results as (
  select c.country, public.get_databricks_audit_totals(jsonb_build_object('month','2026-10','country',c.country)) as data
  from countries c cross join auth_context
), comparison as (
  select r.country,
    coalesce((select sum((s->>'databricks_total')::bigint) from jsonb_array_elements(r.data->'studies') s), 0) as total_rpc,
    (select count(*) from (
      select distinct s.study_name, nullif(ltrim(s.audit_external_id,'0'),'') as audit_id
      from source s where s.study_name is not null and nullif(ltrim(s.audit_external_id,'0'),'') is not null
        and (r.country='all' or
          lower(translate(btrim(case when s.study_name='Chile' then 'Chile' when s.study_name='Lindley' then 'Perú' else coalesce(s.country,'') end),'ÁÉÍÓÚáéíóú','AEIOUaeiou'))
          = lower(translate(r.country,'ÁÉÍÓÚáéíóú','AEIOUaeiou')))
    ) ids) as total_source
  from results r
)
select country, total_rpc, total_source, total_rpc=total_source as matches_source from comparison order by country;
