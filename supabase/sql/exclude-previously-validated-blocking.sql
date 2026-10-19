begin;

-- Match only within Bloqueantes, study and country. IDs are normalized by
-- ExcelParser before import. Smart remains an independent review operation.
create index if not exists audits_completed_blocking_identity_idx
on public.audits(study_id,country_id,external_id)
where module='blocking' and status='completada';

-- Internal trigger only: existing audit write policies authorize the caller.
-- Definer access is needed to find historical completions by other validators;
-- no new callable API or read permission is exposed.
create or replace function private.exclude_completed_blocking_repeat()
returns trigger language plpgsql security definer set search_path=''
as $function$
declare previous public.audits%rowtype;
begin
 if new.module<>'blocking' then return new; end if;
 -- Serialize imports and completions for this identity so simultaneous work
 -- cannot leave an unexcluded repeat between the two triggers.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
   new.study_id::text||'/'||new.country_id::text||'/'||new.external_id,0));
 if new.status='completada'
    or coalesce(new.pending_resolution,'') in ('removed','replaced') then return new; end if;
 select c.* into previous from public.audits c
 join public.upload_batches b on b.id=c.batch_id
 where c.module='blocking' and c.status='completada'
 and c.study_id=new.study_id and c.country_id=new.country_id
 and c.external_id=new.external_id and c.id is distinct from new.id
 and b.status in ('active','archived')
 order by c.completed_at desc nulls last,c.id desc limit 1;
 if found then
   new.pending_resolution:='replaced';
   new.payload:=coalesce(new.payload,'{}'::jsonb)||jsonb_build_object(
     '_previousBlockingValidation',jsonb_build_object('audit_row_id',previous.id,
       'completed_at',previous.completed_at,'reason','ID ya validado en Bloqueantes'));
 end if;
 return new;
end $function$;
revoke all on function private.exclude_completed_blocking_repeat() from public,anon,authenticated;

create or replace function private.exclude_pending_blocking_repeats_after_completion()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
 if new.module='blocking' and new.status='completada'
 and (tg_op='INSERT' or old.status is distinct from new.status) then
   update public.audits p set pending_resolution='replaced',
     payload=coalesce(p.payload,'{}'::jsonb)||jsonb_build_object(
       '_previousBlockingValidation',jsonb_build_object('audit_row_id',new.id,
         'completed_at',new.completed_at,'reason','ID ya validado en Bloqueantes'))
   where p.module='blocking' and p.status<>'completada'
   and p.study_id=new.study_id and p.country_id=new.country_id
   and p.external_id=new.external_id and p.id<>new.id
   and coalesce(p.pending_resolution,'') not in ('removed','replaced')
   and exists(select 1 from public.upload_batches b where b.id=new.batch_id and b.status in ('active','archived'));
 end if;
 return new;
end $function$;
revoke all on function private.exclude_pending_blocking_repeats_after_completion() from public,anon,authenticated;

drop trigger if exists audits_exclude_completed_blocking_repeat on public.audits;
create trigger audits_exclude_completed_blocking_repeat
before insert or update of status,external_id,study_id,country_id,module,pending_resolution
on public.audits for each row execute function private.exclude_completed_blocking_repeat();
drop trigger if exists audits_exclude_pending_blocking_repeats_after_completion on public.audits;
create trigger audits_exclude_pending_blocking_repeats_after_completion
after insert or update of status on public.audits
for each row execute function private.exclude_pending_blocking_repeats_after_completion();

-- Preserve payload, status, decisions, attribution and original history.
-- Use the same resolution flag already excluded by queues and dashboards.
with previous as (
 select distinct on(p.id) p.id,c.id as completed_id,c.completed_at
 from public.audits p join public.audits c
 on c.study_id=p.study_id and c.country_id=p.country_id and c.external_id=p.external_id
 join public.upload_batches b on b.id=c.batch_id
 where p.module='blocking' and p.status<>'completada'
 and coalesce(p.pending_resolution,'') not in ('removed','replaced')
 and c.module='blocking' and c.status='completada' and b.status in ('active','archived')
 order by p.id,c.completed_at desc nulls last,c.id desc
)
update public.audits p set pending_resolution='replaced',
 payload=coalesce(p.payload,'{}'::jsonb)||jsonb_build_object(
   '_previousBlockingValidation',jsonb_build_object('audit_row_id',c.completed_id,
     'completed_at',c.completed_at,'reason','ID ya validado en Bloqueantes'))
from previous c where p.id=c.id;

commit;
