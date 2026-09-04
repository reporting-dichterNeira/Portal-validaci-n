-- The Notes PDV export contains the sub-KPI result for the present and prior
-- measurement.  Store both values to identify the greatest absolute change
-- for each PDV in the visualization.

alter table public.admin_note_score_records
  add column if not exists previous_subkpi_score numeric(12,4),
  add column if not exists current_subkpi_score numeric(12,4);
