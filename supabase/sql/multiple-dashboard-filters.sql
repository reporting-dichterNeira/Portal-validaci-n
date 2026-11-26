CREATE OR REPLACE FUNCTION private.get_databricks_audit_totals(p_filters jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET jit TO 'off'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare result jsonb;
begin
 if auth.uid() is null or not exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active and p.role::text in ('admin','supervisor','visualizer','commercial')) then raise exception 'VISUALIZATION_ACCESS_REQUIRED' using errcode='42501'; end if;
 
 with base as materialized (
  select r.study,r.audit_external_id,r.country,r.region,r.channel,r.subchannel,r.segmento,r.auditor,r.source_filename,r.imported_at
  from private.metrics_inventory_snapshots r /* cached-inventory-months */
  where (exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(p_filters->'month')='array' then p_filters->'month' else jsonb_build_array(coalesce(p_filters->>'month','')) end) choice(value) where choice.value='' or r.period_month=((choice.value)||'-01')::date))
   and (coalesce(p_filters->>'from','')='' or r.audit_date >= (p_filters->>'from')::date)
   and (coalesce(p_filters->>'to','')='' or r.audit_date <= (p_filters->>'to')::date)
 ), study_keys as materialized (select distinct study from base),
 study_labels as materialized (select study,case when lower(study) ~ 'ko[ _]trad[ _]ch([ _]|$)|chile|embonor' then 'Chile' when lower(study) like '%lindley%' then 'Lindley' when lower(study) like '%moderno%' then 'KO Moderno CAM' when lower(study) like '%trad%' then 'KO Tradicional CAM' end as study_name from study_keys),
 source as (select b.*,l.study_name from base b join study_labels l on b.study=l.study),
selected as ( select * from source s where s.study_name is not null
   and (lower(btrim(coalesce(s.region,''))) not in ('','sin región','sin region','sin región identificada','sin region identificada')
     or lower(btrim(coalesce(s.channel,''))) not in ('','sin canal','sin canal identificado')
     or exists (select 1 from public.audits a
       where a.external_id=nullif(ltrim(s.audit_external_id,'0'),'') and a.module='blocking'
        and a.study=case s.study_name when 'KO Tradicional CAM' then 'Tradicional'
          when 'KO Moderno CAM' then 'Moderno' else s.study_name end
        and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(a.payload->'kpis')='array'
          then a.payload->'kpis' else '[]'::jsonb end) k
          where k->>'needsReview'='true' or k->>'alertaStatus'='SE ALERTA')
         offset 0)) /* indexed-empty-alert-check */
       /* exclude-empty-unalerted-inventory */ and (not (p_filters ? 'studies') or jsonb_array_length(p_filters->'studies')=0 or s.study_name in (select jsonb_array_elements_text(p_filters->'studies'))) and (coalesce(p_filters->>'geography','all')='all' or upper(translate(regexp_replace(btrim(case when s.study_name in ('Chile','Lindley') then coalesce(s.region,'') else coalesce(s.country,'') end), '[[:space:]]+', ' ', 'g'), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')) = upper(translate(regexp_replace(btrim(coalesce(nullif(p_filters->>'geography','__missing__'),'')), '[[:space:]]+', ' ', 'g'), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou'))) and (exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(p_filters->'country')='array' then p_filters->'country' else jsonb_build_array(coalesce(p_filters->>'country','all')) end) choice(value) where choice.value='all' or lower(translate(btrim(case when s.study_name='Chile' then 'Chile' when s.study_name='Lindley' then 'Perú' else coalesce(s.country,'') end), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')) = lower(translate(coalesce(nullif(choice.value,'__missing__'),''), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')))) and (exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(p_filters->'region')='array' then p_filters->'region' else jsonb_build_array(coalesce(p_filters->>'region','all')) end) choice(value) where choice.value='all' or upper(translate(regexp_replace(btrim(coalesce(nullif(s.region,''),'Sin región')), '[[:space:]]+', ' ', 'g'), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')) = upper(translate(regexp_replace(btrim(choice.value), '[[:space:]]+', ' ', 'g'), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')) /* normalized-report-regions */)) and (exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(p_filters->'channel')='array' then p_filters->'channel' else jsonb_build_array(coalesce(p_filters->>'channel','all')) end) choice(value) where choice.value='all' or coalesce(nullif(s.channel,''),'Sin canal')=choice.value)) and (exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(p_filters->'subchannel')='array' then p_filters->'subchannel' else jsonb_build_array(coalesce(p_filters->>'subchannel','all')) end) choice(value) where choice.value='all' or coalesce(nullif(s.subchannel,''),'Sin subcanal')=choice.value)) ), territory_keys as materialized (
 select distinct study_name,coalesce(region,'') as region,coalesce(country,'') as country from selected
 ), territory_labels as materialized (select k.*,case when study_name in ('Chile','Lindley') then coalesce(nullif(upper(translate(regexp_replace(btrim(region), '[[:space:]]+', ' ', 'g'), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')),''),'Sin región identificada') else coalesce(nullif(case when lower(country) like '%guatemala%' or lower(country) like '%embocen%' then 'Guatemala' else private.normalize_audit_country(country) end,''),'Sin país identificado') end as geography from territory_keys k
 ), territory_source as (
 select s.audit_external_id,s.source_filename,s.study_name,t.geography from selected s join territory_labels t
 on s.study_name=t.study_name and coalesce(s.region,'')=t.region and coalesce(s.country,'')=t.country
 ),
 territory_counts as ( select study_name, geography, count(distinct nullif(ltrim(audit_external_id,'0'),'')) filter(where source_filename ilike 'Databricks%') as databricks_total, bool_and(source_filename ilike 'Databricks%') as verified from territory_source group by study_name, geography ),
 auditor_counts as ( select lower(regexp_replace(btrim(auditor), '[[:space:]]+', ' ', 'g')) as auditor, count(distinct (study_name, nullif(ltrim(audit_external_id,'0'),''))) as databricks_total from selected where coalesce(p_filters->>'include_auditors','false')='true' and source_filename ilike 'Databricks%' and nullif(btrim(auditor),'') is not null and nullif(ltrim(audit_external_id,'0'),'') is not null group by lower(regexp_replace(btrim(auditor), '[[:space:]]+', ' ', 'g')) ),
 channel_segment_counts as ( select study_name, coalesce(nullif(upper(translate(regexp_replace(btrim(channel),'[[:space:]]+',' ','g'),'ÁÉÍÓÚáéíóú','AEIOUaeiou')),''),'Sin canal identificado') as channel, coalesce(nullif(upper(translate(regexp_replace(btrim(segmento),'[[:space:]]+',' ','g'),'ÁÉÍÓÚáéíóú','AEIOUaeiou')),''),'Sin segmento identificado') as segmento, count(distinct nullif(ltrim(audit_external_id,'0'),'')) as databricks_total from selected where coalesce(p_filters->>'include_channel_segments','false')='true' and source_filename ilike 'Databricks%' group by study_name,2,3 ),
 counts as ( select study_name,count(distinct nullif(ltrim(audit_external_id,'0'),'')) as export_total,count(distinct nullif(ltrim(audit_external_id,'0'),'')) filter(where source_filename ilike 'Databricks%') as databricks_total,bool_and(source_filename ilike 'Databricks%') as verified,max(imported_at) as refreshed_at from selected group by study_name ) select jsonb_build_object('studies',coalesce((select jsonb_agg(to_jsonb(c)) from counts c),'[]'::jsonb),'territories',coalesce((select jsonb_agg(to_jsonb(t)) from territory_counts t),'[]'::jsonb), 'territory_totals_ready',true,'auditors',coalesce((select jsonb_agg(to_jsonb(a)) from auditor_counts a),'[]'::jsonb), 'auditor_totals_ready',coalesce(p_filters->>'include_auditors','false')='true','channel_segments',coalesce((select jsonb_agg(to_jsonb(g)) from channel_segment_counts g),'[]'::jsonb), 'channel_segment_totals_ready',coalesce(p_filters->>'include_channel_segments','false')='true','snapshots',coalesce((select jsonb_agg(jsonb_build_object('month',i.period_month,'source',i.source_filename,'refreshed_at',i.imported_at)) from private.metrics_inventory_months i where true and (exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(p_filters->'month')='array' then p_filters->'month' else jsonb_build_array(coalesce(p_filters->>'month','')) end) choice(value) where choice.value='' or i.period_month=((choice.value)||'-01')::date))),'[]'::jsonb)) into result;
 return result;
end;
$function$
;

CREATE OR REPLACE FUNCTION private.pqr_api(p_action text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare ctx jsonb:=private.pqr_context(); v_role text; v_day date:=(now() at time zone 'America/Bogota')::date;
 v_id uuid; v_secret_id uuid; v_code text; v_code_hash text; v_review private.pqr_active_reviews%rowtype; v_results jsonb; v_kpi jsonb; v_result jsonb; v_verdict text;
 v_errors integer:=0; v_unevaluable integer:=0; v_rows jsonb; v_stats jsonb; v_analysts jsonb; v_settings jsonb;
 v_offset integer:=greatest(0,least(coalesce((p_data->>'offset')::integer,0),100000));
begin
 if ctx is null then raise exception 'PQR_ACCESS_REQUIRED' using errcode='42501';end if;
 v_role:=ctx->>'role';if p_action='operation_report' then return private.pqr_operation_report();end if;
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
   if exists(select 1 from private.pqr_active_reviews where analyst_id=(p_data->>'id')::uuid and (status='in_progress' or (status='pending' and review_results<>'{}'::jsonb))) then raise exception 'El analista tiene revisiones en curso. Debe terminarlas antes de eliminarlo.';end if;
   select code_secret_id into v_secret_id from private.pqr_analysts where id=(p_data->>'id')::uuid;
   if v_secret_id is not null then perform vault.update_secret(v_secret_id,encode(extensions.gen_random_bytes(32),'hex'));end if;
   update private.pqr_analysts set deleted_at=clock_timestamp(),active=false,available=false,credentials_changed_at=clock_timestamp(),code_secret_id=null,code_hash=encode(extensions.digest(extensions.gen_random_bytes(32),'sha256'),'hex') where id=(p_data->>'id')::uuid and deleted_at is null;
   if not found then raise exception 'El analista ya fue eliminado.';end if;
   update private.pqr_active_reviews set analyst_id=null,assigned_at=null,version=version+1 where analyst_id=(p_data->>'id')::uuid and status='pending';
   update private.pqr_study_settings set analyst_id=null,updated_at=now() where analyst_id=(p_data->>'id')::uuid;
  else
   update private.pqr_analysts set deleted_at=null,active=false,available=false where id=(p_data->>'id')::uuid and deleted_at is not null;
   if not found then raise exception 'El analista no está eliminado.';end if;
  end if;
  insert into private.pqr_events(actor,action,detail) values(auth.uid(),p_action,jsonb_build_object('id',p_data->>'id'));
 elsif p_action='update_analyst' then
  if not (p_data->>'active')::boolean and exists(select 1 from private.pqr_active_reviews where analyst_id=(p_data->>'id')::uuid and status='in_progress') then raise exception 'El analista tiene revisiones en curso. Puede pausar su reparto; debe terminar esas revisiones antes de desactivarlo.';end if;
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
  if not exists(select 1 from private.pqr_active_reviews r join private.pqr_study_settings s on s.study=r.study
   where r.id=(p_data->>'id')::uuid and s.analyst_id=(p_data->>'analyst_id')::uuid) then
   raise exception 'La auditoría debe asignarse al responsable de su estudio. Cambia el responsable en Reparto por estudio.';end if;
  if not exists(select 1 from private.pqr_analysts where id=(p_data->>'analyst_id')::uuid and active and available) then raise exception 'ANALYST_UNAVAILABLE';end if;
  update private.pqr_active_reviews set analyst_id=(p_data->>'analyst_id')::uuid,assigned_at=now(),version=version+1
   where id=(p_data->>'id')::uuid and status='pending' and started_at is null and review_results='{}'::jsonb;
  if not found then raise exception 'Solo se pueden reasignar auditorías pendientes sin revisión iniciada.';end if;
  insert into private.pqr_events(review_id,actor,action,detail) values((p_data->>'id')::uuid,auth.uid(),'reassigned',jsonb_build_object('analyst_id',p_data->>'analyst_id'));
 elsif p_action in ('detail','start','save') then
  if v_role='analyst' and p_action in ('start','save') then
   perform 1 from private.pqr_analysts where id=(ctx->>'id')::uuid and active and deleted_at is null for update;
   if not found then raise exception 'PQR_ACCESS_REQUIRED' using errcode='42501';end if;
  end if;
  select * into v_review from private.pqr_active_reviews where id=(p_data->>'id')::uuid for update;
  if not found or (v_role='analyst' and v_review.analyst_id is distinct from (ctx->>'id')::uuid) then raise exception 'REVIEW_NOT_ASSIGNED' using errcode='42501';end if;
  if p_action in ('start','save') then
   if v_role<>'analyst' or v_review.status='completed' then raise exception 'REVIEW_READ_ONLY' using errcode='42501';end if;
   if p_action='start' then
    update private.pqr_active_reviews set status='in_progress',started_at=coalesce(started_at,clock_timestamp()),version=version+1 where id=v_review.id and status='pending';
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
      if coalesce(v_result->>'correct_decision','')<>'' and v_result->>'correct_decision' not in ('aplica','no_aplica') then raise exception 'INVALID_CORRECT_DECISION';end if;
      if v_result->>'evaluation'='not_evaluable' and length(btrim(coalesce(v_result->>'comment','')))<3 then raise exception 'Explica por qué la alerta no es evaluable.';end if;
      if v_result->>'evaluation'='incorrect' then v_errors:=v_errors+1;end if;
      if v_result->>'evaluation'='not_evaluable' then v_unevaluable:=v_unevaluable+1;end if;
     elsif coalesce((p_data->>'complete')::boolean,false) then raise exception 'Evalúa todas las alertas antes de completar.';end if;
    end loop;
    if coalesce((p_data->>'complete')::boolean,false) then v_verdict:=case when v_errors>0 then 'errors' when v_unevaluable>0 then 'not_evaluable' else 'correct' end;end if;
    update private.pqr_active_reviews set review_results=v_results,started_at=coalesce(started_at,clock_timestamp()),
     status=case when v_verdict is not null then 'completed' else 'in_progress' end,
     completed_at=case when v_verdict is not null then clock_timestamp() end,verdict=v_verdict,version=version+1 where id=v_review.id;
    insert into private.pqr_events(review_id,actor,action,detail) values(v_review.id,auth.uid(),case when v_verdict is null then 'draft_saved' else 'completed' end,jsonb_build_object('verdict',v_verdict));
   end if;
  end if;
  return (select (to_jsonb(r)-'source_key'-'validator_id')||jsonb_build_object('analyst_name',a.name,
   'payload',private.pqr_public_payload(r.payload),'kpis',private.pqr_public_payload(r.kpis))
   from private.pqr_active_reviews r left join private.pqr_analysts a on a.id=r.analyst_id where r.id=v_review.id);
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
 left join private.pqr_active_reviews r on r.day=v_day and (v_role<>'analyst' or r.analyst_id=(ctx->>'id')::uuid)
 group by d.eligible,d.target,d.percentage,d.refreshed_at;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.name),'[]'::jsonb) into v_analysts from (
  select a.id,a.name,a.active,a.available,a.deleted_at,count(r.id) as assigned,count(r.id) filter(where r.status='completed') as completed,
   count(r.id) filter(where r.status='in_progress') as in_progress,count(r.id) filter(where r.status='pending') as pending,
   count(r.id) filter(where r.verdict='errors') as errors,
   count(r.id) filter(where r.status='completed' and (r.completed_at at time zone 'America/Bogota')::date=r.day) as on_time,
   avg(extract(epoch from r.completed_at-r.started_at)) filter(where r.status='completed') as mean_seconds,
   (select count(*) from private.pqr_active_reviews old where old.analyst_id=a.id and old.day<v_day and old.status<>'completed') as previous_pending
  from private.pqr_analysts a left join private.pqr_active_reviews r on r.analyst_id=a.id and r.day=v_day
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
  from private.pqr_active_reviews r left join private.pqr_analysts a on a.id=r.analyst_id
  where (coalesce(p_data->>'study','all')='all' or (case when jsonb_typeof(p_data->'study')='array' then p_data->'study' else jsonb_build_array(p_data->>'study') end) ? r.study) and (v_role<>'analyst' or r.analyst_id=(ctx->>'id')::uuid)
   and (r.day=v_day or (coalesce((p_data->>'previous')::boolean,false) and r.day<v_day and r.status<>'completed'))
   and (exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(p_data->'status')='array' then p_data->'status' else jsonb_build_array(coalesce(p_data->>'status','all')) end) choice(value) where choice.value='all' or r.status=choice.value))
  order by r.day,r.risk desc,r.created_at limit case when p_action='export' then 10000 else 100 end offset case when p_action='export' then 0 else v_offset end
 ) x;
 return jsonb_build_object('context',ctx,'today',(now() at time zone 'America/Bogota')::date,'day',v_day,'stats',v_stats,
  'study_settings',(select coalesce(jsonb_agg(jsonb_build_object('study',s.study,'analyst_id',s.analyst_id,'percentage',s.percentage) order by s.study),'[]'::jsonb)
   from private.pqr_study_settings s where v_role<>'analyst' or s.analyst_id=(ctx->>'id')::uuid),
  'study_stats',case when v_role<>'analyst' then (select coalesce(jsonb_agg(to_jsonb(x) order by x.study),'[]'::jsonb) from (
   select d.study,d.analyst_id,a.name as analyst_name,d.percentage,d.eligible,d.target,
    count(r.id) as selected,count(r.id) filter(where r.analyst_id is not null) as assigned,count(r.id) filter(where r.status='completed') as completed
   from private.pqr_day_studies d left join private.pqr_analysts a on a.id=d.analyst_id
   left join private.pqr_active_reviews r on r.day=d.day and r.study=d.study where d.day=v_day
   group by d.day,d.study,a.name) x) else '[]'::jsonb end,
  'settings',case when v_role<>'analyst' then v_settings else null end,'analysts',v_analysts,'reviews',v_rows,
  'supervisors',case when v_role='admin' then (select coalesce(jsonb_agg(jsonb_build_object('id',id,'username',username,'name',name,'active',active,'deleted_at',deleted_at) order by name,username),'[]'::jsonb) from private.pqr_supervisors) else '[]'::jsonb end);
end;$function$
;

CREATE OR REPLACE FUNCTION private.qa_api(p_action text, p_data jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare ctx jsonb:=private.qa_context(); v_role text; v_day date:=(now() at time zone 'America/Bogota')::date;
 v_id uuid; v_secret_id uuid; v_code text; v_code_hash text; v_review private.qa_reviews%rowtype; v_results jsonb; v_kpi jsonb; v_result jsonb; v_verdict text;
 v_errors integer:=0; v_unevaluable integer:=0; v_rows jsonb; v_stats jsonb; v_analysts jsonb; v_settings jsonb;
 v_offset integer:=greatest(0,least(coalesce((p_data->>'offset')::integer,0),100000));
begin
 if ctx is null then raise exception 'QA_ACCESS_REQUIRED' using errcode='42501';end if;
 v_role:=ctx->>'role';if p_action='operation_report' then return private.qa_operation_report();end if;
-- specialist_study_filter_v1: scope and ordering applied before pagination.
ctx:=ctx||jsonb_build_object('kpi_specialist',v_role='analyst' and exists(select 1 from private.qa_analysts a where a.id=(ctx->>'id')::uuid and a.kpi_specialist));
if exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(p_data->'study')='array' then p_data->'study' else jsonb_build_array(coalesce(p_data->>'study','all')) end) v(value) where v.value not in ('all','Chile','Lindley','Moderno','Tradicional')) then raise exception 'Estudio invalido';end if;

if p_action='kpi_settings' then
if not exists(select 1 from private.qa_analysts where id=(p_data->>'id')::uuid and kpi_specialist and deleted_at is null) then raise exception 'Solo el especialista QA puede tener filtros por KPI.';end if;

if v_role not in ('admin','supervisor') then raise exception 'SUPERVISOR_REQUIRED' using errcode='42501';end if;
if jsonb_typeof(p_data->'patterns') is distinct from 'array' or jsonb_array_length(p_data->'patterns')>30 then raise exception 'Indica hasta 30 KPI';end if;
update private.qa_analysts set kpi_patterns=array(select distinct upper(btrim(value)) from jsonb_array_elements_text(p_data->'patterns') where length(btrim(value)) between 2 and 120) where id=(p_data->>'id')::uuid and deleted_at is null;
if not found then raise exception 'ANALYST_NOT_FOUND';end if;
perform private.qa_refresh_today();
return '{}'::jsonb;
end if;

 if p_action='context' then return ctx;end if;
 if p_action='logout' then delete from private.qa_sessions where user_id=auth.uid();return '{}'::jsonb;end if;
 if p_action in ('create_supervisor','update_supervisor','reset_supervisor_password','delete_supervisor','restore_supervisor') and v_role<>'admin' then
  raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
 if p_action in ('settings','study_settings','start_distribution','create_analyst','update_analyst','get_code','reset_code','delete_analyst','restore_analyst','reassign','create_supervisor') and v_role not in ('admin','supervisor') then
  raise exception 'QA_SUPERVISOR_REQUIRED' using errcode='42501';end if;
 if p_action in ('create_supervisor','update_supervisor','reset_supervisor_password','delete_supervisor','restore_supervisor') then return private.pqr_api(p_action,p_data); elsif p_action='start_distribution' then
  if not exists(select 1 from private.qa_study_settings s join private.qa_analysts a on a.id=s.analyst_id where a.active and a.available and a.deleted_at is null and s.percentage>0) then raise exception 'Configura al menos un estudio con un responsable disponible y un porcentaje mayor que cero.';end if;
  update private.qa_settings set auto_assign=true,updated_at=now() where singleton;
  insert into private.qa_events(actor,action) values(auth.uid(),'distribution_enabled');
 elsif p_action='study_settings' then
  -- Serialize configuration with sampling and assignment of today's cohort.
  perform pg_advisory_xact_lock(186322,v_day-date '2026-01-01');
  if jsonb_typeof(p_data->'studies') is distinct from 'array' then raise exception 'Indica los cuatro estudios y sus porcentajes.';end if;
  if jsonb_array_length(p_data->'studies')<>4 or
   (select count(distinct x->>'study') from jsonb_array_elements(p_data->'studies') x where x->>'study' in ('Chile','Tradicional','Moderno','Lindley'))<>4 then
   raise exception 'Configura una sola vez cada estudio: Chile, Tradicional CAM, Moderno CAM y Lindley.';end if;
  if exists(select 1 from jsonb_array_elements(p_data->'studies') x
   where jsonb_typeof(x->'percentage') is distinct from 'number' or (x->>'percentage')::numeric not between 0 and 100) then
   raise exception 'Cada porcentaje debe estar entre 0 y 100.';end if;
  if exists(select 1 from jsonb_array_elements(p_data->'studies') x where nullif(x->>'analyst_id','') is not null
   and not exists(select 1 from private.qa_analysts a where a.id=(x->>'analyst_id')::uuid and a.deleted_at is null)) then
   raise exception 'Selecciona un analista del equipo actual para cada estudio.';end if;
  if jsonb_typeof(p_data->'percentage') is distinct from 'number' or (p_data->>'percentage')::numeric not between 1 and 100 then raise exception 'Indica un porcentaje QA entre 1 y 100.';end if;
  update private.qa_settings set percentage=(p_data->>'percentage')::numeric,updated_at=now() where singleton;
  
  if exists(select 1 from jsonb_array_elements(p_data->'studies') x where x ? 'secondary_analyst_id') then
   if exists(select 1 from jsonb_array_elements(p_data->'studies') x where nullif(x->>'secondary_analyst_id','') is not null and (nullif(x->>'analyst_id','') is null or x->>'analyst_id'=x->>'secondary_analyst_id' or not exists(select 1 from private.qa_analysts a where a.id=(x->>'secondary_analyst_id')::uuid and a.deleted_at is null and not a.kpi_specialist))) then raise exception 'Selecciona dos analistas distintos. El especialista por KPI no puede compartir un estudio.';end if;
   if exists(select 1 from jsonb_array_elements(p_data->'studies') x join private.qa_analysts a on a.id=nullif(x->>'analyst_id','')::uuid where a.kpi_specialist) then raise exception 'El especialista conserva su reparto por KPI.';end if;
   delete from private.qa_study_partners p using jsonb_array_elements(p_data->'studies') x where p.study=x->>'study' and x ? 'secondary_analyst_id';
   insert into private.qa_study_partners(study,analyst_id,position) select x->>'study',(case when pos=1 then x->>'analyst_id' else x->>'secondary_analyst_id' end)::uuid,pos from jsonb_array_elements(p_data->'studies') x cross join generate_series(1,2) pos where x ? 'secondary_analyst_id' and nullif(x->>'secondary_analyst_id','') is not null;
  end if;
update private.qa_study_settings s set analyst_id=nullif(x->>'analyst_id','')::uuid,
   percentage=(p_data->>'percentage')::numeric,updated_at=now() from jsonb_array_elements(p_data->'studies') x where s.study=x->>'study';
  insert into private.qa_events(actor,action,detail) values(auth.uid(),'study_settings_changed',p_data);
 elsif p_action='settings' then
  raise exception 'Configura el responsable y porcentaje de cada estudio desde Reparto por estudio.';
 elsif p_action='create_analyst' then
  if length(btrim(coalesce(p_data->>'name','')))<2 then raise exception 'Indica el nombre del analista.';end if;
  select 'QA-'||string_agg(substr('23456789ABCDEFGHJKLMNQASTUVWXYZ',1+(get_byte(entropy.bytes,i)%32),1),'' order by i)
   into v_code from (select extensions.gen_random_bytes(12) bytes) entropy cross join generate_series(0,11) i;
  insert into private.qa_analysts(name,code_hash,code_secret_id) values(left(btrim(p_data->>'name'),120),encode(extensions.digest(v_code,'sha256'),'hex'),vault.create_secret(v_code,null,'QA analyst access code')) returning id into v_id;
  insert into private.qa_events(actor,action,detail) values(auth.uid(),'analyst_created',jsonb_build_object('id',v_id));
  perform private.qa_refresh_today();return jsonb_build_object('id',v_id,'code',v_code);
 elsif p_action in ('delete_analyst','restore_analyst') then
  -- Serialize deletion with today's automatic distributor and review starts.
  perform pg_advisory_xact_lock(186322,v_day-date '2026-01-01');
  perform 1 from private.qa_analysts where id=(p_data->>'id')::uuid for update;
  if not found then raise exception 'ANALYST_NOT_FOUND';end if;
  if p_action='delete_analyst' then
   if exists(select 1 from private.qa_reviews where analyst_id=(p_data->>'id')::uuid and (status='in_progress' or (status='pending' and review_results<>'{}'::jsonb))) then raise exception 'El analista tiene revisiones en curso. Debe terminarlas antes de eliminarlo.';end if;
   select code_secret_id into v_secret_id from private.qa_analysts where id=(p_data->>'id')::uuid;
   if v_secret_id is not null then perform vault.update_secret(v_secret_id,encode(extensions.gen_random_bytes(32),'hex'));end if;
   update private.qa_analysts set deleted_at=clock_timestamp(),active=false,available=false,credentials_changed_at=clock_timestamp(),code_secret_id=null,code_hash=encode(extensions.digest(extensions.gen_random_bytes(32),'sha256'),'hex') where id=(p_data->>'id')::uuid and deleted_at is null;
   if not found then raise exception 'El analista ya fue eliminado.';end if;
   update private.qa_reviews set analyst_id=null,assigned_at=null,version=version+1 where analyst_id=(p_data->>'id')::uuid and status='pending';
   update private.qa_study_settings set analyst_id=null,updated_at=now() where analyst_id=(p_data->>'id')::uuid;
  else
   update private.qa_analysts set deleted_at=null,active=false,available=false where id=(p_data->>'id')::uuid and deleted_at is not null;
   if not found then raise exception 'El analista no está eliminado.';end if;
  end if;
  insert into private.qa_events(actor,action,detail) values(auth.uid(),p_action,jsonb_build_object('id',p_data->>'id'));
 elsif p_action='update_analyst' then
  if not (p_data->>'active')::boolean and exists(select 1 from private.qa_reviews where analyst_id=(p_data->>'id')::uuid and status='in_progress') then raise exception 'El analista tiene revisiones en curso. Puede pausar su reparto; debe terminar esas revisiones antes de desactivarlo.';end if;
  update private.qa_analysts set credentials_changed_at=case when active is distinct from (p_data->>'active')::boolean then clock_timestamp() else credentials_changed_at end,active=(p_data->>'active')::boolean,available=(p_data->>'available')::boolean where id=(p_data->>'id')::uuid and deleted_at is null;
  if not found then raise exception 'ANALYST_NOT_FOUND';end if;
  insert into private.qa_events(actor,action,detail) values(auth.uid(),'analyst_updated',p_data);
 elsif p_action='get_code' then
  select code_secret_id,code_hash into v_secret_id,v_code_hash from private.qa_analysts where id=(p_data->>'id')::uuid and deleted_at is null for update;
  if not found then raise exception 'ANALYST_NOT_FOUND';end if;
  select decrypted_secret into v_code from vault.decrypted_secrets where id=v_secret_id;
  if v_code is null or encode(extensions.digest(v_code,'sha256'),'hex') is distinct from v_code_hash then return jsonb_build_object('requires_new_code',true);end if;
  insert into private.qa_events(actor,action,detail) values(auth.uid(),'analyst_code_copied',jsonb_build_object('id',p_data->>'id'));
  return jsonb_build_object('code',v_code);
 elsif p_action='reset_code' then
  select code_secret_id into v_secret_id from private.qa_analysts where id=(p_data->>'id')::uuid and deleted_at is null for update;
  if not found then raise exception 'ANALYST_NOT_FOUND';end if;
  select 'QA-'||string_agg(substr('23456789ABCDEFGHJKLMNQASTUVWXYZ',1+(get_byte(entropy.bytes,i)%32),1),'' order by i)
   into v_code from (select extensions.gen_random_bytes(12) bytes) entropy cross join generate_series(0,11) i;
  if v_secret_id is null then v_secret_id:=vault.create_secret(v_code,null,'QA analyst access code');
  else perform vault.update_secret(v_secret_id,v_code);end if;
  update private.qa_analysts set code_hash=encode(extensions.digest(v_code,'sha256'),'hex'),code_secret_id=v_secret_id,credentials_changed_at=clock_timestamp() where id=(p_data->>'id')::uuid and deleted_at is null;
  if not found then raise exception 'ANALYST_NOT_FOUND';end if;
  insert into private.qa_events(actor,action,detail) values(auth.uid(),'analyst_code_reset',jsonb_build_object('id',p_data->>'id'));
  return jsonb_build_object('code',v_code);
 elsif p_action='reassign' then
  perform pg_advisory_xact_lock(186322,v_day-date '2026-01-01');
  if not exists(select 1 from private.qa_reviews r join private.qa_study_settings s on s.study=r.study
   where r.id=(p_data->>'id')::uuid and s.analyst_id=(p_data->>'analyst_id')::uuid) then
   raise exception 'La auditoría debe asignarse al responsable de su estudio. Cambia el responsable en Reparto por estudio.';end if;
  if not exists(select 1 from private.qa_analysts where id=(p_data->>'analyst_id')::uuid and active and available) then raise exception 'ANALYST_UNAVAILABLE';end if;
  update private.qa_reviews set analyst_id=(p_data->>'analyst_id')::uuid,assigned_at=now(),version=version+1
   where id=(p_data->>'id')::uuid and status='pending' and started_at is null and review_results='{}'::jsonb;
  if not found then raise exception 'Solo se pueden reasignar auditorías pendientes sin revisión iniciada.';end if;
  insert into private.qa_events(review_id,actor,action,detail) values((p_data->>'id')::uuid,auth.uid(),'reassigned',jsonb_build_object('analyst_id',p_data->>'analyst_id'));
 elsif p_action in ('detail','start','save') then
  if v_role='analyst' and p_action in ('start','save') then
   perform 1 from private.qa_analysts where id=(ctx->>'id')::uuid and active and deleted_at is null for update;
   if not found then raise exception 'QA_ACCESS_REQUIRED' using errcode='42501';end if;
  end if;
  select * into v_review from private.qa_reviews where id=(p_data->>'id')::uuid for update;
  if not found or (v_role='analyst' and v_review.analyst_id is distinct from (ctx->>'id')::uuid) then raise exception 'REVIEW_NOT_ASSIGNED' using errcode='42501';end if;
  if p_action in ('start','save') then
   if v_role<>'analyst' or v_review.status='completed' then raise exception 'REVIEW_READ_ONLY' using errcode='42501';end if;
   if p_action='start' then
    update private.qa_reviews set status='in_progress',started_at=coalesce(started_at,clock_timestamp()),version=version+1 where id=v_review.id and status='pending';
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
      if coalesce(v_result->>'correct_decision','')<>'' and v_result->>'correct_decision' not in ('aplica','no_aplica') then raise exception 'INVALID_CORRECT_DECISION';end if;
      if v_result->>'evaluation'='not_evaluable' and length(btrim(coalesce(v_result->>'comment','')))<3 then raise exception 'Explica por qué la alerta no es evaluable.';end if;
      if v_result->>'evaluation'='incorrect' then v_errors:=v_errors+1;end if;
      if v_result->>'evaluation'='not_evaluable' then v_unevaluable:=v_unevaluable+1;end if;
     elsif coalesce((p_data->>'complete')::boolean,false) then raise exception 'Evalúa todas las alertas antes de completar.';end if;
    end loop;
    if coalesce((p_data->>'complete')::boolean,false) then v_verdict:=case when v_errors>0 then 'errors' when v_unevaluable>0 then 'not_evaluable' else 'correct' end;end if;
    update private.qa_reviews set review_results=v_results,started_at=coalesce(started_at,clock_timestamp()),
     status=case when v_verdict is not null then 'completed' else 'in_progress' end,
     completed_at=case when v_verdict is not null then clock_timestamp() end,verdict=v_verdict,version=version+1 where id=v_review.id;
    insert into private.qa_events(review_id,actor,action,detail) values(v_review.id,auth.uid(),case when v_verdict is null then 'draft_saved' else 'completed' end,jsonb_build_object('verdict',v_verdict));
   end if;
  end if;
  return (select (to_jsonb(r)-'source_key'-'validator_id')||jsonb_build_object('analyst_name',a.name,
   'payload',private.qa_public_payload(r.payload),'kpis',private.qa_public_payload(r.kpis))
   from private.qa_reviews r left join private.qa_analysts a on a.id=r.analyst_id where r.id=v_review.id);
 elsif p_action not in ('dashboard','export') then raise exception 'UNKNOWN_QA_ACTION';end if;

 perform private.qa_refresh_today();
 -- Late work remains attached to its original day; never reset its deadline.
 if p_data ? 'day' and coalesce(p_data->>'day','')<>'' then v_day:=(p_data->>'day')::date;end if;
 select to_jsonb(s) into v_settings from private.qa_settings s;
 select jsonb_build_object('eligible',coalesce(d.eligible,0),'target',coalesce(d.target,0),'percentage',d.percentage,'percentage_mode','alerts',
  'selected',count(r.id),'assigned',count(r.id) filter(where r.analyst_id is not null),'completed',count(r.id) filter(where r.status='completed'),
  'on_time',count(r.id) filter(where r.status='completed' and (r.completed_at at time zone 'America/Bogota')::date=r.day),
  'overdue',count(r.id) filter(where r.status<>'completed' and r.day<(now() at time zone 'America/Bogota')::date),
  'errors',count(r.id) filter(where r.verdict='errors'),'not_evaluable',count(r.id) filter(where r.verdict='not_evaluable'),
  'mean_seconds',avg(extract(epoch from r.completed_at-r.started_at)) filter(where r.status='completed'),
  'refreshed_at',d.refreshed_at) into v_stats
 from (select * from private.qa_days where day=v_day) d right join (select v_day as day) x on true
 left join private.qa_reviews r on r.day=v_day and (v_role<>'analyst' or r.analyst_id=(ctx->>'id')::uuid)
 group by d.eligible,d.target,d.percentage,d.refreshed_at;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.name),'[]'::jsonb) into v_analysts from (
  select a.id,a.name,a.kpi_specialist,a.kpi_patterns,a.active,a.available,a.deleted_at,count(r.id) as assigned,count(r.id) filter(where r.status='completed') as completed,
   count(r.id) filter(where r.status='in_progress') as in_progress,count(r.id) filter(where r.status='pending') as pending,
   count(r.id) filter(where r.verdict='errors') as errors,
   count(r.id) filter(where r.status='completed' and (r.completed_at at time zone 'America/Bogota')::date=r.day) as on_time,
   avg(extract(epoch from r.completed_at-r.started_at)) filter(where r.status='completed') as mean_seconds,
   (select count(*) from private.qa_reviews old where old.analyst_id=a.id and old.day<v_day and old.status<>'completed') as previous_pending
  from private.qa_analysts a left join private.qa_reviews r on r.analyst_id=a.id and r.day=v_day
  where v_role<>'analyst' or a.id=(ctx->>'id')::uuid group by a.id
 ) x;
 select coalesce(jsonb_agg(to_jsonb(x) order by case when ctx->>'kpi_specialist'='true' then x.study end,case when ctx->>'kpi_specialist'='true' then x.external_id end,x.day,x.risk desc,x.created_at,x.id),'[]'::jsonb) into v_rows from (
  select r.kpis->0->>'name' as alert_name,r.id,r.day,r.external_id,r.study,r.country,r.validator_name,r.analyst_id,a.name as analyst_name,r.alert_count,r.invalid_count,r.risk,r.reasons,r.selection,r.assigned_at,
   r.original_completed_at,r.original_sla_seconds,r.status,r.started_at,r.completed_at,r.verdict,r.version,r.created_at,
   r.day<(now() at time zone 'America/Bogota')::date and r.status<>'completed' as overdue,
   r.status='completed' and (r.completed_at at time zone 'America/Bogota')::date=r.day as on_time,
   case when p_action='export' then private.qa_public_payload(r.kpis) end as kpis,
   case when p_action='export' then r.original_results end as original_results,
   case when p_action='export' then r.review_results end as review_results
  from private.qa_reviews r left join private.qa_analysts a on a.id=r.analyst_id
  where (exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(p_data->'study')='array' then p_data->'study' else jsonb_build_array(coalesce(p_data->>'study','all')) end) choice(value) where choice.value='all' or r.study=choice.value)) and (v_role<>'analyst' or r.analyst_id=(ctx->>'id')::uuid)
   and (r.day=v_day or (coalesce((p_data->>'previous')::boolean,false) and r.day<v_day and r.status<>'completed'))
   and (exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(p_data->'status')='array' then p_data->'status' else jsonb_build_array(coalesce(p_data->>'status','all')) end) choice(value) where choice.value='all' or r.status=choice.value))
  order by case when ctx->>'kpi_specialist'='true' then r.study end,case when ctx->>'kpi_specialist'='true' then r.external_id end,r.day,r.risk desc,r.created_at,r.id limit case when p_action='export' then 10000 else 100 end offset case when p_action='export' then 0 else v_offset end
 ) x;
 return jsonb_build_object('context',ctx,'today',(now() at time zone 'America/Bogota')::date,'day',v_day,'stats',v_stats,
  'specialist_progress',case when ctx->>'kpi_specialist'='true' then (select jsonb_agg(to_jsonb(g) order by g.label) from (select groups.label,count(r.id) as assigned,count(r.id) filter(where r.status='completed') as completed,count(r.id) filter(where r.status='in_progress') as in_progress,count(r.id) filter(where r.status='pending') as pending,(select count(*) from private.qa_reviews old where old.analyst_id=(ctx->>'id')::uuid and old.day<v_day and old.status<>'completed' and old.study=any(groups.studies)) as previous_pending from (values ('CAM',array['Moderno','Tradicional']),('Lindley',array['Lindley']),('Chile',array['Chile'])) groups(label,studies) left join private.qa_reviews r on r.analyst_id=(ctx->>'id')::uuid and r.day=v_day and r.study=any(groups.studies) group by groups.label,groups.studies) g) else '[]'::jsonb end,'study_settings',private.qa_visible_studies(ctx), 'study_stats',case when v_role<>'analyst' then (select coalesce(jsonb_agg(to_jsonb(x) order by x.study),'[]'::jsonb) from (
   select d.study,d.analyst_id,coalesce((select string_agg(x.name,' / ' order by p.position) from private.qa_study_partners p join private.qa_analysts x on x.id=p.analyst_id where p.study=d.study),a.name) as analyst_name,d.percentage,d.eligible,d.target,
    count(r.id) as selected,count(r.id) filter(where r.analyst_id is not null) as assigned,count(r.id) filter(where r.status='completed') as completed
   from private.qa_day_studies d left join private.qa_analysts a on a.id=d.analyst_id
   left join private.qa_reviews r on r.day=d.day and r.study=d.study where d.day=v_day
   group by d.day,d.study,a.name) x) else '[]'::jsonb end,
  'settings',case when v_role<>'analyst' then v_settings else null end,'analysts',v_analysts,'reviews',v_rows,
  'supervisors',case when v_role='admin' then (select coalesce(jsonb_agg(jsonb_build_object('id',id,'username',username,'name',name,'active',active,'deleted_at',deleted_at) order by name,username),'[]'::jsonb) from private.pqr_supervisors) else '[]'::jsonb end);
end;$function$
;
