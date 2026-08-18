-- A supervisor has one assigned scope, but several supervisors may collaborate
-- on the same study/country pair.
alter table public.supervisor_assignments
  drop constraint if exists supervisor_assignments_scope_owner;
