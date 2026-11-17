-- Restoring a completed historical decision must not depend on today's roster.
do $$
declare definition text; revised text;
begin
 select pg_get_functiondef('private.enforce_smart_audit_country()'::regprocedure) into definition;
 revised:=replace(definition,$old$and (changed_assignment or new.status<>'completada')$old$,$new$and new.status<>'completada'$new$);
 if revised=definition then raise exception 'EXPECTED_COUNTRY_GUARD_NOT_FOUND'; end if;
 execute revised;
end $$;
