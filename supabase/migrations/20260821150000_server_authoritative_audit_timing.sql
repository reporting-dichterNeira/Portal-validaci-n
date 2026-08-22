-- Record all future audit timing with the database clock. This prevents an
-- unsynchronised browser clock from creating a completion before its start.
-- Existing rows are intentionally left untouched.

create or replace function public.save_audit_progress_v2(
  p_audit_id bigint,
  p_status public.audit_status,
  p_validation_results jsonb,
  p_started_at timestamptz default null,
  p_completed_at timestamptz default null,
  p_duration_seconds integer default null,
  p_validation_date date default null
)
returns public.audits
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_validator_id text;
  v_result public.audits%rowtype;
  v_now timestamptz := now();
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select s.validator_id into v_validator_id
  from public.validator_sessions s
  join public.validators v on v.id = s.validator_id
  where s.user_id = v_user_id
    and v.is_active = true;

  if v_validator_id is null then
    raise exception 'VALIDATOR_SESSION_REQUIRED' using errcode = '42501';
  end if;

  update public.audits a
  set status = p_status,
      validation_results = coalesce(p_validation_results, '{}'::jsonb),
      -- Ignore browser-provided timestamps for all new sessions. A legacy
      -- timestamp is retained only if it is not in the future.
      started_at = case
        when a.started_at is null or a.started_at > v_now then v_now
        else a.started_at
      end,
      completed_at = case
        when p_status = 'completada'::public.audit_status then v_now
        else p_completed_at
      end,
      duration_seconds = case
        when p_status = 'completada'::public.audit_status then greatest(
          0,
          round(extract(epoch from (
            v_now - case
              when a.started_at is null or a.started_at > v_now then v_now
              else a.started_at
            end
          )))::integer
        )
        else p_duration_seconds
      end,
      validation_date = coalesce(p_validation_date, a.validation_date)
  where a.id = p_audit_id
    and a.assigned_validator_id = v_validator_id
    and exists (
      select 1
      from public.upload_batches b
      where b.id = a.batch_id
        and b.status = 'active'
    )
  returning a.* into v_result;

  if not found then
    raise exception 'AUDIT_NOT_ASSIGNED' using errcode = '42501';
  end if;

  update public.validator_sessions
  set last_seen_at = v_now
  where user_id = v_user_id;

  return v_result;
end;
$$;

revoke all on function public.save_audit_progress_v2(
  bigint, public.audit_status, jsonb,
  timestamptz, timestamptz, integer, date
) from public, anon;
grant execute on function public.save_audit_progress_v2(
  bigint, public.audit_status, jsonb,
  timestamptz, timestamptz, integer, date
) to authenticated;
