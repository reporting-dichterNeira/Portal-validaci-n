-- Normalize comparisons only; retain source values and current access checks.
begin;
do $patch$
declare
  definition text;
  patched text;
  normalizer text := $expr$upper(translate(regexp_replace(btrim(%s), '[[:space:]]+', ' ', 'g'), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou'))$expr$;
  region_pattern text := $expr$coalesce\(nullif\(s\.region,''\),'Sin región'\)\s*=\s*p_filters->>'region'$expr$;
  geography_pattern text := $expr$case when s\.study_name in \('Chile','Lindley'\) then coalesce\(s\.region,''\) else coalesce\(s\.country,''\) end\s*=\s*coalesce\(nullif\(p_filters->>'geography','__missing__'\),''\)$expr$;
begin
  definition := pg_get_functiondef('private.get_databricks_audit_totals(jsonb)'::regprocedure);
  if position('/* normalized-report-regions */' in definition)=0 then
    patched := regexp_replace(definition, region_pattern,
      format(normalizer, $expr$coalesce(nullif(s.region,''),'Sin región')$expr$) || ' = ' ||
      format(normalizer, $expr$p_filters->>'region'$expr$) || ' /* normalized-report-regions */');
    if patched=definition then raise exception 'Region filter not found; no change applied'; end if;
    definition := patched;
    patched := regexp_replace(definition, geography_pattern,
      format(normalizer, $expr$case when s.study_name in ('Chile','Lindley') then coalesce(s.region,'') else coalesce(s.country,'') end$expr$) || ' = ' ||
      format(normalizer, $expr$coalesce(nullif(p_filters->>'geography','__missing__'),'')$expr$));
    if patched=definition then raise exception 'Geography filter not found; no change applied'; end if;
    execute patched;
  end if;
end;
$patch$;
notify pgrst,'reload schema';
commit;
