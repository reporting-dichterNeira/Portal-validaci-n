-- One-time/repeatable data enrichment. No grants, assignments or decisions change.
-- Preserve the source value in a separate field before the existing audit-country
-- trigger normalizes PAIS. Persist a derived reporting field so
-- commercial readers can see the result without receiving access to raw exports.
begin;
with export_names as (
  select audit_external_id,
    case when lower(coalesce(study,'')) ~ 'ko_trad|tradicional' then 'Tradicional'
         when lower(coalesce(study,'')) ~ 'ko_moderno|moderno' then 'Moderno'
         when lower(coalesce(study,'')) ~ 'lindley' then 'Lindley'
         when lower(coalesce(study,'')) ~ 'chile' then 'Chile' else null end as study,
    translate(lower(trim(coalesce(country,''))), 'áéíóúüñ', 'aeiouun') as name
  from public.admin_alert_export_records
), normalized as (
  select audit_external_id, study,
    case
      when name ~ '(^|[^a-z])guatemala([^a-z]|$)' then 'Guatemala'
      when name in ('cr','costa rica') then 'Costa Rica'
      when name in ('sv','el salvador') then 'El Salvador'
      when name in ('pa','panama') then 'Panamá'
      when name in ('hn','honduras') then 'Honduras'
      when name in ('ni','nicaragua') then 'Nicaragua'
      when name in ('co','colombia') then 'Colombia'
      when name in ('do','republica dominicana') then 'República Dominicana'
      when name in ('pe','peru') then 'Perú'
      when name in ('cl','chile') then 'Chile'
      when name in ('mx','mexico') then 'México'
      when name in ('ec','ecuador') then 'Ecuador'
      else null
    end as country
  from export_names
), resolved as (
  select a.id, min(e.country) as country
  from public.audits a
  join normalized e on e.audit_external_id = a.external_id
    and (e.study is null or e.study = a.study)
  where a.study in ('Tradicional','Moderno')
    and a.status = 'completada'::public.audit_status
    and (nullif(trim(a.payload->>'pais'),'') is null or a.payload->>'pais' ~ '^[0-9]+([.,]0+)?$')
    and e.country is not null
  group by a.id
  having count(distinct e.country) = 1
), enriched as (
  update public.audits a set payload = coalesce(a.payload,'{}'::jsonb)
    || jsonb_build_object('benchmark_country', r.country, 'benchmark_country_source', 'databricks_export',
      'benchmark_source_country', a.payload->>'pais')
  from resolved r where a.id = r.id
    and a.payload->>'benchmark_country' is distinct from r.country
  returning a.study
)
select study, count(*) as recovered_countries from enriched group by study;
commit;
