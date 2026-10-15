-- Add optional field-auditor denominators to the existing filtered aggregate.
-- Retains the current authorization, search_path, grants and all predicates.
begin;
do $patch$
declare definition text; patched text;
begin
  definition := pg_get_functiondef('private.get_databricks_audit_totals(jsonb)'::regprocedure);
  if position('auditor_totals_ready' in definition)=0 then
    patched := regexp_replace(definition, $re$\),\s*counts as \($re$, $new$), auditor_counts as (
      select lower(regexp_replace(btrim(auditor), '[[:space:]]+', ' ', 'g')) as auditor,
        count(distinct (study_name, nullif(ltrim(audit_external_id,'0'),''))) as databricks_total
      from selected
      where coalesce(p_filters->>'include_auditors','false')='true'
        and source_filename ilike 'Databricks%'
        and nullif(btrim(auditor),'') is not null
        and nullif(ltrim(audit_external_id,'0'),'') is not null
      group by lower(regexp_replace(btrim(auditor), '[[:space:]]+', ' ', 'g'))
    ), counts as ($new$);
    if patched=definition then raise exception 'Counts anchor not found; nothing changed'; end if;
    definition := patched;
    patched := regexp_replace(definition, $re$'snapshots'\s*,$re$, $new$'auditors',coalesce((select jsonb_agg(to_jsonb(a)) from auditor_counts a),'[]'::jsonb),
      'auditor_totals_ready',coalesce(p_filters->>'include_auditors','false')='true','snapshots',$new$);
    if patched=definition then raise exception 'Response anchor not found; nothing changed'; end if;
    execute patched;
  end if;
end;
$patch$;
notify pgrst,'reload schema';
commit;
