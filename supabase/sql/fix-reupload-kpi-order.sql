-- The same KPI records in a different order still represent the same alert set.
do $$
declare definition text; revised text;
begin
 select pg_get_functiondef('private.activate_upload_batch(bigint,text)'::regprocedure) into definition;
 revised:=replace(definition,$old$fresh.payload->'kpis'=old.payload->'kpis'$old$,
 $new$(select coalesce(jsonb_agg(k order by k::text),'[]'::jsonb) from jsonb_array_elements(coalesce(fresh.payload->'kpis','[]'::jsonb)) k) = (select coalesce(jsonb_agg(k order by k::text),'[]'::jsonb) from jsonb_array_elements(coalesce(old.payload->'kpis','[]'::jsonb)) k)$new$);
 if revised=definition then raise exception 'EXPECTED_KPI_COMPARISON_NOT_FOUND'; end if;
 execute revised;
end $$;
