-- One-time enrichment from the verified Databricks ID/study staging table.
-- Country/region only. Does not reopen monthly snapshots or change validation,
-- operational country restrictions, assignments, dates, decisions or counts.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
alter table public.audits add column if not exists report_geography jsonb;
comment on column public.audits.report_geography is
  'Verified Databricks historical country/region by external audit ID and study; reporting only.';

do $$
begin
  if (select count(*) from private.report_geography_source_20261011) <> 10239 then
    raise exception 'Incomplete historical geography staging';
  end if;
  if exists(select 1 from public.audits a join private.report_geography_source_20261011 g
    on g.external_id=a.external_id where a.study<>g.study) then
    raise exception 'Study mismatch: do not guess geography';
  end if;
end $$;

create table if not exists private.report_geography_backup_20261011 (
  audit_id bigint primary key, previous_geography jsonb, other_fields_hash text not null
);
alter table private.report_geography_backup_20261011 enable row level security;
revoke all on private.report_geography_backup_20261011 from public,anon,authenticated;

-- Lock prevents intervening writes during the short update and checksum check.
lock table public.audits in share row exclusive mode;
insert into private.report_geography_backup_20261011
select a.id,a.report_geography,md5((to_jsonb(a)-'report_geography')::text)
from public.audits a join private.report_geography_source_20261011 g
on g.external_id=a.external_id and g.study=a.study
on conflict (audit_id) do nothing;

-- This one trigger ONLY stamps updated_at (verified before rollout).
-- All RLS, assignment/country validation triggers and other protections remain.
-- Transaction rollback also restores the trigger on any error.
alter table public.audits disable trigger audits_set_updated_at;
update public.audits a
set report_geography=jsonb_build_object('country',g.country,'region',g.region,
  'source','storeview.slv_sv_ceres_ag_export','matchedBy','ID_de_audito + study',
  'retrievedAt','2026-10-11')
from private.report_geography_source_20261011 g
where g.external_id=a.external_id and g.study=a.study;
alter table public.audits enable trigger audits_set_updated_at;

do $$
begin
 if exists(select 1 from public.audits a join private.report_geography_backup_20261011 b
  on b.audit_id=a.id where md5((to_jsonb(a)-'report_geography')::text)<>b.other_fields_hash) then
  raise exception 'Unexpected change outside reporting geography: rolling back';
 end if;
end $$;
commit;

select a.study,count(*) as auditorias,
count(*) filter(where nullif(a.report_geography->>'country','') is not null) as con_pais_databricks,
count(*) filter(where nullif(a.report_geography->>'region','') is not null) as con_region_databricks,
count(*) filter(where md5((to_jsonb(a)-'report_geography')::text)=b.other_fields_hash) as resto_sin_cambios
from public.audits a left join private.report_geography_backup_20261011 b on b.audit_id=a.id
group by a.study order by a.study;
