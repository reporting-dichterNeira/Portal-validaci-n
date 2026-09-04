-- The monthly note export now provides the final score from the previous
-- measurement and the current measurement in the same file. Keep both values
-- per PDV/sub-KPI so the Operations visualization can report their variation.

alter table public.admin_note_score_records
  add column if not exists previous_total_score numeric(12,4),
  add column if not exists current_total_score numeric(12,4);

-- "Nota de PDV" in the general-alert export gives an additional contextual
-- link to the score export when supervisors upload the monthly consolidates.
alter table public.admin_alert_export_records
  add column if not exists pdv_note numeric(12,4);

create index if not exists admin_note_score_records_month_study_idx
  on public.admin_note_score_records (period_month, study);
