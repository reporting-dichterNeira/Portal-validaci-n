-- The source export may include intermediate or scaled scores (for example
-- 0.67, 2, or 100). They must be retained so the month-to-month comparison
-- can still identify the exact 0 -> 1 and 1 -> 0 transitions.

alter table public.admin_note_score_records
  drop constraint if exists admin_note_score_records_score_check;
