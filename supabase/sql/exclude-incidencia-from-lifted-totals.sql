-- All reporting denominators share this input: study, territory, auditor,
-- channel/segment, percentage cards and their PDF/CSV exports.
-- Filter the snapshot status without deleting inventory or operational audits.
begin;
do $$ declare definition text; patched text; begin
 definition:=pg_get_functiondef('private.get_databricks_audit_totals(jsonb)'::regprocedure);
 if position('/* exclude-incidencia-from-lifted */' in definition)>0 then return;end if;
 patched:=replace(definition,
  'where (coalesce(p_filters->>''month'','''')='''' or r.period_month=',
  'where lower(btrim(coalesce(r.audit_status,''''))) <> ''incidencia'' /* exclude-incidencia-from-lifted */
   and (coalesce(p_filters->>''month'','''')='''' or r.period_month=');
 if patched=definition then raise exception 'Reporting inventory filter not recognized';end if;
 execute patched;
end $$;
notify pgrst,'reload schema';
commit;
