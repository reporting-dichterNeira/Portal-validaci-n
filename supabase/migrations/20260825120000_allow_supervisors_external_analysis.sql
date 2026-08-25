-- Operations users include supervisors and dedicated operational visualizers.
-- Commercial users remain excluded from exports and edit-analysis data.
create or replace function private.is_analysis_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.profiles p
      where p.id = (select auth.uid())
        and p.is_active = true
        and p.role in (
          'admin'::public.app_role,
          'supervisor'::public.app_role,
          'visualizer'::public.app_role
        )
    );
$$;

revoke all on function private.is_analysis_user() from public, anon;
grant execute on function private.is_analysis_user() to authenticated;
