-- Read-only: all capitalization/spacing/accent variants must match the source.
with auth_context as materialized (
  select set_config('request.jwt.claim.sub', (select id::text from public.profiles where is_active and role::text='admin' limit 1), true)
), names(region) as (values ('REGION CENTRO'),('REGION LIMA'),('REGION NORTE')),
variants as (
  select n.region as canonical, v.requested from names n
  cross join lateral (values (n.region), (initcap(n.region)), (replace(lower(n.region),'region','región')), ('  '||replace(n.region,' ','  ')||'  ')) v(requested)
), results as (
  select v.*,
    public.get_databricks_audit_totals(jsonb_build_object('month','2026-10','studies',jsonb_build_array('Lindley'),'region',v.requested)) as by_region,
    public.get_databricks_audit_totals(jsonb_build_object('month','2026-10','studies',jsonb_build_array('Lindley'),'geography',v.requested)) as by_geography,
    (select count(distinct nullif(ltrim(r.audit_external_id,'0'),''))
      from public.admin_alert_export_records r join public.admin_analysis_imports i on i.dataset_type='alerts' and i.period_month=r.period_month
      where r.period_month='2026-10-01' and lower(r.study) like '%lindley%' and i.source_filename ilike 'Databricks%'
        and upper(translate(regexp_replace(btrim(r.region),'[[:space:]]+',' ','g'),'ÁÉÍÓÚáéíóú','AEIOUaeiou'))=v.canonical) as expected
  from variants v cross join auth_context
), totals as (
  select canonical,requested,expected,
    coalesce((select sum((s->>'databricks_total')::bigint) from jsonb_array_elements(by_region->'studies') s),0) as region_total,
    coalesce((select sum((s->>'databricks_total')::bigint) from jsonb_array_elements(by_geography->'studies') s),0) as geography_total
  from results
)
select canonical,requested,expected,region_total,geography_total,
  region_total=expected and geography_total=expected as matches_source from totals order by canonical,requested;
