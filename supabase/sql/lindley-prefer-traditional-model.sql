-- Apply only after inspecting current triggers and duplicate counts in production.
-- Historical source decisions and removed model records are retained in payload.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

create or replace function private.lindley_model_key(value text)
returns text language sql immutable set search_path='' as $$
 select upper(translate(regexp_replace(btrim(coalesce(value,'')),'[[:space:]]+',' ','g'),'ÁÉÍÓÚÜÑáéíóúüñ','AEIOUUNaeiouun'));
$$;

create or replace function private.lindley_prefer_traditional(p_payload jsonb,p_results jsonb)
returns jsonb language sql immutable set search_path='' as $$
 with entries as (
 select value as k,ordinality as pos,
 private.lindley_model_key(coalesce(nullif(value->>'kpiName',''),value->>'name')) as base,
 private.lindley_model_key(value->>'modelo') as model
 from jsonb_array_elements(case when jsonb_typeof(p_payload->'kpis')='array' then p_payload->'kpis' else '[]'::jsonb end) with ordinality
 ), marked as (
 select *,model<>'TRADICIONAL' and exists(select 1 from entries t where t.base=e.base and t.model='TRADICIONAL') as remove from entries e
 ), removed as (select * from marked where remove), kept as (select * from marked where not remove),
 result_keys as (
 select key,value from jsonb_each(coalesce(p_results,'{}'::jsonb)) r
 where not exists(select 1 from removed d where d.k->>'name'=r.key)
 or exists(select 1 from kept k where k.k->>'name'=r.key)
 )
 select case when not exists(select 1 from removed) then jsonb_build_object('payload',p_payload,'validation_results',coalesce(p_results,'{}'::jsonb)) else
 jsonb_build_object('payload',jsonb_set(jsonb_set(p_payload,'{kpis}',(select coalesce(jsonb_agg(k order by pos),'[]'::jsonb) from kept)),
 '{_lindleyModelDuplicates}',coalesce(p_payload->'_lindleyModelDuplicates','[]'::jsonb)||(select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('kpi',k,'validationResult',p_results->(k->>'name'))) order by pos) from removed)),
 'validation_results',(select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from result_keys)) end;
$$;

create table if not exists private.lindley_model_cleanup_backup_20261127(
 audit_id bigint primary key, original_row jsonb not null, backed_up_at timestamptz not null default now()
);
alter table private.lindley_model_cleanup_backup_20261127 enable row level security;
revoke all on private.lindley_model_cleanup_backup_20261127 from public,anon,authenticated;

lock table public.audits in share row exclusive mode;
insert into private.lindley_model_cleanup_backup_20261127(audit_id,original_row)
select a.id,to_jsonb(a) from public.audits a
where a.study='Lindley' and a.module::text='blocking'
and private.lindley_prefer_traditional(a.payload,a.validation_results)->'payload' is distinct from a.payload
on conflict(audit_id) do nothing;

update public.audits a set payload=n.value->'payload',validation_results=n.value->'validation_results'
from (select id,private.lindley_prefer_traditional(payload,validation_results) as value from public.audits
 where study='Lindley' and module::text='blocking') n
where a.id=n.id and a.payload is distinct from n.value->'payload';

create or replace function private.enforce_lindley_model_preference()
returns trigger language plpgsql security definer set search_path='' as $$
declare normalized jsonb;
begin
 if new.study='Lindley' and new.module::text='blocking' then
 normalized:=private.lindley_prefer_traditional(new.payload,new.validation_results);
 new.payload:=normalized->'payload';new.validation_results:=normalized->'validation_results';
 end if;
 return new;
end $$;
drop trigger if exists audits_lindley_model_preference on public.audits;
create trigger audits_lindley_model_preference before insert or update of payload,validation_results,study,module
on public.audits for each row execute function private.enforce_lindley_model_preference();
revoke all on function private.lindley_model_key(text),private.lindley_prefer_traditional(jsonb,jsonb),private.enforce_lindley_model_preference() from public,anon,authenticated;

do $$ begin
 if exists(select 1 from public.audits a join private.lindley_model_cleanup_backup_20261127 b on b.audit_id=a.id
 where (to_jsonb(a)-array['payload','validation_results','updated_at']) is distinct from (b.original_row-array['payload','validation_results','updated_at'])) then
 raise exception 'Unexpected change outside Lindley model duplicates';end if;
end $$;
commit;
