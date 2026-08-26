-- Global historical lookup used by the PDV / audit search.  It intentionally
-- ignores a supervisor's active scope, but only staff with operational or
-- visualization access may invoke it.

create or replace function public.search_global_audit_history(
  p_query text,
  p_limit integer default 50
)
returns table (
  id bigint,
  batch_id bigint,
  module public.audit_module,
  external_id text,
  study text,
  study_id uuid,
  country_id uuid,
  assigned_validator_id text,
  status public.audit_status,
  audit_date date,
  validation_date date,
  payload jsonb,
  validation_results jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  duration_seconds integer,
  created_at timestamptz,
  updated_at timestamptz,
  batch_operation_date date,
  batch_status text,
  batch_source_filename text,
  validator_code text,
  validator_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if (select auth.uid()) is null or not exists (
    select 1
    from public.profiles profile
    where profile.id = (select auth.uid())
      and profile.is_active = true
      and profile.role in ('admin'::public.app_role, 'supervisor'::public.app_role, 'visualizer'::public.app_role)
  ) then
    raise exception 'GLOBAL_LOOKUP_NOT_ALLOWED' using errcode = '42501';
  end if;

  if v_query = '' or length(v_query) > 200 then
    raise exception 'INVALID_SEARCH_QUERY' using errcode = '22023';
  end if;

  return query
  select
    audit.id,
    audit.batch_id,
    audit.module,
    audit.external_id,
    audit.study,
    audit.study_id,
    audit.country_id,
    audit.assigned_validator_id,
    audit.status,
    audit.audit_date,
    audit.validation_date,
    audit.payload,
    audit.validation_results,
    audit.started_at,
    audit.completed_at,
    audit.duration_seconds,
    audit.created_at,
    audit.updated_at,
    batch.operation_date,
    batch.status,
    batch.source_filename,
    validator.code,
    validator.name
  from public.audits audit
  join public.upload_batches batch on batch.id = audit.batch_id
  left join public.validators validator on validator.id = audit.assigned_validator_id
  where batch.status in ('active', 'archived')
    and (
      lower(audit.external_id) = v_query
      or lower(coalesce(audit.payload ->> 'idPDV', '')) = v_query
    )
  order by batch.operation_date desc, audit.id desc
  limit v_limit;
end;
$$;

revoke all on function public.search_global_audit_history(text, integer) from public, anon, authenticated;
grant execute on function public.search_global_audit_history(text, integer) to authenticated;
