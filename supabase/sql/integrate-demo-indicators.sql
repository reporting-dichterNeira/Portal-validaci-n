-- Additive rollout. No hard deletion. Current code backup: e14d37b.
begin;
-- Protected, exact pre-change snapshots. Never exposed through the Data API.
create table if not exists private.demo_rollout_audits_backup as table public.audits;
create table if not exists private.demo_rollout_batches_backup as table public.upload_batches;
create table if not exists private.demo_rollout_functions_backup as
select p.oid::regprocedure::text as signature, pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('public','private') and p.proname in
('activate_upload_batch','save_audit_progress_v2','prune_pending_when_new_batch_activates');
alter table private.demo_rollout_audits_backup enable row level security;
alter table private.demo_rollout_batches_backup enable row level security;
alter table private.demo_rollout_functions_backup enable row level security;
revoke all on private.demo_rollout_audits_backup, private.demo_rollout_batches_backup,
private.demo_rollout_functions_backup from public,anon,authenticated;

alter table public.audits add column if not exists pending_resolution text,
 add column if not exists original_operation_date date,
 add column if not exists original_source_filename text,
 add column if not exists original_uploaded_at timestamptz;
alter table public.admin_alert_export_records add column if not exists region text,
 add column if not exists subchannel text;

create table if not exists public.pending_audit_decisions (
 id bigint generated always as identity primary key,
 audit_id bigint not null, study_id uuid not null, country_id uuid not null,
 module public.audit_module not null, action text not null check(action in ('remove','assign','replace')),
 reason text not null, decided_by uuid not null, decided_at timestamptz not null default now(),
 previous_record jsonb not null, target_validator_id text
);
alter table public.pending_audit_decisions enable row level security;
revoke all on public.pending_audit_decisions from public,anon,authenticated;
grant select on public.pending_audit_decisions to authenticated;
drop policy if exists pending_decisions_supervisor_scope on public.pending_audit_decisions;
create policy pending_decisions_supervisor_scope on public.pending_audit_decisions
for select to authenticated using (private.is_supervisor() and
 private.supervisor_has_audit_scope(study_id,country_id,module));
create index if not exists pending_decisions_scope_idx on public.pending_audit_decisions(study_id,country_id,module,decided_at desc);
create index if not exists audits_unique_identity_pending_idx on public.audits(study_id,country_id,module,external_id,batch_id desc);

-- Disable physical automatic cleanup. Keep the prior trigger/function in backup.
drop trigger if exists upload_batches_prune_expired_pending on public.upload_batches;

create or replace function private.activate_upload_batch(p_batch_id bigint,p_carryover_action text default 'discard')
returns public.upload_batches language plpgsql security definer set search_path='' as $$
declare b public.upload_batches%rowtype; prior_row record; actual_count integer;
begin
 if auth.uid() is null or not private.is_supervisor() then raise exception 'SUPERVISOR_REQUIRED' using errcode='42501'; end if;
 select * into b from public.upload_batches where id=p_batch_id;
 if not found or b.status<>'draft' or b.created_by<>auth.uid() or
 not private.supervisor_has_audit_scope(b.study_id,b.country_id,b.module) then raise exception 'UPLOAD_BATCH_NOT_AVAILABLE' using errcode='42501'; end if;
 -- Serialize activation and supervisor decisions within the same scope.
 perform pg_advisory_xact_lock(hashtextextended(b.study_id::text||b.country_id::text||b.module::text,0));
 select * into b from public.upload_batches where id=p_batch_id for update;
 if b.status<>'draft' then raise exception 'UPLOAD_BATCH_NOT_AVAILABLE'; end if;
 select count(*)::integer into actual_count from public.audits where batch_id=p_batch_id;
 if actual_count<1 then raise exception 'UPLOAD_BATCH_EMPTY'; end if;
 -- Preserve decisions only for the latest accepted, identical KPI payload.
 -- A genuinely corrected KPI payload requires review; it never inherits an older result.
 update public.audits fresh set status=old.status,validation_results=old.validation_results,
 assigned_validator_id=case when old.status='completada' then old.assigned_validator_id else fresh.assigned_validator_id end,
 completed_at=old.completed_at,started_at=old.started_at,duration_seconds=old.duration_seconds,validation_date=old.validation_date,
 original_operation_date=coalesce(old.original_operation_date,old.prior_operation_date),
 original_source_filename=coalesce(old.original_source_filename,old.prior_source_filename),
 original_uploaded_at=coalesce(old.original_uploaded_at,old.prior_uploaded_at)
 from (select distinct on (external_id) a.*,ob.operation_date as prior_operation_date,
 ob.source_filename as prior_source_filename,ob.created_at as prior_uploaded_at
 from public.audits a join public.upload_batches ob on ob.id=a.batch_id
 where a.study_id=b.study_id and a.country_id=b.country_id and a.module=b.module
 and coalesce(a.pending_resolution,'') not in ('removed','replaced')
 and ob.status in ('active','archived') order by external_id,a.batch_id desc,a.id desc) old
 where fresh.batch_id=p_batch_id and fresh.external_id=old.external_id and fresh.payload->'kpis'=old.payload->'kpis';
 -- A corrected/repeated base supersedes duplicate unfinished IDs, reversibly.
 for prior_row in select old.* from public.audits old join public.upload_batches ob on ob.id=old.batch_id
 where old.study_id=b.study_id and old.country_id=b.country_id and old.module=b.module
 and old.batch_id<>p_batch_id and ob.status in ('active','archived')
 and old.status<>'completada' and coalesce(old.pending_resolution,'') not in ('removed','replaced')
 and ((old.original_operation_date is null and ob.operation_date=b.operation_date)
 or exists(select 1 from public.audits fresh where fresh.batch_id=p_batch_id and fresh.external_id=old.external_id))
 order by old.id for update of old loop
  insert into public.pending_audit_decisions(audit_id,study_id,country_id,module,action,reason,decided_by,previous_record)
  values(prior_row.id,prior_row.study_id,prior_row.country_id,prior_row.module,'replace','Base de la jornada o ID reemplazado por una nueva versión',auth.uid(),to_jsonb(prior_row));
  update public.audits set pending_resolution='replaced',assigned_validator_id=null where id=prior_row.id;
 end loop;
 update public.upload_batches set status='archived',archived_at=now()
 where study_id=b.study_id and country_id=b.country_id and module=b.module and status='active' and id<>p_batch_id;
 update public.upload_batches set status='active',row_count=actual_count,activated_at=now(),archived_at=null,
 carried_over_count=0,carryover_summary='[]',pending_disposition='not_applicable',discarded_pending_count=0
 where id=p_batch_id returning * into b;
 return b;
end; $$;
create or replace function public.activate_upload_batch(p_batch_id bigint,p_carryover_action text default 'discard')
returns public.upload_batches language sql security invoker set search_path='' as $$
 select private.activate_upload_batch(p_batch_id,p_carryover_action);
$$;
revoke all on function private.activate_upload_batch(bigint,text),public.activate_upload_batch(bigint,text) from public,anon;
grant execute on function private.activate_upload_batch(bigint,text),public.activate_upload_batch(bigint,text) to authenticated;

-- Read-only management list: only the signed-in supervisor's selected scope.
create or replace function public.get_pending_management(p_study_id uuid,p_module public.audit_module)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare scope_country uuid; result jsonb;
begin
 if auth.uid() is null or not private.is_supervisor() then raise exception 'SUPERVISOR_REQUIRED' using errcode='42501'; end if;
 select country_id into scope_country from public.supervisor_assignments where supervisor_id=auth.uid() and study_id=p_study_id and module=p_module limit 1;
 if scope_country is null then raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode='42501'; end if;
 select jsonb_build_object('audits',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object(
 'operation_date',coalesce(a.original_operation_date,b.operation_date),'source_filename',coalesce(a.original_source_filename,b.source_filename),'validator_name',coalesce(v.name,'Sin asignar')) order by b.operation_date desc,a.id)
 from public.audits a join public.upload_batches b on b.id=a.batch_id left join public.validators v on v.id=a.assigned_validator_id
 where a.study_id=p_study_id and a.country_id=scope_country and a.module=p_module and b.status in ('active','archived')
 and coalesce(a.original_operation_date,b.operation_date)<(now() at time zone 'America/Managua')::date
 and a.status<>'completada' and coalesce(a.pending_resolution,'') not in ('removed','replaced')
 and (a.original_operation_date is not null or not exists(select 1 from public.upload_batches latest
 where latest.study_id=a.study_id and latest.country_id=a.country_id and latest.module=a.module
 and latest.operation_date=b.operation_date and latest.status in ('active','archived') and latest.id>b.id))
 and not exists(select 1 from public.audits newer join public.upload_batches nb on nb.id=newer.batch_id
 where newer.study_id=a.study_id and newer.country_id=a.country_id and newer.module=a.module and newer.external_id=a.external_id
 and nb.status in ('active','archived') and newer.batch_id>a.batch_id)), '[]'::jsonb),
 'history',coalesce((select jsonb_agg(to_jsonb(d)) from (select id,audit_id,action,reason,decided_at,target_validator_id
 from public.pending_audit_decisions where study_id=p_study_id and country_id=scope_country and module=p_module
 order by decided_at desc,id desc limit 100) d),'[]'::jsonb)) into result;
 return result;
end; $$;
revoke all on function public.get_pending_management(uuid,public.audit_module) from public,anon;
grant execute on function public.get_pending_management(uuid,public.audit_module) to authenticated;

create or replace function private.resolve_previous_pending(p_ids bigint[],p_action text,p_reason text,p_target text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.audits%rowtype; old_batch public.upload_batches%rowtype; target_batch bigint;
 scope_study uuid; scope_country uuid; scope_module public.audit_module; total integer:=0; membership public.validator_study_memberships%rowtype;
begin
 if auth.uid() is null or not private.is_supervisor() then raise exception 'SUPERVISOR_REQUIRED' using errcode='42501'; end if;
 if p_action is null or p_ids is null or p_action not in ('remove','assign') or length(btrim(coalesce(p_reason,'')))<3 or cardinality(p_ids) not between 1 and 2000
 or cardinality(p_ids)<>(select count(distinct x) from unnest(p_ids) x) then raise exception 'INVALID_PENDING_DECISION'; end if;
 select study_id,country_id,module into scope_study,scope_country,scope_module from public.audits where id=p_ids[1];
 if scope_study is null or not private.supervisor_has_audit_scope(scope_study,scope_country,scope_module) then raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(scope_study::text||scope_country::text||scope_module::text,0));
 if p_action='assign' then
  select m.* into membership from public.validator_study_memberships m join public.validators v on v.id=m.validator_id
  where m.validator_id=p_target and m.study_id=scope_study and m.country_id=scope_country and m.is_active and m.removed_at is null and v.is_active;
  if not found then raise exception 'TARGET_VALIDATOR_NOT_ACTIVE_OR_OUT_OF_SCOPE'; end if;
  select id into target_batch from public.upload_batches where study_id=scope_study and country_id=scope_country and module=scope_module and status='active' for update;
  if target_batch is null then raise exception 'ACTIVE_BATCH_NOT_FOUND'; end if;
 end if;
 for a in select * from public.audits where id=any(p_ids) order by id for update loop
  select * into old_batch from public.upload_batches where id=a.batch_id for update;
  if a.study_id<>scope_study or a.country_id<>scope_country or a.module<>scope_module or a.status='completada'
  or coalesce(a.pending_resolution,'') in ('removed','replaced') or old_batch.status not in ('active','archived')
  or coalesce(a.original_operation_date,old_batch.operation_date)>=(now() at time zone 'America/Managua')::date then raise exception 'PENDING_SELECTION_CHANGED'; end if;
  if exists(select 1 from public.audits other join public.upload_batches ob on ob.id=other.batch_id where other.study_id=a.study_id
   and other.country_id=a.country_id and other.module=a.module and other.external_id=a.external_id and other.id<>a.id
   and ob.status in ('active','archived') and other.batch_id>a.batch_id) then raise exception 'AUDIT_HAS_NEWER_VERSION'; end if;
  if a.original_operation_date is null and exists(select 1 from public.upload_batches latest where latest.study_id=a.study_id
   and latest.country_id=a.country_id and latest.module=a.module and latest.operation_date=old_batch.operation_date
   and latest.status in ('active','archived') and latest.id>old_batch.id) then raise exception 'AUDIT_HAS_NEWER_BASE'; end if;
  if p_action='assign' and scope_module='smart' and a.study in ('Tradicional','Moderno')
  and cardinality(membership.smart_countries)>0 and not exists(select 1 from unnest(membership.smart_countries) c
   where private.audit_country_key(c)=private.audit_country_key(coalesce(a.payload->>'pais',''))) then raise exception 'TARGET_COUNTRY_NOT_ALLOWED'; end if;
  insert into public.pending_audit_decisions(audit_id,study_id,country_id,module,action,reason,decided_by,previous_record,target_validator_id)
  values(a.id,a.study_id,a.country_id,a.module,p_action,btrim(p_reason),auth.uid(),to_jsonb(a),case when p_action='assign' then p_target end);
  if p_action='remove' then
   update public.audits set pending_resolution='removed',assigned_validator_id=null where id=a.id;
  else
   update public.audits set pending_resolution='reassigned',assigned_validator_id=p_target,batch_id=target_batch,
   original_operation_date=coalesce(original_operation_date,old_batch.operation_date),
   original_source_filename=coalesce(original_source_filename,old_batch.source_filename),
   original_uploaded_at=coalesce(original_uploaded_at,old_batch.created_at),started_at=null,completed_at=null,duration_seconds=null
   where id=a.id;
  end if;
  update public.upload_batches b set row_count=(select count(*) from public.audits x where x.batch_id=b.id
  and coalesce(x.pending_resolution,'') not in ('removed','replaced')) where b.id in (a.batch_id,target_batch);
  total:=total+1;
 end loop;
 if total<>cardinality(p_ids) then raise exception 'PENDING_SELECTION_CHANGED'; end if;
 return jsonb_build_object('changed',total,'action',p_action);
end; $$;
create or replace function public.resolve_previous_pending(p_ids bigint[],p_action text,p_reason text,p_target text default null)
returns jsonb language sql security invoker set search_path='' as $$
 select private.resolve_previous_pending(p_ids,p_action,p_reason,p_target);
$$;
revoke all on function private.resolve_previous_pending(bigint[],text,text,text), public.resolve_previous_pending(bigint[],text,text,text) from public,anon;
grant execute on function private.resolve_previous_pending(bigint[],text,text,text), public.resolve_previous_pending(bigint[],text,text,text) to authenticated;
-- A stale validator tab cannot save a retired audit.
do $$ declare definition text; begin
 select pg_get_functiondef('public.save_audit_progress_v2(bigint,public.audit_status,jsonb,timestamp with time zone,timestamp with time zone,integer,date)'::regprocedure) into definition;
 if position('pending_resolution' in definition)=0 then
  definition:=replace(definition,'where a.id = p_audit_id','where a.id = p_audit_id and coalesce(a.pending_resolution,'''') not in (''removed'',''replaced'')');
  execute definition;
 end if;
end; $$;
notify pgrst,'reload schema';
commit;
select (select count(*) from private.demo_rollout_audits_backup) as backed_up_audits,
 (select count(*) from private.demo_rollout_batches_backup) as backed_up_batches,
 not exists(select 1 from pg_trigger where tgname='upload_batches_prune_expired_pending') as automatic_delete_disabled;
