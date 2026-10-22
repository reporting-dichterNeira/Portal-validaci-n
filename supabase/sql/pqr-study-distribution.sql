-- PQR sampling and routing by study. Apply after pqr-operation.sql.
begin;
set local lock_timeout='5s';
-- One responsible analyst per study; an analyst can own several studies.
create table if not exists private.pqr_study_settings (
 study text primary key check(study in ('Chile','Tradicional','Moderno','Lindley')),
 analyst_id uuid references private.pqr_analysts(id),
 percentage numeric not null default 20 check(percentage between 0 and 100),
 updated_at timestamptz not null default now()
);
insert into private.pqr_study_settings(study) values ('Chile'),('Tradicional'),('Moderno'),('Lindley') on conflict do nothing;
create table if not exists private.pqr_day_studies (
 day date not null references private.pqr_days(day), study text not null references private.pqr_study_settings(study),
 analyst_id uuid references private.pqr_analysts(id), percentage numeric not null check(percentage between 0 and 100),
 eligible integer not null default 0, target integer not null default 0,
 primary key(day,study)
);
alter table private.pqr_study_settings enable row level security;
alter table private.pqr_day_studies enable row level security;
revoke all on private.pqr_study_settings,private.pqr_day_studies from public,anon,authenticated;
create index if not exists pqr_reviews_day_study on private.pqr_reviews(day,study);


create or replace function private.pqr_refresh_day(p_day date) returns void
language plpgsql security definer set search_path='' as $$
declare v_day date:=p_day; v_today date:=(now() at time zone 'America/Bogota')::date; v_settings private.pqr_settings%rowtype;
 v_n integer; v_target integer; v_selected integer;
 v_pick record; v_scope record; v_seed uuid;
begin
 -- Try-lock keeps simultaneous browsers/cron from blocking normal validation.
 if not pg_try_advisory_xact_lock(186321, v_day-date '2026-01-01') then return;end if;
 select * into v_settings from private.pqr_settings where singleton;
 if not v_settings.enabled then return;end if;
 if v_day>v_today then raise exception 'PQR_FUTURE_DAY';end if;
 if v_day<v_today then
  select percentage into v_settings.percentage from private.pqr_days where day=v_day;
  if not found then return;end if;
 end if;
 insert into private.pqr_days(day,percentage) values(v_day,v_settings.percentage) on conflict do nothing;
 select seed into v_seed from private.pqr_days where day=v_day;
 if v_day=v_today then
  insert into private.pqr_day_studies(day,study,analyst_id,percentage)
   select v_day,study,analyst_id,percentage from private.pqr_study_settings
   on conflict(day,study) do update set analyst_id=excluded.analyst_id,percentage=excluded.percentage;
 else
  -- Finalizing yesterday uses its last saved percentages, never today's edits.
  insert into private.pqr_day_studies(day,study,percentage)
   select v_day,study,v_settings.percentage from private.pqr_study_settings on conflict do nothing;
 end if;

 -- Temporary candidates live only for this transaction. Completed time, never
 -- upload/operation date, defines the cohort. Source audit rows are read-only.
 create temporary table if not exists pqr_candidates(
  source_key text, source_audit_id bigint,external_id text,study text,country text,validator_id text,validator_name text,
  original_started_at timestamptz,original_completed_at timestamptz,original_sla_seconds numeric,
  alert_count integer,invalid_count integer,risk numeric,reasons jsonb,payload jsonb,original_results jsonb,kpis jsonb
 ) on commit drop;
 truncate pg_temp.pqr_candidates;
 insert into pg_temp.pqr_candidates
 with canonical as (
  select distinct on (a.study_id,a.country_id,a.external_id) a.*
  from public.audits a
  where a.module='blocking' and a.status='completada'
   and a.completed_at >= (v_day::timestamp at time zone 'America/Bogota')
   and a.completed_at < ((v_day+1)::timestamp at time zone 'America/Bogota') and a.completed_at<=now()
   and coalesce(a.pending_resolution,'') not in ('removed','replaced')
  order by a.study_id,a.country_id,a.external_id,a.completed_at desc,a.id desc
 ), measured as (
  select a.*,c.name as country_name,coalesce(v.name,'Sin identificar') as validator_name,
   case when a.started_at is not null and a.started_at<=a.completed_at then extract(epoch from a.completed_at-a.started_at) end as sla,
   ks.kpis,ks.n,ks.invalid
  from canonical a left join public.countries c on c.id=a.country_id left join public.validators v on v.id=a.assigned_validator_id
  cross join lateral (
   select jsonb_agg(k.value order by k.ordinality) as kpis,count(*)::integer as n,
    count(*) filter(where a.validation_results->(k.value->>'name')->>'status'='no_aplica')::integer as invalid
   from jsonb_array_elements(case when jsonb_typeof(a.payload->'kpis')='array' then a.payload->'kpis' else '[]'::jsonb end) with ordinality k(value,ordinality)
   where k.value->>'needsReview'='true' or k.value->>'alertaStatus'='SE ALERTA'
  ) ks where ks.n>0
 ), measured_speeds as (
  select id,cume_dist() over(partition by study_id order by sla) as speed_rank from measured where sla is not null
 ), ranked as (
  select m.*,s.speed_rank from measured m left join measured_speeds s on s.id=m.id
 )
 select jsonb_build_array(study_id,country_id,external_id)::text,id,external_id,study,coalesce(country_name,''),assigned_validator_id,validator_name,
  started_at,completed_at,sla,n,invalid,
  (case when sla is not null and speed_rank<=0.2 then 40 else 0 end)+20.0*invalid/n+15.0*least(invalid/5.0,1)+25.0*least(n/10.0,1),
  jsonb_build_object('fast',sla is not null and speed_rank<=0.2,'many_alerts',n>=3,'many_invalid',invalid>=2,'invalid_share',invalid::numeric/n),
  payload,validation_results,kpis from ranked;
 update private.pqr_day_studies d set
  eligible=(select count(*) from pg_temp.pqr_candidates c where c.study=d.study),
  target=ceil((select count(*) from pg_temp.pqr_candidates c where c.study=d.study)*d.percentage/100.0)
  where d.day=v_day;
 select count(*) into v_n from pg_temp.pqr_candidates;
 select coalesce(sum(target),0) into v_target from private.pqr_day_studies where day=v_day;
 update private.pqr_days set eligible=v_n,target=v_target,refreshed_at=now() where day=v_day;
 for v_scope in select * from private.pqr_day_studies where day=v_day order by study loop
  select count(*) into v_selected from private.pqr_reviews where day=v_day and study=v_scope.study;
  for v_pick in select c.* from pg_temp.pqr_candidates c
   where c.study=v_scope.study and not exists(select 1 from private.pqr_reviews r where r.day=v_day and r.source_key=c.source_key)
   order by c.risk desc,md5(v_seed::text||c.source_key) limit greatest(v_scope.target-v_selected,0)
  loop
   insert into private.pqr_reviews(day,source_key,source_audit_id,external_id,study,country,validator_id,validator_name,
    original_started_at,original_completed_at,original_sla_seconds,alert_count,invalid_count,risk,reasons,selection,payload,original_results,kpis)
   values(v_day,v_pick.source_key,v_pick.source_audit_id,v_pick.external_id,v_pick.study,v_pick.country,v_pick.validator_id,v_pick.validator_name,
    v_pick.original_started_at,v_pick.original_completed_at,v_pick.original_sla_seconds,v_pick.alert_count,v_pick.invalid_count,v_pick.risk,v_pick.reasons,'risk',v_pick.payload,v_pick.original_results,v_pick.kpis)
   on conflict(day,source_key) do nothing;
  end loop;
 end loop;
 if v_day<v_today then update private.pqr_days set closed_at=now() where day=v_day;return;end if;
 if not v_settings.auto_assign then return;end if;
 -- Only today's unstarted work follows a changed owner. In-progress and
 -- completed reviews, drafts and previous days keep their original analyst.
 for v_pick in
  select r.id,r.analyst_id as previous_analyst_id,
   case when a.active and a.available and a.deleted_at is null then a.id end as next_analyst_id
  from private.pqr_reviews r join private.pqr_day_studies d on d.day=r.day and d.study=r.study
  left join private.pqr_analysts a on a.id=d.analyst_id
  where r.day=v_day and r.status='pending' and r.started_at is null and r.review_results='{}'::jsonb
   and (r.analyst_id is distinct from d.analyst_id or r.analyst_id is null)
  order by r.risk desc,r.created_at for update of r skip locked
 loop
  if v_pick.previous_analyst_id is not distinct from v_pick.next_analyst_id then continue;end if;
  update private.pqr_reviews set analyst_id=v_pick.next_analyst_id,
   assigned_at=case when v_pick.next_analyst_id is not null then now() end,version=version+1 where id=v_pick.id;
  insert into private.pqr_events(review_id,action,detail) values(v_pick.id,'study_assigned',
   jsonb_build_object('previous_analyst_id',v_pick.previous_analyst_id,'analyst_id',v_pick.next_analyst_id));
 end loop;
end;$$;

create or replace function private.pqr_api(p_action text,p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ctx jsonb:=private.pqr_context(); v_role text; v_day date:=(now() at time zone 'America/Bogota')::date;
 v_id uuid; v_secret_id uuid; v_code text; v_code_hash text; v_review private.pqr_reviews%rowtype; v_results jsonb; v_kpi jsonb; v_result jsonb; v_verdict text;
 v_errors integer:=0; v_unevaluable integer:=0; v_rows jsonb; v_stats jsonb; v_analysts jsonb; v_settings jsonb;
 v_offset integer:=greatest(0,least(coalesce((p_data->>'offset')::integer,0),100000));
begin
 if ctx is null then raise exception 'PQR_ACCESS_REQUIRED' using errcode='42501';end if;
 v_role:=ctx->>'role';
 if p_action='context' then return ctx;end if;
 if p_action='logout' then delete from private.pqr_sessions where user_id=auth.uid();return '{}'::jsonb;end if;
 if p_action in ('create_supervisor','update_supervisor','reset_supervisor_password','delete_supervisor','restore_supervisor') and v_role<>'admin' then
  raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
 if p_action in ('settings','study_settings','start_distribution','create_analyst','update_analyst','get_code','reset_code','delete_analyst','restore_analyst','reassign','create_supervisor') and v_role not in ('admin','supervisor') then
  raise exception 'PQR_SUPERVISOR_REQUIRED' using errcode='42501';end if;
 if p_action='create_supervisor' then
  if v_role<>'admin' then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
  if length(btrim(coalesce(p_data->>'name','')))<2 then raise exception 'Indica un nombre de al menos 2 caracteres.';end if;
  if lower(btrim(coalesce(p_data->>'username',''))) !~ '^[a-z0-9][a-z0-9._-]{2,31}$' then raise exception 'El usuario debe tener entre 3 y 32 caracteres: letras, números, punto, guion o guion bajo.';end if;
  if length(coalesce(p_data->>'password',''))<8 then raise exception 'La contraseña debe tener al menos 8 caracteres.';end if;
  if exists(select 1 from private.pqr_supervisors where username=lower(btrim(p_data->>'username'))) then raise exception 'Ese usuario PQR ya existe.';end if;
  insert into private.pqr_supervisors(username,name,password_hash) values(lower(btrim(p_data->>'username')),left(btrim(p_data->>'name'),120),extensions.crypt(p_data->>'password',extensions.gen_salt('bf',10))) returning id into v_id;
  insert into private.pqr_events(actor,action,detail) values(auth.uid(),'supervisor_created',jsonb_build_object('id',v_id));
  return jsonb_build_object('id',v_id);
 elsif p_action in ('update_supervisor','reset_supervisor_password','delete_supervisor','restore_supervisor') then
  v_id:=(p_data->>'id')::uuid;
  perform 1 from private.pqr_supervisors where id=v_id for update;
  if not found then raise exception 'SUPERVISOR_NOT_FOUND';end if;
  if p_action='restore_supervisor' then
   update private.pqr_supervisors set deleted_at=null,active=false,credentials_changed_at=clock_timestamp() where id=v_id and deleted_at is not null;
   if not found then raise exception 'La supervisora no está eliminada.';end if;
  else
   if exists(select 1 from private.pqr_supervisors where id=v_id and deleted_at is not null) then raise exception 'Restaura la supervisora antes de modificar su cuenta.';end if;
   if p_action='update_supervisor' then
    if length(btrim(coalesce(p_data->>'name','')))<2 then raise exception 'Indica un nombre de al menos 2 caracteres.';end if;
    if lower(btrim(coalesce(p_data->>'username',''))) !~ '^[a-z0-9][a-z0-9._-]{2,31}$' then raise exception 'El usuario debe tener entre 3 y 32 caracteres: letras, números, punto, guion o guion bajo.';end if;
    if exists(select 1 from private.pqr_supervisors where username=lower(btrim(p_data->>'username')) and id<>v_id) then raise exception 'Ese usuario PQR ya existe.';end if;
    update private.pqr_supervisors set name=left(btrim(p_data->>'name'),120),username=lower(btrim(p_data->>'username')),
     active=coalesce((p_data->>'active')::boolean,active),
     credentials_changed_at=case when username is distinct from lower(btrim(p_data->>'username')) or active is distinct from coalesce((p_data->>'active')::boolean,active) then clock_timestamp() else credentials_changed_at end where id=v_id;
   elsif p_action='reset_supervisor_password' then
    if length(coalesce(p_data->>'password',''))<8 then raise exception 'La contraseña debe tener al menos 8 caracteres.';end if;
    update private.pqr_supervisors set password_hash=extensions.crypt(p_data->>'password',extensions.gen_salt('bf',10)),credentials_changed_at=clock_timestamp() where id=v_id;
   else
    update private.pqr_supervisors set deleted_at=clock_timestamp(),active=false,credentials_changed_at=clock_timestamp(),
     password_hash=extensions.crypt(encode(extensions.gen_random_bytes(32),'hex'),extensions.gen_salt('bf',10)) where id=v_id;
   end if;
  end if;
  insert into private.pqr_events(actor,action,detail) values(auth.uid(),p_action,jsonb_build_object('id',v_id));
  return jsonb_build_object('id',v_id);
 elsif p_action='start_distribution' then
  if not exists(select 1 from private.pqr_study_settings s join private.pqr_analysts a on a.id=s.analyst_id where a.active and a.available and a.deleted_at is null and s.percentage>0) then raise exception 'Configura al menos un estudio con un responsable disponible y un porcentaje mayor que cero.';end if;
  update private.pqr_settings set auto_assign=true,updated_at=now() where singleton;
  insert into private.pqr_events(actor,action) values(auth.uid(),'distribution_enabled');
 elsif p_action='study_settings' then
  -- Serialize configuration with sampling and assignment of today's cohort.
  perform pg_advisory_xact_lock(186321,v_day-date '2026-01-01');
  if jsonb_typeof(p_data->'studies') is distinct from 'array' then raise exception 'Indica los cuatro estudios y sus porcentajes.';end if;
  if jsonb_array_length(p_data->'studies')<>4 or
   (select count(distinct x->>'study') from jsonb_array_elements(p_data->'studies') x where x->>'study' in ('Chile','Tradicional','Moderno','Lindley'))<>4 then
   raise exception 'Configura una sola vez cada estudio: Chile, Tradicional CAM, Moderno CAM y Lindley.';end if;
  if exists(select 1 from jsonb_array_elements(p_data->'studies') x
   where jsonb_typeof(x->'percentage') is distinct from 'number' or (x->>'percentage')::numeric not between 0 and 100) then
   raise exception 'Cada porcentaje debe estar entre 0 y 100.';end if;
  if exists(select 1 from jsonb_array_elements(p_data->'studies') x where nullif(x->>'analyst_id','') is not null
   and not exists(select 1 from private.pqr_analysts a where a.id=(x->>'analyst_id')::uuid and a.deleted_at is null)) then
   raise exception 'Selecciona un analista del equipo actual para cada estudio.';end if;
  update private.pqr_study_settings s set analyst_id=nullif(x->>'analyst_id','')::uuid,
   percentage=(x->>'percentage')::numeric,updated_at=now() from jsonb_array_elements(p_data->'studies') x where s.study=x->>'study';
  insert into private.pqr_events(actor,action,detail) values(auth.uid(),'study_settings_changed',p_data);
 elsif p_action='settings' then
  raise exception 'Configura el responsable y porcentaje de cada estudio desde Reparto por estudio.';
 elsif p_action='create_analyst' then
  if length(btrim(coalesce(p_data->>'name','')))<2 then raise exception 'Indica el nombre del analista.';end if;
  select 'PQR-'||string_agg(substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ',1+(get_byte(entropy.bytes,i)%32),1),'' order by i)
   into v_code from (select extensions.gen_random_bytes(12) bytes) entropy cross join generate_series(0,11) i;
  insert into private.pqr_analysts(name,code_hash,code_secret_id) values(left(btrim(p_data->>'name'),120),encode(extensions.digest(v_code,'sha256'),'hex'),vault.create_secret(v_code,null,'PQR analyst access code')) returning id into v_id;
  insert into private.pqr_events(actor,action,detail) values(auth.uid(),'analyst_created',jsonb_build_object('id',v_id));
  perform private.pqr_refresh_today();return jsonb_build_object('id',v_id,'code',v_code);
 elsif p_action in ('delete_analyst','restore_analyst') then
  -- Serialize deletion with today's automatic distributor and review starts.
  perform pg_advisory_xact_lock(186321,v_day-date '2026-01-01');
  perform 1 from private.pqr_analysts where id=(p_data->>'id')::uuid for update;
  if not found then raise exception 'ANALYST_NOT_FOUND';end if;
  if p_action='delete_analyst' then
   if exists(select 1 from private.pqr_reviews where analyst_id=(p_data->>'id')::uuid and (status='in_progress' or (status='pending' and review_results<>'{}'::jsonb))) then raise exception 'El analista tiene revisiones en curso. Debe terminarlas antes de eliminarlo.';end if;
   select code_secret_id into v_secret_id from private.pqr_analysts where id=(p_data->>'id')::uuid;
   if v_secret_id is not null then perform vault.update_secret(v_secret_id,encode(extensions.gen_random_bytes(32),'hex'));end if;
   update private.pqr_analysts set deleted_at=clock_timestamp(),active=false,available=false,credentials_changed_at=clock_timestamp(),code_secret_id=null,code_hash=encode(extensions.digest(extensions.gen_random_bytes(32),'sha256'),'hex') where id=(p_data->>'id')::uuid and deleted_at is null;
   if not found then raise exception 'El analista ya fue eliminado.';end if;
   update private.pqr_reviews set analyst_id=null,assigned_at=null,version=version+1 where analyst_id=(p_data->>'id')::uuid and status='pending';
   update private.pqr_study_settings set analyst_id=null,updated_at=now() where analyst_id=(p_data->>'id')::uuid;
  else
   update private.pqr_analysts set deleted_at=null,active=false,available=false where id=(p_data->>'id')::uuid and deleted_at is not null;
   if not found then raise exception 'El analista no está eliminado.';end if;
  end if;
  insert into private.pqr_events(actor,action,detail) values(auth.uid(),p_action,jsonb_build_object('id',p_data->>'id'));
 elsif p_action='update_analyst' then
  if not (p_data->>'active')::boolean and exists(select 1 from private.pqr_reviews where analyst_id=(p_data->>'id')::uuid and status='in_progress') then raise exception 'El analista tiene revisiones en curso. Puede pausar su reparto; debe terminar esas revisiones antes de desactivarlo.';end if;
  update private.pqr_analysts set active=(p_data->>'active')::boolean,available=(p_data->>'available')::boolean where id=(p_data->>'id')::uuid and deleted_at is null;
  if not found then raise exception 'ANALYST_NOT_FOUND';end if;
  insert into private.pqr_events(actor,action,detail) values(auth.uid(),'analyst_updated',p_data);
 elsif p_action='get_code' then
  select code_secret_id,code_hash into v_secret_id,v_code_hash from private.pqr_analysts where id=(p_data->>'id')::uuid and deleted_at is null for update;
  if not found then raise exception 'ANALYST_NOT_FOUND';end if;
  select decrypted_secret into v_code from vault.decrypted_secrets where id=v_secret_id;
  if v_code is null or encode(extensions.digest(v_code,'sha256'),'hex') is distinct from v_code_hash then return jsonb_build_object('requires_new_code',true);end if;
  insert into private.pqr_events(actor,action,detail) values(auth.uid(),'analyst_code_copied',jsonb_build_object('id',p_data->>'id'));
  return jsonb_build_object('code',v_code);
 elsif p_action='reset_code' then
  select code_secret_id into v_secret_id from private.pqr_analysts where id=(p_data->>'id')::uuid and deleted_at is null for update;
  if not found then raise exception 'ANALYST_NOT_FOUND';end if;
  select 'PQR-'||string_agg(substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ',1+(get_byte(entropy.bytes,i)%32),1),'' order by i)
   into v_code from (select extensions.gen_random_bytes(12) bytes) entropy cross join generate_series(0,11) i;
  if v_secret_id is null then v_secret_id:=vault.create_secret(v_code,null,'PQR analyst access code');
  else perform vault.update_secret(v_secret_id,v_code);end if;
  update private.pqr_analysts set code_hash=encode(extensions.digest(v_code,'sha256'),'hex'),code_secret_id=v_secret_id,credentials_changed_at=clock_timestamp() where id=(p_data->>'id')::uuid and deleted_at is null;
  if not found then raise exception 'ANALYST_NOT_FOUND';end if;
  insert into private.pqr_events(actor,action,detail) values(auth.uid(),'analyst_code_reset',jsonb_build_object('id',p_data->>'id'));
  return jsonb_build_object('code',v_code);
 elsif p_action='reassign' then
  perform pg_advisory_xact_lock(186321,v_day-date '2026-01-01');
  if not exists(select 1 from private.pqr_reviews r join private.pqr_study_settings s on s.study=r.study
   where r.id=(p_data->>'id')::uuid and s.analyst_id=(p_data->>'analyst_id')::uuid) then
   raise exception 'La auditoría debe asignarse al responsable de su estudio. Cambia el responsable en Reparto por estudio.';end if;
  if not exists(select 1 from private.pqr_analysts where id=(p_data->>'analyst_id')::uuid and active and available) then raise exception 'ANALYST_UNAVAILABLE';end if;
  update private.pqr_reviews set analyst_id=(p_data->>'analyst_id')::uuid,assigned_at=now(),version=version+1
   where id=(p_data->>'id')::uuid and status='pending' and started_at is null and review_results='{}'::jsonb;
  if not found then raise exception 'Solo se pueden reasignar auditorías pendientes sin revisión iniciada.';end if;
  insert into private.pqr_events(review_id,actor,action,detail) values((p_data->>'id')::uuid,auth.uid(),'reassigned',jsonb_build_object('analyst_id',p_data->>'analyst_id'));
 elsif p_action in ('detail','start','save') then
  if v_role='analyst' and p_action in ('start','save') then
   perform 1 from private.pqr_analysts where id=(ctx->>'id')::uuid and active and deleted_at is null for update;
   if not found then raise exception 'PQR_ACCESS_REQUIRED' using errcode='42501';end if;
  end if;
  select * into v_review from private.pqr_reviews where id=(p_data->>'id')::uuid for update;
  if not found or (v_role='analyst' and v_review.analyst_id is distinct from (ctx->>'id')::uuid) then raise exception 'REVIEW_NOT_ASSIGNED' using errcode='42501';end if;
  if p_action in ('start','save') then
   if v_role<>'analyst' or v_review.status='completed' then raise exception 'REVIEW_READ_ONLY' using errcode='42501';end if;
   if p_action='start' then
    update private.pqr_reviews set status='in_progress',started_at=coalesce(started_at,clock_timestamp()),version=version+1 where id=v_review.id and status='pending';
   else
    if (p_data->>'version')::integer is distinct from v_review.version then raise exception 'La revisión cambió. Actualiza antes de guardar.' using errcode='40001';end if;
    v_results:=coalesce(p_data->'results','{}'::jsonb);
    if jsonb_typeof(v_results)<>'object' or pg_column_size(v_results)>200000 then raise exception 'INVALID_REVIEW_RESULTS';end if;
    if exists(select 1 from jsonb_object_keys(v_results) k where not exists(select 1 from jsonb_array_elements(v_review.kpis) x where x->>'name'=k)) then raise exception 'UNKNOWN_KPI';end if;
    for v_kpi in select value from jsonb_array_elements(v_review.kpis) loop
     v_result:=v_results->(v_kpi->>'name');
     if v_result is not null then
      if coalesce(v_result->>'evaluation','') not in ('correct','incorrect','not_evaluable') then raise exception 'INVALID_EVALUATION';end if;
      if v_result->>'evaluation'='correct' and coalesce(v_review.original_results->(v_kpi->>'name')->>'status','') not in ('aplica','no_aplica') then raise exception 'La respuesta original no está finalizada. Marca incorrecta o no evaluable.';end if;
      if length(coalesce(v_result->>'comment',''))>4000 then raise exception 'COMMENT_TOO_LONG';end if;
      if v_result->>'evaluation'='incorrect' and (coalesce(v_result->>'correct_decision','') not in ('aplica','no_aplica') or length(btrim(coalesce(v_result->>'comment','')))<3) then raise exception 'Indica la respuesta correcta y explica el error en cada alerta incorrecta.';end if;
      if v_result->>'evaluation'='not_evaluable' and length(btrim(coalesce(v_result->>'comment','')))<3 then raise exception 'Explica por qué la alerta no es evaluable.';end if;
      if v_result->>'evaluation'='incorrect' then v_errors:=v_errors+1;end if;
      if v_result->>'evaluation'='not_evaluable' then v_unevaluable:=v_unevaluable+1;end if;
     elsif coalesce((p_data->>'complete')::boolean,false) then raise exception 'Evalúa todas las alertas antes de completar.';end if;
    end loop;
    if coalesce((p_data->>'complete')::boolean,false) then v_verdict:=case when v_errors>0 then 'errors' when v_unevaluable>0 then 'not_evaluable' else 'correct' end;end if;
    update private.pqr_reviews set review_results=v_results,started_at=coalesce(started_at,clock_timestamp()),
     status=case when v_verdict is not null then 'completed' else 'in_progress' end,
     completed_at=case when v_verdict is not null then clock_timestamp() end,verdict=v_verdict,version=version+1 where id=v_review.id;
    insert into private.pqr_events(review_id,actor,action,detail) values(v_review.id,auth.uid(),case when v_verdict is null then 'draft_saved' else 'completed' end,jsonb_build_object('verdict',v_verdict));
   end if;
  end if;
  return (select (to_jsonb(r)-'source_key'-'validator_id')||jsonb_build_object('analyst_name',a.name,
   'payload',private.pqr_public_payload(r.payload),'kpis',private.pqr_public_payload(r.kpis))
   from private.pqr_reviews r left join private.pqr_analysts a on a.id=r.analyst_id where r.id=v_review.id);
 elsif p_action not in ('dashboard','export') then raise exception 'UNKNOWN_PQR_ACTION';end if;

 perform private.pqr_refresh_today();
 -- Late work remains attached to its original day; never reset its deadline.
 if p_data ? 'day' and coalesce(p_data->>'day','')<>'' then v_day:=(p_data->>'day')::date;end if;
 select to_jsonb(s) into v_settings from private.pqr_settings s;
 select jsonb_build_object('eligible',coalesce(d.eligible,0),'target',coalesce(d.target,0),'percentage',null,'percentage_mode','study',
  'selected',count(r.id),'assigned',count(r.id) filter(where r.analyst_id is not null),'completed',count(r.id) filter(where r.status='completed'),
  'on_time',count(r.id) filter(where r.status='completed' and (r.completed_at at time zone 'America/Bogota')::date=r.day),
  'overdue',count(r.id) filter(where r.status<>'completed' and r.day<(now() at time zone 'America/Bogota')::date),
  'errors',count(r.id) filter(where r.verdict='errors'),'not_evaluable',count(r.id) filter(where r.verdict='not_evaluable'),
  'mean_seconds',avg(extract(epoch from r.completed_at-r.started_at)) filter(where r.status='completed'),
  'refreshed_at',d.refreshed_at) into v_stats
 from (select * from private.pqr_days where day=v_day) d right join (select v_day as day) x on true
 left join private.pqr_reviews r on r.day=v_day and (v_role<>'analyst' or r.analyst_id=(ctx->>'id')::uuid)
 group by d.eligible,d.target,d.percentage,d.refreshed_at;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.name),'[]'::jsonb) into v_analysts from (
  select a.id,a.name,a.active,a.available,a.deleted_at,count(r.id) as assigned,count(r.id) filter(where r.status='completed') as completed,
   count(r.id) filter(where r.status='in_progress') as in_progress,count(r.id) filter(where r.status='pending') as pending,
   count(r.id) filter(where r.verdict='errors') as errors,
   count(r.id) filter(where r.status='completed' and (r.completed_at at time zone 'America/Bogota')::date=r.day) as on_time,
   avg(extract(epoch from r.completed_at-r.started_at)) filter(where r.status='completed') as mean_seconds,
   (select count(*) from private.pqr_reviews old where old.analyst_id=a.id and old.day<v_day and old.status<>'completed') as previous_pending
  from private.pqr_analysts a left join private.pqr_reviews r on r.analyst_id=a.id and r.day=v_day
  where v_role<>'analyst' or a.id=(ctx->>'id')::uuid group by a.id
 ) x;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.day,x.risk desc,x.created_at),'[]'::jsonb) into v_rows from (
  select r.id,r.day,r.external_id,r.study,r.country,r.validator_name,r.analyst_id,a.name as analyst_name,r.alert_count,r.invalid_count,r.risk,r.reasons,r.selection,r.assigned_at,
   r.original_completed_at,r.original_sla_seconds,r.status,r.started_at,r.completed_at,r.verdict,r.version,r.created_at,
   r.day<(now() at time zone 'America/Bogota')::date and r.status<>'completed' as overdue,
   r.status='completed' and (r.completed_at at time zone 'America/Bogota')::date=r.day as on_time,
   case when p_action='export' then private.pqr_public_payload(r.kpis) end as kpis,
   case when p_action='export' then r.original_results end as original_results,
   case when p_action='export' then r.review_results end as review_results
  from private.pqr_reviews r left join private.pqr_analysts a on a.id=r.analyst_id
  where (v_role<>'analyst' or r.analyst_id=(ctx->>'id')::uuid)
   and (r.day=v_day or (coalesce((p_data->>'previous')::boolean,false) and r.day<v_day and r.status<>'completed'))
   and (coalesce(p_data->>'status','all')='all' or r.status=p_data->>'status')
  order by r.day,r.risk desc,r.created_at limit case when p_action='export' then 10000 else 100 end offset case when p_action='export' then 0 else v_offset end
 ) x;
 return jsonb_build_object('context',ctx,'today',(now() at time zone 'America/Bogota')::date,'day',v_day,'stats',v_stats,
  'study_settings',(select coalesce(jsonb_agg(jsonb_build_object('study',s.study,'analyst_id',s.analyst_id,'percentage',s.percentage) order by s.study),'[]'::jsonb)
   from private.pqr_study_settings s where v_role<>'analyst' or s.analyst_id=(ctx->>'id')::uuid),
  'study_stats',case when v_role<>'analyst' then (select coalesce(jsonb_agg(to_jsonb(x) order by x.study),'[]'::jsonb) from (
   select d.study,d.analyst_id,a.name as analyst_name,d.percentage,d.eligible,d.target,
    count(r.id) as selected,count(r.id) filter(where r.analyst_id is not null) as assigned,count(r.id) filter(where r.status='completed') as completed
   from private.pqr_day_studies d left join private.pqr_analysts a on a.id=d.analyst_id
   left join private.pqr_reviews r on r.day=d.day and r.study=d.study where d.day=v_day
   group by d.day,d.study,a.name) x) else '[]'::jsonb end,
  'settings',case when v_role<>'analyst' then v_settings else null end,'analysts',v_analysts,'reviews',v_rows,
  'supervisors',case when v_role='admin' then (select coalesce(jsonb_agg(jsonb_build_object('id',id,'username',username,'name',name,'active',active,'deleted_at',deleted_at) order by name,username),'[]'::jsonb) from private.pqr_supervisors) else '[]'::jsonb end);
end;$$;


notify pgrst,'reload schema';
commit;
