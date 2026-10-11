-- Read-only verification, no record identifiers or payloads exposed.
select
 (select count(*) from public.audits) as current_audits,
 (select count(*) from private.demo_rollout_audits_backup) as backed_up_audits,
 (select count(*) from private.demo_rollout_batches_backup) as backed_up_batches,
 (select count(*) from public.pending_audit_decisions) as supervisor_decisions,
 not exists(select 1 from pg_trigger where tgname='upload_batches_prune_expired_pending') as automatic_delete_disabled,
 (select relrowsecurity from pg_class where oid='public.pending_audit_decisions'::regclass) as history_rls,
 not has_table_privilege('anon','public.pending_audit_decisions','select') as no_anon_history,
 not has_function_privilege('anon','public.resolve_previous_pending(bigint[],text,text,text)','execute') as no_anon_mutation,
 not has_function_privilege('anon','public.get_pending_management(uuid,public.audit_module)','execute') as no_anon_pending_read,
 has_function_privilege('authenticated','public.resolve_previous_pending(bigint[],text,text,text)','execute') as signed_in_rpc_available,
 position('pending_resolution' in pg_get_functiondef('public.save_audit_progress_v2(bigint,public.audit_status,jsonb,timestamp with time zone,timestamp with time zone,integer,date)'::regprocedure))>0 as stale_validator_guard,
 position('subchannel' in pg_get_functiondef('public.finish_admin_databricks_sync(uuid,integer)'::regprocedure))>0 as dimension_publisher;
