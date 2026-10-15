-- Extend the existing aggregate, retaining its authorization and filters.
begin;
do $patch$
declare definition text; patched text;
begin
  definition := pg_get_functiondef('private.get_databricks_audit_totals(jsonb)'::regprocedure);
  if position('territory_totals_ready' in definition)=0 then
    patched := regexp_replace(definition, $re$\),\s*counts as \($re$, $new$), territory_source as (
      select s.*,
        case when study_name in ('Chile','Lindley') then
          coalesce(nullif(upper(translate(regexp_replace(btrim(region), '[[:space:]]+', ' ', 'g'), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')),''),'Sin región identificada')
        else coalesce(nullif(case when lower(country) like '%guatemala%' or lower(country) like '%embocen%' then 'Guatemala'
          else private.normalize_audit_country(country) end,''),'Sin país identificado') end as geography
      from selected s
    ), territory_counts as (
      select study_name, geography,
        count(distinct nullif(ltrim(audit_external_id,'0'),'')) filter(where source_filename ilike 'Databricks%') as databricks_total,
        bool_and(source_filename ilike 'Databricks%') as verified
      from territory_source group by study_name, geography
    ), counts as ($new$);
    if patched=definition then raise exception 'Counts anchor not found; nothing changed'; end if;
    definition := patched;
    patched := regexp_replace(definition, $re$'snapshots'\s*,$re$, $new$'territories',coalesce((select jsonb_agg(to_jsonb(t)) from territory_counts t),'[]'::jsonb),
      'territory_totals_ready',true,'snapshots',$new$);
    if patched=definition then raise exception 'Response anchor not found; nothing changed'; end if;
    execute patched;
  end if;
end;
$patch$;
notify pgrst,'reload schema';
commit;
