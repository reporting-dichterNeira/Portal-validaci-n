-- Add independent country filtering without replacing existing access checks.
begin;
do $patch$
declare
  definition text;
  anchor text := 'and (coalesce(p_filters->>''region'',''all'')=''all'' or';
  predicate text := $predicate$
 and (coalesce(p_filters->>'country','all')='all' or
 lower(translate(btrim(case when s.study_name='Chile' then 'Chile' when s.study_name='Lindley' then 'Perú' else coalesce(s.country,'') end), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou'))
 = lower(translate(coalesce(nullif(p_filters->>'country','__missing__'),''), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')))
 $predicate$;
begin
  definition := pg_get_functiondef('private.get_databricks_audit_totals(jsonb)'::regprocedure);
  if position('p_filters->>''country''' in definition) = 0 then
    if position(anchor in definition) = 0 then raise exception 'Expected filter anchor not found; no change applied'; end if;
    execute replace(definition, anchor, predicate || anchor);
  end if;
end;
$patch$;
notify pgrst, 'reload schema';
commit;
