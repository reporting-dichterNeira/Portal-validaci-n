-- Conserva el detalle de preguntas editadas del export mensual de ediciones.
alter table public.admin_edit_export_records
  add column if not exists question_detail text;
