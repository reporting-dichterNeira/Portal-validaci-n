-- Return the author label only for upload batches the current staff user can
-- already see. This avoids exposing the full profile directory to supervisors.

create or replace function public.get_visible_batch_uploaders(
  p_batch_ids bigint[]
)
returns table (
  batch_id bigint,
  creator_id uuid,
  creator_username text,
  creator_display_name text
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
  v_is_visualizer boolean := (select private.is_standard_visualization_user());
begin
  if v_user_id is null or not (v_is_admin or v_is_supervisor or v_is_visualizer) then
    raise exception 'STAFF_REQUIRED' using errcode = '42501';
  end if;

  if p_batch_ids is null or cardinality(p_batch_ids) = 0 then
    return;
  end if;

  return query
  select
    b.id,
    b.created_by,
    p.username,
    p.display_name
  from public.upload_batches b
  left join public.profiles p on p.id = b.created_by
  where b.id = any(p_batch_ids)
    and b.status in ('active', 'archived')
    and (
      v_is_admin
      or v_is_visualizer
      or (
        v_is_supervisor
        and exists (
          select 1
          from public.supervisor_assignments sa
          where sa.supervisor_id = v_user_id
            and sa.study_id = b.study_id
            and sa.country_id = b.country_id
            and sa.module = b.module
        )
      )
    );
end;
$$;

revoke all on function public.get_visible_batch_uploaders(bigint[]) from public, anon;
grant execute on function public.get_visible_batch_uploaders(bigint[]) to authenticated;
