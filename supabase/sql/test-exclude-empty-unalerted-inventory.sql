begin;
create temporary table empty_inventory as select * from public.admin_alert_export_records with no data;
create temporary table blocking_fixtures(external_id text,study text,module text,payload jsonb);
insert into empty_inventory(study,audit_external_id,period_month,audit_date,audit_status,country,region,channel,segmento,auditor)
select 'ko_trad_ch_test',f.id,i.period_month,i.period_month,'Aprobada','Chile',f.region,f.channel,'ORO','test-auditor'
from (values
 ('999990001001',null,null),('999990001002',' ',' '),
 ('999990001003','TALCA',null),('999990001004',null,'HOME MARKET TRADICIONAL'),
 ('999990001005',null,null),('999990001006',null,null),
 ('999990001007',null,null),('999990001008',null,null),
 ('999990001009',null,null),('999990001010','Sin región identificada','Sin canal identificado')
)f(id,region,channel)
cross join lateral(select period_month from public.admin_analysis_imports
 where dataset_type='alerts' and source_filename ilike 'Databricks%' order by period_month desc limit 1)i;
insert into blocking_fixtures values
 ('999990001005','Chile','blocking','{"kpis":[{"needsReview":true}]}'),
 ('999990001006','Chile','smart','{"kpis":[{"needsReview":true}]}'),
 ('999990001007','Lindley','blocking','{"kpis":[{"needsReview":true}]}'),
 ('999990001008','Chile','blocking','{"kpis":[{"needsReview":false}]}'),
 ('999990001009','Chile','blocking','{"kpis":[{"alertaStatus":"SE ALERTA"}]}');
do $$ declare definition text; response jsonb; section text; filters jsonb; total bigint;
begin
 if (select count(*) from empty_inventory)<>10 then raise exception 'Missing Databricks snapshot fixture';end if;
 definition:=pg_get_functiondef('private.get_databricks_audit_totals(jsonb)'::regprocedure);
 if position('/* exclude-empty-unalerted-inventory */' in definition)=0 then raise exception 'Missing exclusion';end if;
 definition:=replace(definition,'private.get_databricks_audit_totals','pg_temp.empty_inventory_totals');
 definition:=replace(definition,'public.admin_alert_export_records','pg_temp.empty_inventory');
 definition:=replace(definition,'public.audits a','pg_temp.blocking_fixtures a');
 execute definition;
 perform set_config('request.jwt.claim.sub',(select id::text from public.profiles where is_active and role::text='commercial' limit 1),true);
 for filters in select value from jsonb_array_elements('[{}, {"country":"Chile"}, {"studies":["Chile"]}]') loop
  response:=pg_temp.empty_inventory_totals(filters || '{"include_auditors":true,"include_channel_segments":true}'::jsonb);
  foreach section in array array['studies','territories','auditors','channel_segments'] loop
   select coalesce(sum((r->>'databricks_total')::bigint),0) into total from jsonb_array_elements(response->section) r;
   if total<>4 then raise exception 'Expected 4 protected audits in %, filters %, got %',section,filters,total;end if;
  end loop;
 end loop;
 response:=pg_temp.empty_inventory_totals('{"region":"TALCA"}'::jsonb);
 if (response->'studies'->0->>'databricks_total')::int is distinct from 1 then raise exception 'Region-only audit removed';end if;
 response:=pg_temp.empty_inventory_totals('{"channel":"HOME MARKET TRADICIONAL"}'::jsonb);
 if (response->'studies'->0->>'databricks_total')::int is distinct from 1 then raise exception 'Channel-only audit removed';end if;
end $$;
select true as empty_unalerted_excluded,true as partial_geography_preserved,true as blocking_alerts_preserved,
 true as smart_and_other_studies_kept_separate;
rollback;
