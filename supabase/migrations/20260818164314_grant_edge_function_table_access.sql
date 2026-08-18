-- New projects no longer expose new tables to Data API roles automatically.
-- The server-only Edge Function still needs explicit SQL privileges; the
-- service_role key remains confined to the deployed function environment.
grant select, insert, update, delete
  on public.profiles, public.supervisor_assignments
  to service_role;

grant select
  on public.countries, public.studies
  to service_role;
