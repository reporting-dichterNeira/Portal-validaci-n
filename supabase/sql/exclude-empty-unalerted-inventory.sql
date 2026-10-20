-- Exclude an inventory audit only when BOTH effective Databricks dimensions
-- are missing AND it has never generated a blocking alert in this study.
-- The test is independent of date/country/module filters and validation state.
-- Keep source snapshots and all operational audits/decisions intact.
begin;
do $$ declare definition text; patched text; begin
 definition:=pg_get_functiondef('private.get_databricks_audit_totals(jsonb)'::regprocedure);
 if position('/* exclude-empty-unalerted-inventory */' in definition)>0 then return;end if;
 patched:=replace(definition,
  'selected as ( select * from source s where s.study_name is not null',
  $filter$selected as ( select * from source s where s.study_name is not null
   and (lower(btrim(coalesce(s.region,''))) not in ('','sin región','sin region','sin región identificada','sin region identificada')
     or lower(btrim(coalesce(s.channel,''))) not in ('','sin canal','sin canal identificado')
     or exists (select 1 from public.audits a
       where a.external_id=nullif(ltrim(s.audit_external_id,'0'),'') and a.module='blocking'
        and a.study=case s.study_name when 'KO Tradicional CAM' then 'Tradicional'
          when 'KO Moderno CAM' then 'Moderno' else s.study_name end
        and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(a.payload->'kpis')='array'
          then a.payload->'kpis' else '[]'::jsonb end) k
          where k->>'needsReview'='true' or k->>'alertaStatus'='SE ALERTA')))
       /* exclude-empty-unalerted-inventory */$filter$);
 if patched=definition then raise exception 'Effective reporting source not recognized';end if;
 execute patched;
end $$;
notify pgrst,'reload schema';
commit;
