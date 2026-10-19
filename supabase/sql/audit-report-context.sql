begin;
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
   select distinct r.audit_external_id,r.study,r.country,r.region,r.channel,r.subchannel,r.segmento,r.auditor,r.audit_date,r.pdv_id
   from authorized a join public.admin_alert_export_records r on r.audit_external_id=a.external_id
   join public.admin_analysis_imports i on i.dataset_type='alerts' and i.period_month=r.period_month
   -- Final imports include historical Databricks exports uploaded as Excel.
   -- The filename is a display label, not an eligibility or authorization rule.
   -- Staged, unpublished synchronization rows are not in this table.
   where private.report_context_study(r.study)=a.study
 ) select coalesce(jsonb_agg(to_jsonb(m)),'[]'::jsonb) into result from matched m;
 return result;
end; $$;
create or replace function public.get_audit_report_context(p_audits jsonb)
returns jsonb language sql stable security invoker set search_path='' as $$
 select private.get_audit_report_context(p_audits);
$$;
revoke all on function private.get_audit_report_context(jsonb),public.get_audit_report_context(jsonb) from public,anon;
grant execute on function private.get_audit_report_context(jsonb),public.get_audit_report_context(jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
