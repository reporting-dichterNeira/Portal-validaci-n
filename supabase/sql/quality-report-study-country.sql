do $$declare op text;s text;record_type text;begin foreach op in array array['qa','pqr'] loop
record_type:=case when op='qa' then 'private.qa_reviews' else 'private.pqr_active_reviews' end;
select pg_get_functiondef(('private.'||op||'_operation_report()')::regprocedure) into s;
if strpos(s,'study_countries')=0 then
s:=replace(s,'with base as (select r.*','with source as (select r.*');
s:=replace(s,'), totals as (',format($r$), base as (select (jsonb_populate_record(null::%s,to_jsonb(source)||jsonb_build_object('country',case when coalesce(payload->>'pais','') ilike '%%guatemala%%' then 'Guatemala' else coalesce(nullif(nullif(btrim(payload->>'pais'),''),'Alcance interno'),nullif(nullif(btrim(country),''),'Alcance interno'),'Sin país identificado') end))).*,source.analyst_name from source), totals as ($r$,record_type));
s:=replace(s,$n$'studies',(select$n$,$r$'study_countries',(select coalesce(jsonb_agg(x order by x.study,x.country),'[]') from (select study,country,count(*) as completed,count(*) filter(where verdict='errors') as errors from base group by study,country) x),'studies',(select$r$);
execute s;end if;end loop;end;$$;
