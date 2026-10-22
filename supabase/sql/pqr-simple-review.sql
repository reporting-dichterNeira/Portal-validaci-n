-- Apply after pqr-operation.sql and pqr-study-distribution.sql.
-- Existing permissions, assignment checks, version checks and source audits stay intact.
begin;
set local lock_timeout='5s';
alter table private.pqr_reviews add column if not exists excluded_at timestamptz;
alter table private.pqr_reviews add column if not exists exclusion_reason text;
-- Recoverable exclusions remain in the source table, including their events.
-- No caller receives direct access to this updatable, invoker-security view.
create or replace view private.pqr_active_reviews with (security_invoker=true) as
 select * from private.pqr_reviews where excluded_at is null with local check option;
revoke all on private.pqr_active_reviews from public,anon,authenticated,service_role;
do $patch$
declare body text; previous text;
 old_rule text:=$rule$if v_result->>'evaluation'='incorrect' and (coalesce(v_result->>'correct_decision','') not in ('aplica','no_aplica') or length(btrim(coalesce(v_result->>'comment','')))<3) then raise exception 'Indica la respuesta correcta y explica el error en cada alerta incorrecta.';end if;$rule$;
 new_rule text:=$rule$if coalesce(v_result->>'correct_decision','')<>'' and v_result->>'correct_decision' not in ('aplica','no_aplica') then raise exception 'INVALID_CORRECT_DECISION';end if;$rule$;
begin
 body:=pg_get_functiondef('private.pqr_api(text,jsonb)'::regprocedure);
 if position(old_rule in body)=0 and position(new_rule in body)=0 then raise exception 'PQR save rules changed; inspect before applying';end if;
 if position('REVIEW_NOT_ASSIGNED' in body)=0 or position('40001' in body)=0 then raise exception 'Missing assignment or version guard';end if;
 body:=replace(body,old_rule,new_rule);
 -- All reads, counts and writes use active rows, including detail/start/save.
 -- No public endpoint for excluding or restoring a review is added.
 body:=replace(body,'private.pqr_reviews','private.pqr_active_reviews');
 execute body;
 body:=pg_get_functiondef('private.pqr_refresh_day(date)'::regprocedure);
 previous:='select count(*) into v_selected from private.pqr_reviews where day=v_day and study=v_scope.study;';
 if position(previous in body)>0 then
  body:=replace(body,previous,'select count(*) into v_selected from private.pqr_reviews where day=v_day and study=v_scope.study and excluded_at is null;');
 elsif position('study=v_scope.study and excluded_at is null' in body)=0 then raise exception 'PQR sampling counter changed';end if;
 previous:=$rule$where r.day=v_day and r.status='pending' and r.started_at is null and r.review_results='{}'::jsonb$rule$;
 if position(previous in body)>0 then body:=replace(body,previous,$rule$where r.day=v_day and r.excluded_at is null and r.status='pending' and r.started_at is null and r.review_results='{}'::jsonb$rule$);
 elsif position('r.day=v_day and r.excluded_at is null' in body)=0 then raise exception 'PQR assignment filter changed';end if;
 -- The existing duplicate check deliberately still scans ALL reviews:
 -- an excluded source/day can never be selected again by cron or refresh.
 if position('not exists(select 1 from private.pqr_reviews r where r.day=v_day and r.source_key=c.source_key)' in body)=0 then raise exception 'Missing source/day deduplication';end if;
 execute body;
end;$patch$;
notify pgrst,'reload schema';
commit;
