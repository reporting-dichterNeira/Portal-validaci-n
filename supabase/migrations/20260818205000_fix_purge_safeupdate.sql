-- Supabase enables pg-safeupdate, so administrative bulk deletes must include
-- an explicit WHERE clause even when the function already validates the admin.

create or replace function public.purge_all_audit_data(p_confirmation text)
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

  if p_confirmation is distinct from 'ELIMINAR PRUEBAS' then
    raise exception 'INVALID_PURGE_CONFIRMATION' using errcode = '22023';
  end if;

  delete from public.audits
  where id is not null;
  get diagnostics v_audits_deleted = row_count;

  delete from public.upload_batches
  where id is not null;
  get diagnostics v_batches_deleted = row_count;

  return jsonb_build_object(
    'audits_deleted', v_audits_deleted,
    'batches_deleted', v_batches_deleted
  );
end;
$$;

revoke all on function public.purge_all_audit_data(text) from public, anon;
grant execute on function public.purge_all_audit_data(text) to authenticated;
