-- Deleting an imported statement must remove the canonical lines it created and
-- every Workbench record derived from them, in one transaction. Two invariants
-- are protected:
--   1. Workbench never silently orphans a real Xero entity. If any line from the
--      import has a live Xero object, the whole deletion is refused.
--   2. Only the lines of this import's ingestion run are removed. Lines that
--      deduplicated against an earlier import belong to that import and stay.
-- The function returns the storage keys and line ids the caller must clean up,
-- because private object storage is outside the database transaction.

create or replace function public.delete_statement_import(
  p_import_id uuid,
  p_user_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  import_row public.statement_imports;
  member_role text;
  live_xero_lines integer := 0;
  target_lines uuid[] := '{}';
  touched_sets uuid[] := '{}';
  reopened_lines uuid[] := '{}';
  storage_keys text[] := '{}';
  deleted_lines integer := 0;
begin
  select * into import_row from public.statement_imports where id = p_import_id for update;
  if import_row.id is null then
    raise exception 'Statement import not found' using errcode = 'P0002';
  end if;

  select role into member_role from public.company_memberships
   where company_id = import_row.company_id and user_id = p_user_id;
  if member_role is null or member_role not in ('owner', 'bookkeeper') then
    raise exception 'Only an owner or bookkeeper can delete a statement' using errcode = '42501';
  end if;

  -- A worker holding a live lease may still commit lines for this import.
  if import_row.status = 'processing'
     and import_row.lease_expires_at is not null
     and import_row.lease_expires_at > now() then
    raise exception 'Workbench is still reading this statement' using errcode = '55006';
  end if;

  if import_row.ingestion_run_id is not null then
    select coalesce(array_agg(id), '{}') into target_lines
      from public.statement_lines
     where ingestion_run_id = import_row.ingestion_run_id
       and company_id = import_row.company_id;
  end if;

  if array_length(target_lines, 1) > 0 then
    select coalesce(array_agg(distinct member.candidate_set_id), '{}') into touched_sets
      from public.candidate_set_lines member
     where member.statement_line_id = any(target_lines);
  end if;

  if array_length(touched_sets, 1) > 0 then
    select count(distinct member.statement_line_id) into live_xero_lines
      from public.candidate_set_lines member
      join public.xero_objects object on object.candidate_set_id = member.candidate_set_id
     where member.candidate_set_id = any(touched_sets)
       and member.statement_line_id = any(target_lines)
       and object.deleted_at is null;

    if live_xero_lines > 0 then
      raise exception '% line(s) from this statement already have a Xero entity. Delete or void the Xero record first.', live_xero_lines
        using errcode = '23503';
    end if;

    -- The other side of a transfer survives the deletion and returns to `new`.
    select coalesce(array_agg(distinct member.statement_line_id), '{}') into reopened_lines
      from public.candidate_set_lines member
     where member.candidate_set_id = any(touched_sets)
       and not (member.statement_line_id = any(target_lines));
  end if;

  -- Collect private files before the rows that name them disappear.
  storage_keys := array[import_row.storage_key];
  if array_length(target_lines, 1) > 0 then
    storage_keys := storage_keys || coalesce(
      (select array_agg(storage_key) from public.documents where statement_line_id = any(target_lines)),
      '{}'
    );
  end if;

  if array_length(reopened_lines, 1) > 0 then
    update public.statement_lines set
      status = 'new',
      active_candidate_set_id = null,
      status_version = status_version + 1,
      note = 'The paired statement was deleted. This line is waiting for analysis again.',
      updated_at = now()
    where id = any(reopened_lines);

    insert into public.line_events(company_id, statement_line_id, from_status, to_status, reason, source, actor_user_id, metadata)
    select company_id, id, status, 'new', 'Paired statement import deleted', 'user', p_user_id,
           jsonb_build_object('statementImportId', p_import_id)
      from public.statement_lines where id = any(reopened_lines);
  end if;

  if array_length(touched_sets, 1) > 0 then
    -- candidate_set_lines.statement_line_id is RESTRICT on purpose; clear the
    -- membership rows before the lines they protect.
    delete from public.candidate_set_lines where candidate_set_id = any(touched_sets);
    delete from public.xero_objects where candidate_set_id = any(touched_sets);
    update public.statement_lines set active_candidate_set_id = null
     where active_candidate_set_id = any(touched_sets);
    delete from public.candidate_sets where id = any(touched_sets);
  end if;

  if array_length(target_lines, 1) > 0 then
    -- documents, line_events and agent_analysis_jobs cascade from the line.
    delete from public.statement_lines where id = any(target_lines);
    get diagnostics deleted_lines = row_count;
  end if;

  delete from public.statement_imports where id = p_import_id;

  if import_row.ingestion_run_id is not null then
    -- agent_analysis_batches cascade from the ingestion run.
    delete from public.ingestion_runs where id = import_row.ingestion_run_id;
  end if;

  return jsonb_build_object(
    'importId', p_import_id,
    'companyId', import_row.company_id,
    'filename', import_row.filename,
    'deletedLines', deleted_lines,
    'reopenedLines', coalesce(array_length(reopened_lines, 1), 0),
    'lineIds', to_jsonb(target_lines),
    'storageKeys', to_jsonb(storage_keys)
  );
end $$;

revoke all on function public.delete_statement_import(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_statement_import(uuid, uuid) to service_role;
