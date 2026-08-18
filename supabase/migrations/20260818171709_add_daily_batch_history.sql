-- Preserve every daily Excel import as an independent batch while keeping the
-- operational portal focused on the latest active batch. Historical reports
-- are aggregated in Postgres so the browser does not download raw JSON rows.

create table public.upload_batches (
  id bigint generated always as identity primary key,
  module public.audit_module not null,
  study_id uuid references public.studies(id) on delete restrict,
  country_id uuid references public.countries(id) on delete restrict,
  operation_date date not null,
  source_filename text not null default '',
  row_count integer not null default 0,
  status text not null default 'draft',
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  activated_at timestamptz,
  archived_at timestamptz,
  constraint upload_batches_filename_length check (length(source_filename) <= 255),
  constraint upload_batches_row_count_nonnegative check (row_count >= 0),
  constraint upload_batches_status_check check (status in ('draft', 'active', 'archived', 'failed'))
);

create index upload_batches_scope_history_idx
  on public.upload_batches (study_id, country_id, operation_date desc, module)
  where status in ('active', 'archived');

create index upload_batches_country_id_idx
  on public.upload_batches (country_id);

create index upload_batches_created_by_idx
  on public.upload_batches (created_by);

create unique index upload_batches_one_active_scope_uidx
  on public.upload_batches (study_id, country_id, module)
  where status = 'active';

alter table public.audits
  add column id bigint generated always as identity,
  add column batch_id bigint references public.upload_batches(id) on delete restrict;

-- Existing rows are grouped into synthetic daily batches. Only the newest
-- batch in each scope/module remains operational; older ones become history.
insert into public.upload_batches (
  module, study_id, country_id, operation_date, source_filename,
  row_count, status, created_by, created_at
)
select
  a.module,
  a.study_id,
  a.country_id,
  coalesce(a.audit_date, a.created_at::date),
  'Migración de datos existentes',
  count(*)::integer,
  'archived',
  null,
  min(a.created_at)
from public.audits a
group by
  a.module,
  a.study_id,
  a.country_id,
  coalesce(a.audit_date, a.created_at::date);

update public.audits a
set batch_id = b.id
from public.upload_batches b
where b.module = a.module
  and b.study_id is not distinct from a.study_id
  and b.country_id is not distinct from a.country_id
  and b.operation_date = coalesce(a.audit_date, a.created_at::date)
  and b.source_filename = 'Migración de datos existentes';

with ranked as (
  select
    id,
    row_number() over (
      partition by module, study_id, country_id
      order by operation_date desc, created_at desc, id desc
    ) as position
  from public.upload_batches
  where source_filename = 'Migración de datos existentes'
)
update public.upload_batches b
set status = case when ranked.position = 1 then 'active' else 'archived' end,
    activated_at = case when ranked.position = 1 then coalesce(b.activated_at, b.created_at) else b.activated_at end,
    archived_at = case when ranked.position = 1 then null else coalesce(b.archived_at, now()) end
from ranked
where b.id = ranked.id;

alter table public.audits
  alter column batch_id set not null,
  drop constraint audits_pkey,
  add constraint audits_pkey primary key (id),
  add constraint audits_batch_external_unique unique (batch_id, external_id);

create index audits_batch_assignee_status_idx
  on public.audits (batch_id, assigned_validator_id, status);

create index audits_validator_history_idx
  on public.audits (assigned_validator_id, audit_date desc, module)
  where assigned_validator_id is not null;

-- Historical ownership must survive staff deactivation or cleanup attempts.
alter table public.audits
  drop constraint audits_assigned_validator_id_fkey,
  add constraint audits_assigned_validator_id_fkey
    foreign key (assigned_validator_id) references public.validators(id) on delete restrict;

create trigger upload_batches_set_updated_at
before update on public.upload_batches
for each row execute function private.set_updated_at();

alter table public.upload_batches enable row level security;

create or replace function private.validator_has_batch(p_batch_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.audits a
      where a.batch_id = p_batch_id
        and a.assigned_validator_id = (select private.current_validator_id())
    );
$$;

revoke all on function private.validator_has_batch(bigint) from public, anon;
grant execute on function private.validator_has_batch(bigint) to authenticated;

create or replace function private.batch_is_active(p_batch_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.upload_batches b
    where b.id = p_batch_id
      and b.status = 'active'
  );
$$;

revoke all on function private.batch_is_active(bigint) from public, anon;
grant execute on function private.batch_is_active(bigint) to authenticated;

create policy upload_batches_select_by_role_and_scope
on public.upload_batches for select to authenticated
using (
  (select private.is_admin())
  or (select private.supervisor_has_scope(study_id, country_id))
  or (
    status = 'active'
    and (select private.validator_has_batch(id))
  )
);

create policy upload_batches_insert_by_scope
on public.upload_batches for insert to authenticated
with check (
  (select private.is_admin())
  or (
    created_by = (select auth.uid())
    and (select private.supervisor_has_scope(study_id, country_id))
  )
);

create policy upload_batches_update_by_scope
on public.upload_batches for update to authenticated
using (
  (select private.is_admin())
  or (select private.supervisor_has_scope(study_id, country_id))
)
with check (
  (select private.is_admin())
  or (select private.supervisor_has_scope(study_id, country_id))
);

-- Operational reads intentionally expose only the active batch. Archived
-- rows are available exclusively through the scoped aggregate RPC below.
drop policy if exists audits_select_by_role_and_scope on public.audits;
create policy audits_select_active_by_role_and_scope
on public.audits for select to authenticated
using (
  (select private.is_admin())
  or (
    (select private.batch_is_active(batch_id))
    and (
      assigned_validator_id = (select private.current_validator_id())
      or (select private.supervisor_has_scope(study_id, country_id))
    )
  )
);

drop policy if exists audits_delete_by_role_and_scope on public.audits;
drop policy if exists validators_delete_by_role_and_scope on public.validators;

revoke all on public.upload_batches from anon, authenticated;
grant select, insert, update on public.upload_batches to authenticated;
grant usage, select on sequence public.upload_batches_id_seq to authenticated;
grant usage, select on sequence public.audits_id_seq to authenticated;
revoke delete on public.audits, public.validators from authenticated;

create or replace function private.current_validator_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.validator_id
  from public.validator_sessions s
  join public.validators v on v.id = s.validator_id
  where s.user_id = (select auth.uid())
    and v.is_active = true;
$$;

create or replace function public.create_upload_batch(
  p_module public.audit_module,
  p_operation_date date,
  p_source_filename text,
  p_row_count integer
)
returns public.upload_batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_study_id uuid;
  v_country_id uuid;
  v_result public.upload_batches%rowtype;
begin
  if v_user_id is null or not (select private.is_supervisor()) then
    raise exception 'SUPERVISOR_REQUIRED' using errcode = '42501';
  end if;

  if p_operation_date is null then
    raise exception 'OPERATION_DATE_REQUIRED' using errcode = '22023';
  end if;

  if p_row_count is null or p_row_count < 1 or p_row_count > 50000 then
    raise exception 'INVALID_ROW_COUNT' using errcode = '22023';
  end if;

  select sa.study_id, sa.country_id
  into v_study_id, v_country_id
  from public.supervisor_assignments sa
  where sa.supervisor_id = v_user_id;

  if v_study_id is null or v_country_id is null then
    raise exception 'SUPERVISOR_SCOPE_REQUIRED' using errcode = '42501';
  end if;

  insert into public.upload_batches (
    module, study_id, country_id, operation_date,
    source_filename, row_count, status, created_by
  ) values (
    p_module, v_study_id, v_country_id, p_operation_date,
    left(coalesce(p_source_filename, ''), 255), p_row_count, 'draft', v_user_id
  )
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.create_upload_batch(
  public.audit_module, date, text, integer
) from public, anon;
grant execute on function public.create_upload_batch(
  public.audit_module, date, text, integer
) to authenticated;

create or replace function public.activate_upload_batch(p_batch_id bigint)
returns public.upload_batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_batch public.upload_batches%rowtype;
  v_actual_count integer;
begin
  if v_user_id is null or not (select private.is_supervisor()) then
    raise exception 'SUPERVISOR_REQUIRED' using errcode = '42501';
  end if;

  select * into v_batch
  from public.upload_batches
  where id = p_batch_id
  for update;

  if not found
    or v_batch.status <> 'draft'
    or v_batch.created_by <> v_user_id
    or not (select private.supervisor_has_scope(v_batch.study_id, v_batch.country_id)) then
    raise exception 'UPLOAD_BATCH_NOT_AVAILABLE' using errcode = '42501';
  end if;

  select count(*)::integer into v_actual_count
  from public.audits
  where batch_id = p_batch_id;

  if v_actual_count < 1 then
    raise exception 'UPLOAD_BATCH_EMPTY' using errcode = '22023';
  end if;

  update public.upload_batches
  set status = 'archived', archived_at = now()
  where module = v_batch.module
    and study_id = v_batch.study_id
    and country_id = v_batch.country_id
    and status = 'active'
    and id <> p_batch_id;

  update public.upload_batches
  set status = 'active',
      row_count = v_actual_count,
      activated_at = now(),
      archived_at = null
  where id = p_batch_id
  returning * into v_batch;

  return v_batch;
end;
$$;

revoke all on function public.activate_upload_batch(bigint) from public, anon;
grant execute on function public.activate_upload_batch(bigint) to authenticated;

create or replace function public.archive_active_batches(p_module public.audit_module)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_study_id uuid;
  v_country_id uuid;
  v_count integer;
begin
  if v_user_id is null or not (select private.is_supervisor()) then
    raise exception 'SUPERVISOR_REQUIRED' using errcode = '42501';
  end if;

  select sa.study_id, sa.country_id
  into v_study_id, v_country_id
  from public.supervisor_assignments sa
  where sa.supervisor_id = v_user_id;

  update public.upload_batches
  set status = 'archived', archived_at = now()
  where module = p_module
    and study_id = v_study_id
    and country_id = v_country_id
    and status = 'active';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.archive_active_batches(public.audit_module) from public, anon;
grant execute on function public.archive_active_batches(public.audit_module) to authenticated;

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

  if p_duration_seconds is not null and p_duration_seconds < 0 then
    raise exception 'INVALID_DURATION' using errcode = '22023';
  end if;

  update public.audits a
  set status = p_status,
      validation_results = coalesce(p_validation_results, '{}'::jsonb),
      started_at = coalesce(p_started_at, a.started_at),
      completed_at = case
        when p_status = 'completada'::public.audit_status then coalesce(p_completed_at, now())
        else p_completed_at
      end,
      duration_seconds = p_duration_seconds,
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
  set last_seen_at = now()
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

-- Keep the original RPC compatible during rollout by targeting only the
-- matching audit in the active batch.
create or replace function public.save_audit_progress(
  p_module public.audit_module,
  p_external_id text,
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
  v_audit_id bigint;
begin
  select a.id into v_audit_id
  from public.audits a
  join public.upload_batches b on b.id = a.batch_id
  where a.module = p_module
    and a.external_id = btrim(p_external_id)
    and a.assigned_validator_id = (select private.current_validator_id())
    and b.status = 'active'
  order by b.operation_date desc, b.id desc
  limit 1;

  if v_audit_id is null then
    raise exception 'AUDIT_NOT_ASSIGNED' using errcode = '42501';
  end if;

  return public.save_audit_progress_v2(
    v_audit_id, p_status, p_validation_results, p_started_at,
    p_completed_at, p_duration_seconds, p_validation_date
  );
end;
$$;

create or replace function public.get_validator_history(
  p_date_from date,
  p_date_to date,
  p_module public.audit_module default null,
  p_validator_id text default null
)
returns table (
  validator_id text,
  validator_code text,
  validator_name text,
  operation_date date,
  module public.audit_module,
  total_audits bigint,
  completed_audits bigint,
  in_progress_audits bigint,
  pending_audits bigint,
  timed_audits bigint,
  total_duration_seconds bigint,
  average_duration_seconds integer,
  first_activity_at timestamptz,
  last_activity_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_is_admin boolean := (select private.is_admin());
  v_is_supervisor boolean := (select private.is_supervisor());
  v_study_id uuid;
  v_country_id uuid;
begin
  if v_user_id is null or not (v_is_admin or v_is_supervisor) then
    raise exception 'STAFF_REQUIRED' using errcode = '42501';
  end if;

  if p_date_from is null or p_date_to is null or p_date_from > p_date_to then
    raise exception 'INVALID_DATE_RANGE' using errcode = '22023';
  end if;

  if p_date_to - p_date_from > 366 then
    raise exception 'DATE_RANGE_TOO_LARGE' using errcode = '22023';
  end if;

  if v_is_supervisor then
    select sa.study_id, sa.country_id
    into v_study_id, v_country_id
    from public.supervisor_assignments sa
    where sa.supervisor_id = v_user_id;
  end if;

  return query
  select
    v.id,
    v.code,
    v.name,
    b.operation_date,
    a.module,
    count(*)::bigint,
    count(*) filter (where a.status = 'completada'::public.audit_status)::bigint,
    count(*) filter (where a.status = 'en_progreso'::public.audit_status)::bigint,
    count(*) filter (where a.status = 'pendiente'::public.audit_status)::bigint,
    count(a.duration_seconds)::bigint,
    coalesce(sum(a.duration_seconds), 0)::bigint,
    coalesce(round(avg(a.duration_seconds) filter (where a.duration_seconds is not null)), 0)::integer,
    min(coalesce(a.started_at, a.created_at)),
    max(coalesce(a.completed_at, a.started_at, a.updated_at))
  from public.audits a
  join public.upload_batches b on b.id = a.batch_id
  join public.validators v on v.id = a.assigned_validator_id
  where b.status in ('active', 'archived')
    and b.operation_date between p_date_from and p_date_to
    and (p_module is null or a.module = p_module)
    and (p_validator_id is null or a.assigned_validator_id = p_validator_id)
    and (
      v_is_admin
      or (a.study_id = v_study_id and a.country_id = v_country_id)
    )
  group by v.id, v.code, v.name, b.operation_date, a.module
  order by b.operation_date desc, v.name, a.module;
end;
$$;

revoke all on function public.get_validator_history(
  date, date, public.audit_module, text
) from public, anon;
grant execute on function public.get_validator_history(
  date, date, public.audit_module, text
) to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'upload_batches'
  ) then
    alter publication supabase_realtime add table public.upload_batches;
  end if;
end;
$$;
