-- Keep enum additions isolated: PostgreSQL does not allow a newly-added enum
-- value to be safely used until the transaction that adds it has committed.
alter type public.app_role add value if not exists 'visualizer';
alter type public.app_role add value if not exists 'commercial';
