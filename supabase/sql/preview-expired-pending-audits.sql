-- Consulta de solo lectura para revisar el alcance antes de la limpieza.
-- Usa la fecha operativa de Nicaragua, igual que el portal.
with cutoff as (
  select (now() at time zone 'America/Managua')::date as operation_day
)
select
  b.id as batch_id,
  b.operation_date,
  b.study_id,
  b.country_id,
  b.module,
  b.status as batch_status,
  count(*) filter (where a.status = 'completada') as completed_kept,
  count(*) filter (where a.status <> 'completada') as unfinished_to_delete
from public.upload_batches b
join public.audits a on a.batch_id = b.id
cross join cutoff
where b.status in ('active', 'archived')
  and b.operation_date < cutoff.operation_day
group by b.id, b.operation_date, b.study_id, b.country_id, b.module, b.status
having count(*) filter (where a.status <> 'completada') > 0
order by b.operation_date desc, b.id desc;
