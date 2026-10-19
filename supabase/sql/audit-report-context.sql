begin;
-- Metadata is refreshed independently of immutable monthly volume snapshots.
-- This includes audits arriving late into an old Ola, by ID + study only.
create table if not exists private.audit_report_context_cache (
 audit_external_id text not null check(audit_external_id ~ '^[0-9]+$'),
 study text not null check(study in ('Chile','Lindley','Moderno','Tradicional')),
 metadata jsonb not null check(jsonb_typeof(metadata)='object'),
 verified_at timestamptz not null default now(),
 primary key(audit_external_id,study)
);
alter table private.audit_report_context_cache enable row level security;
revoke all on private.audit_report_context_cache from public,anon,authenticated;
-- Narrow reporting lookup. This does not grant access to the raw export table.
create index if not exists audits_report_context_identity_idx
on public.audits(external_id,study) include(study_id,country_id,module);

create or replace function private.report_context_study(value text)
returns text language sql immutable set search_path='' as $$
 select case
 when lower(value) ~ 'ko[ _]trad[ _]ch([ _]|$)|chile|embonor' then 'Chile'
 when lower(value) like '%lindley%' then 'Lindley'
 when lower(value) like '%moderno%' then 'Moderno'
 when lower(value) like '%trad%' then 'Tradicional' end;
$$;
revoke all on function private.report_context_study(text) from public,anon,authenticated;

create or replace function private.get_audit_report_context(p_audits jsonb)
returns jsonb language plpgsql stable security definer set search_path='' set jit=off as $$
declare caller_role text; result jsonb;
begin
 select p.role::text into caller_role from public.profiles p where p.id=auth.uid() and p.is_active;
 if auth.uid() is null or caller_role is null or caller_role not in ('admin','supervisor','visualizer','commercial') then
   raise exception 'VISUALIZATION_ACCESS_REQUIRED' using errcode='42501';
 end if;
 if jsonb_typeof(p_audits) is distinct from 'array' or jsonb_array_length(p_audits)>500 then
   raise exception 'At most 500 audit identities are allowed' using errcode='22023';
 end if;
 with requested as materialized (
   select distinct regexp_replace(q.id,'^0+(?=[0-9])','') as id,private.report_context_study(q.study) as study
   from jsonb_to_recordset(p_audits)q(id text,study text) where q.id ~ '^[0-9]+$' and length(q.id)<=64
 ), authorized as materialized (
   select distinct a.external_id,a.study from requested q join public.audits a
   on a.external_id=q.id and a.study=q.study
   where caller_role<>'supervisor' or exists(select 1 from public.supervisor_assignments sa
     where sa.supervisor_id=auth.uid() and sa.study_id=a.study_id and sa.country_id=a.country_id and sa.module=a.module)
 ), matched as (
   select c.metadata || jsonb_build_object('audit_external_id',c.audit_external_id,'study',c.study) as record
   from authorized a join private.audit_report_context_cache c
   on c.audit_external_id=a.external_id and c.study=a.study
   union all
   select distinct jsonb_build_object('audit_external_id',r.audit_external_id,'study',r.study,
     'country',r.country,'region',r.region,'channel',r.channel,'subchannel',r.subchannel,
     'segmento',r.segmento,'auditor',r.auditor,'audit_date',r.audit_date,'pdv_id',r.pdv_id)
   from authorized a join public.admin_alert_export_records r on r.audit_external_id=a.external_id
   join public.admin_analysis_imports i on i.dataset_type='alerts' and i.period_month=r.period_month
   -- Final imports include historical Databricks exports uploaded as Excel.
   -- The filename is a display label, not an eligibility or authorization rule.
   -- Staged, unpublished synchronization rows are not in this table.
   where private.report_context_study(r.study)=a.study
   and not exists(select 1 from private.audit_report_context_cache c
     where c.audit_external_id=a.external_id and c.study=a.study)
 ) select coalesce(jsonb_agg(record),'[]'::jsonb) into result from matched;
 return result;
end; $$;
create or replace function public.get_audit_report_context(p_audits jsonb)
returns jsonb language sql stable security invoker set search_path='' as $$
 select private.get_audit_report_context(p_audits);
$$;
revoke all on function private.get_audit_report_context(jsonb),public.get_audit_report_context(jsonb) from public,anon;
grant execute on function private.get_audit_report_context(jsonb),public.get_audit_report_context(jsonb) to authenticated;

-- The existing trusted Databricks integration can refresh metadata, without
-- granting portal users table access or permission to publish old snapshots.
create or replace function private.report_context_sync_ids(p_after text,p_limit integer)
returns jsonb language sql stable security definer set search_path='' set jit=off as $$
 with export_studies as materialized (
  select study,private.report_context_study(study) as canonical_study
  from (select distinct study from public.admin_alert_export_records) labels
 )
 select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) from (
  select distinct a.external_id as id,a.study,a.study||':'||a.external_id as cursor
  from (select external_id,study from public.audits
    where coalesce(payload->'meta'->>'Estudio','') !~* '(^|[^a-z0-9])dsd([^a-z0-9]|$)'
    union all select r.audit_external_id,s.canonical_study from public.admin_alert_export_records r
      join export_studies s on s.study=r.study) a
  where a.external_id ~ '^[0-9]+$'
  and a.study in ('Chile','Lindley','Moderno','Tradicional')
  and a.study||':'||a.external_id>coalesce(p_after,'')
  order by cursor limit greatest(1,least(coalesce(p_limit,500),1000))
 )q;
$$;
create or replace function public.report_context_sync_ids(p_after text default '',p_limit integer default 500)
returns jsonb language sql stable security invoker set search_path='' as $$
 select private.report_context_sync_ids(p_after,p_limit);
$$;
create or replace function private.ingest_report_context(p_rows jsonb)
returns integer language plpgsql security definer set search_path='' set jit=off as $$
declare r jsonb; identity text; canonical_study text; values_json jsonb; written integer:=0;
begin
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>250 then
  raise exception 'At most 250 metadata rows are allowed' using errcode='22023';
 end if;
 for r in select value from jsonb_array_elements(p_rows) loop
  identity:=r->>'audit_external_id'; canonical_study:=r->>'study';
  if identity is null or identity !~ '^[0-9]{1,64}$' or canonical_study is null
   or not (exists(select 1 from public.audits a where a.external_id=identity and a.study=canonical_study)
     or exists(select 1 from public.admin_alert_export_records a where a.audit_external_id=identity
       and private.report_context_study(a.study)=canonical_study)) then
   raise exception 'Unknown audit identity' using errcode='22023';
  end if;
  if coalesce((r->>'source_rows')::integer,0)<1 then continue;end if;
  select coalesce(jsonb_object_agg(e.key,e.value),'{}'::jsonb) into values_json
  from jsonb_each(r)e where e.key=any(array['country','region','channel','subchannel','segmento','auditor','audit_date','pdv_id',
    'country_ambiguous','region_ambiguous','channel_ambiguous','subchannel_ambiguous','segmento_ambiguous','auditor_ambiguous','audit_date_ambiguous','pdv_id_ambiguous']);
  if exists(select 1 from jsonb_each(values_json)e where length(e.value::text)>1100
    or jsonb_typeof(e.value) not in ('string','boolean','null')) then
   raise exception 'Invalid reporting metadata' using errcode='22023';
  end if;
  insert into private.audit_report_context_cache(audit_external_id,study,metadata,verified_at)
  values(identity,canonical_study,values_json||jsonb_build_object('source','storeview.slv_sv_ceres_ag_export'),now())
  on conflict(audit_external_id,study) do update set metadata=excluded.metadata,verified_at=excluded.verified_at;
  written:=written+1;
 end loop;
 return written;
end; $$;
create or replace function public.ingest_report_context(p_rows jsonb)
returns integer language sql security invoker set search_path='' as $$
 select private.ingest_report_context(p_rows);
$$;
revoke all on function private.report_context_sync_ids(text,integer),public.report_context_sync_ids(text,integer),
 private.ingest_report_context(jsonb),public.ingest_report_context(jsonb) from public,anon,authenticated;
grant execute on function private.report_context_sync_ids(text,integer),public.report_context_sync_ids(text,integer),
 private.ingest_report_context(jsonb),public.ingest_report_context(jsonb) to service_role;
grant usage on schema private to service_role;
notify pgrst,'reload schema';
commit;
