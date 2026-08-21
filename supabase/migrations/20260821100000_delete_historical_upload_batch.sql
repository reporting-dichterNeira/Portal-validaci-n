-- Allow only administrators to remove a single imported file and every audit
-- that belongs to it. The explicit batch id keeps this operation scoped.

create or replace function public.delete_upload_batch(
  p_batch_id bigint,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_audits_deleted integer := 0;
  v_batches_deleted integer := 0;
begin
  if (select auth.uid()) is null or not (select private.is_admin()) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  if p_batch_id is null or p_batch_id < 1 then
    raise exception 'INVALID_UPLOAD_BATCH' using errcode = '22023';
  end if;

  if p_confirmation is distinct from format('ELIMINAR ARCHIVO %s', p_batch_id) then
    raise exception 'INVALID_BATCH_DELETE_CONFIRMATION' using errcode = '22023';
  end if;

  if not exists (select 1 from public.upload_batches where id = p_batch_id) then
    raise exception 'UPLOAD_BATCH_NOT_FOUND' using errcode = 'P0002';
  end if;

  delete from public.audits
  where batch_id = p_batch_id;
  get diagnostics v_audits_deleted = row_count;

  delete from public.upload_batches
  where id = p_batch_id;
  get diagnostics v_batches_deleted = row_count;

  return jsonb_build_object(
    'batch_id', p_batch_id,
    'audits_deleted', v_audits_deleted,
    'batches_deleted', v_batches_deleted
  );
end;
$$;

revoke all on function public.delete_upload_batch(bigint, text) from public, anon;
grant execute on function public.delete_upload_batch(bigint, text) to authenticated;
