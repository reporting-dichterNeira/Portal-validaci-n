-- Keep enum additions in their own migration/transaction. PostgreSQL does not
-- allow a newly-added enum value to be referenced safely until commit.
alter type public.app_role add value if not exists 'admin';
