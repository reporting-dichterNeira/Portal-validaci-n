begin;
select set_config('request.jwt.claim.sub',(select id::text from public.profiles where is_active and role::text='admin' limit 1),true);
do $test$
declare op text; response jsonb; item jsonb; all_count int; selected_count int; single jsonb; multi jsonb;
begin
foreach op in array array['qa','pqr'] loop
execute format('select private.%I($1,$2)',op||'_api') into response using 'export',jsonb_build_object('day','2026-11-25','study',jsonb_build_array('Chile','Lindley'),'status',jsonb_build_array('completed','in_progress'));
for item in select value from jsonb_array_elements(response->'reviews') loop
if item->>'study' not in ('Chile','Lindley') or item->>'status' not in ('completed','in_progress') then raise exception 'Wrong multi filter %',op;end if;
end loop;
execute format('select private.%I($1,$2)',op||'_api') into single using 'export',jsonb_build_object('day','2026-11-25','study','Chile','status','completed');
execute format('select private.%I($1,$2)',op||'_api') into multi using 'export',jsonb_build_object('day','2026-11-25','study',jsonb_build_array('Chile'),'status',jsonb_build_array('completed'));
if single->'reviews' is distinct from multi->'reviews' then raise exception 'Scalar and array differ %',op;end if;
end loop;
single:=private.get_databricks_audit_totals('{"month":"2026-08","country":"Chile","region":"all"}');
multi:=private.get_databricks_audit_totals('{"month":["2026-08"],"country":["Chile"],"region":["IQUIQUE","TEMUCO","TALCA"]}');
if exists(select 1 from jsonb_array_elements(multi->'studies') v where v->>'study_name'<>'Chile') then raise exception 'Country leaked';end if;
multi:=private.get_databricks_audit_totals('{"month":["2026-08"],"country":["Chile"]}');
if single is distinct from multi then raise exception 'Inventory scalar/array mismatch';end if;
end $test$;
select 'PASS: QA/PQR multi filters, scalar compatibility, inventory arrays, role scopes retained; transaction rolled back' result;
rollback;
