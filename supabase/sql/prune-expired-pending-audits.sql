-- Ejecutar SOLO en el proyecto ValidaFlow de reporting, después de revisar
-- preview-expired-pending-audits.sql y contar con una copia de seguridad.
-- Elimina únicamente auditorías no completadas de jornadas anteriores.
-- No elimina validadores, auditorías completadas ni bases cargadas.
begin;

create or replace function private.prune_pending_when_new_batch_activates()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_batch record;
  removed_count integer;
begin
  if old.status <> 'draft' or new.status <> 'active' then
    return new;
  end if;

  -- Una versión antigua del portal no debe volver a arrastrar pendientes.
  if new.carried_over_count > 0 then
    raise exception 'CARRYOVER_DISABLED' using errcode = '22023';
  end if;

  for previous_batch in
    select b.id
    from public.upload_batches b
    where b.module = new.module
      and b.study_id = new.study_id
      and b.country_id is not distinct from new.country_id
      and b.operation_date < new.operation_date
      and b.status in ('active', 'archived')
      and exists (
        select 1 from public.audits a
        where a.batch_id = b.id
          and a.status <> 'completada'::public.audit_status
      )
  loop
    delete from public.audits a
    where a.batch_id = previous_batch.id
      and a.status <> 'completada'::public.audit_status;
    get diagnostics removed_count = row_count;

    if removed_count > 0 then
      update public.upload_batches b
      set row_count = (select count(*)::integer from public.audits a where a.batch_id = b.id)
      where b.id = previous_batch.id;
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function private.prune_pending_when_new_batch_activates() from public, anon, authenticated;

drop trigger if exists upload_batches_prune_expired_pending on public.upload_batches;
create trigger upload_batches_prune_expired_pending
after update of status on public.upload_batches
for each row
when (old.status = 'draft' and new.status = 'active')
execute function private.prune_pending_when_new_batch_activates();

-- Limpieza retroactiva, limitada a bases históricas activas o archivadas.
do $$
declare
  previous_batch record;
  removed_count integer;
  operation_day date := (now() at time zone 'America/Managua')::date;
begin
  for previous_batch in
    select b.id
    from public.upload_batches b
    where b.status in ('active', 'archived')
      and b.operation_date < operation_day
      and exists (
        select 1 from public.audits a
        where a.batch_id = b.id
          and a.status <> 'completada'::public.audit_status
      )
  loop
    delete from public.audits a
    where a.batch_id = previous_batch.id
      and a.status <> 'completada'::public.audit_status;
    get diagnostics removed_count = row_count;

    if removed_count > 0 then
      update public.upload_batches b
      set row_count = (select count(*)::integer from public.audits a where a.batch_id = b.id)
      where b.id = previous_batch.id;
    end if;
  end loop;
end;
$$;

commit;

-- Verificación posterior: debe devolver 0.
select count(*) as expired_unfinished_remaining
from public.audits a
join public.upload_batches b on b.id = a.batch_id
where b.status in ('active', 'archived')
  and b.operation_date < (now() at time zone 'America/Managua')::date
  and a.status <> 'completada'::public.audit_status;
