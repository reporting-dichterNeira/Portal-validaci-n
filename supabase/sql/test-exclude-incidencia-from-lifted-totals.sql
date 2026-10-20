-- Execute the real aggregate over temporary fixtures. No production rows or
-- function definitions are changed; the cloned function is rolled back.
begin;
create temporary table incident_inventory as select * from public.admin_alert_export_records with no data;
insert into incident_inventory(study,audit_external_id,period_month,audit_date,audit_status,country,region,channel,subchannel,segmento,auditor)
select 'ko_trad_ch_test',f.id,i.period_month,i.period_month,f.status,'Chile','TALCA','HOME MARKET TRADICIONAL','Tradicional','ORO','test-auditor'
from (values ('999990000001','Aprobada'),('999990000002','Incidencia'),
 ('999990000003',' INCIDENCIA '),('999990000004',null),('999990000005','Cancelada'),
 ('999990000006','Exenta'),('999990000007','Requiere Aprobación'),
 ('999990000008','En Proceso'),('999990000009','Alerta')) f(id,status)
cross join lateral (select period_month from public.admin_analysis_imports
 where dataset_type='alerts' and source_filename ilike 'Databricks%' order by period_month desc limit 1)i;
do $$ declare definition text; response jsonb; item jsonb; section text; filters jsonb; total bigint;
begin
 if (select count(*) from incident_inventory)<>9 then raise exception 'Missing Databricks snapshot fixture';end if;
 definition:=pg_get_functiondef('private.get_databricks_audit_totals(jsonb)'::regprocedure);
 if position('/* exclude-incidencia-from-lifted */' in definition)=0 then raise exception 'Status exclusion is not installed';end if;
 definition:=replace(definition,'private.get_databricks_audit_totals','pg_temp.incident_totals');
 definition:=replace(definition,'public.admin_alert_export_records','pg_temp.incident_inventory');
 execute definition;
 perform set_config('request.jwt.claim.sub',(select id::text from public.profiles where is_active and role::text='commercial' limit 1),true);
 for filters in select value from jsonb_array_elements('[{}, {"country":"Chile"}, {"studies":["Chile"],"region":"TALCA","channel":"HOME MARKET TRADICIONAL"}]') loop
  response:=pg_temp.incident_totals(filters || '{"include_auditors":true,"include_channel_segments":true}'::jsonb);
  foreach section in array array['studies','territories','auditors','channel_segments'] loop
   select coalesce(sum((r->>'databricks_total')::bigint),0) into total from jsonb_array_elements(response->section) r;
   if total<>7 then raise exception 'Expected 7 non-incident IDs in %, filters %, got %',section,filters,total;end if;
  end loop;
 end loop;
 perform set_config('request.jwt.claim.sub','',true);
 begin
  perform pg_temp.incident_totals('{}'::jsonb);
  raise exception 'Anonymous reporting unexpectedly allowed';
 exception when insufficient_privilege then null;
 end;
end $$;
select true as incidence_excluded_from_all_denominators,true as other_statuses_preserved,true as access_control_preserved;
rollback;
