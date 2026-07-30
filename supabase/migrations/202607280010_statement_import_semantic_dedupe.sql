-- Statement uploads must deduplicate against every existing line, including
-- lines created by the retired CSV importer whose hash format was different.
-- Compare canonical bookkeeping fields and preserve the multiplicity of
-- genuinely repeated identical transactions.

create or replace function public.commit_statement_import(
  p_import_id uuid,
  p_confirm_profile boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  import_row public.statement_imports;
  ingestion_id uuid;
  inserted_count integer := 0;
  total_count integer := 0;
begin
  select * into import_row from public.statement_imports where id = p_import_id for update;
  if import_row.id is null then raise exception 'Statement import not found'; end if;
  if auth.role() <> 'service_role' and not public.is_company_member(import_row.company_id) then
    raise exception 'Company access required';
  end if;
  if import_row.status = 'complete' then
    return jsonb_build_object('status', 'complete', 'imported', import_row.imported_count, 'duplicates', import_row.duplicate_count);
  end if;
  if import_row.status <> 'awaiting_confirmation' then raise exception 'Statement is not ready to import'; end if;
  if coalesce((import_row.validation->>'valid')::boolean, false) is not true then raise exception 'Statement extraction is not verified'; end if;

  -- Serialise commits for one bank account so two overlapping files cannot
  -- both observe the same pre-insert multiplicity.
  perform 1 from public.bank_accounts account
  where account.id = import_row.bank_account_id and account.company_id = import_row.company_id
  for update;
  if not found then raise exception 'Bank account not found'; end if;

  insert into public.ingestion_runs(company_id, bank_account_id, source, source_file_name, status, created_by)
  values (import_row.company_id, import_row.bank_account_id, 'statement_upload', import_row.filename, 'processing', import_row.created_by)
  returning id into ingestion_id;

  with incoming as (
    select
      item,
      ordinality,
      row_number() over (
        partition by
          item->>'postedAt',
          (item->>'amountMinor')::bigint,
          lower(regexp_replace(btrim(coalesce(item->>'payee', '')), '[[:space:]]+', ' ', 'g')),
          lower(regexp_replace(btrim(item->>'description'), '[[:space:]]+', ' ', 'g')),
          lower(regexp_replace(btrim(coalesce(item->>'reference', '')), '[[:space:]]+', ' ', 'g'))
        order by ordinality
      )::integer as signature_occurrence
    from jsonb_array_elements(import_row.extraction->'transactions') with ordinality as source(item, ordinality)
  ), existing as (
    select
      line.posted_at::text as posted_at,
      line.amount_minor,
      lower(regexp_replace(btrim(line.payee), '[[:space:]]+', ' ', 'g')) as payee,
      lower(regexp_replace(btrim(line.description), '[[:space:]]+', ' ', 'g')) as description,
      lower(regexp_replace(btrim(line.reference), '[[:space:]]+', ' ', 'g')) as reference,
      count(*)::integer as signature_count
    from public.statement_lines line
    where line.bank_account_id = import_row.bank_account_id
    group by 1, 2, 3, 4, 5
  ), novel as (
    select incoming.*
    from incoming
    left join existing on
      existing.posted_at = incoming.item->>'postedAt'
      and existing.amount_minor = (incoming.item->>'amountMinor')::bigint
      and existing.payee = lower(regexp_replace(btrim(coalesce(incoming.item->>'payee', '')), '[[:space:]]+', ' ', 'g'))
      and existing.description = lower(regexp_replace(btrim(incoming.item->>'description'), '[[:space:]]+', ' ', 'g'))
      and existing.reference = lower(regexp_replace(btrim(coalesce(incoming.item->>'reference', '')), '[[:space:]]+', ' ', 'g'))
    where incoming.signature_occurrence > coalesce(existing.signature_count, 0)
  )
  insert into public.statement_lines(
    company_id, bank_account_id, ingestion_run_id, posted_at, amount_minor, currency,
    payee, description, reference, source_line_id, dedupe_key, occurrence, status, note
  )
  select
    import_row.company_id,
    import_row.bank_account_id,
    ingestion_id,
    (item->>'postedAt')::date,
    (item->>'amountMinor')::bigint,
    'GBP',
    coalesce(item->>'payee', ''),
    item->>'description',
    coalesce(item->>'reference', ''),
    item->>'sourceLocator',
    item->>'dedupeKey',
    signature_occurrence,
    'new',
    'Imported from a verified bank statement and waiting for analysis.'
  from novel
  on conflict (bank_account_id, dedupe_key) do nothing;
  get diagnostics inserted_count = row_count;
  total_count := jsonb_array_length(import_row.extraction->'transactions');

  update public.ingestion_runs set status = 'complete', imported_count = inserted_count,
    completed_at = now() where id = ingestion_id;
  update public.statement_imports set status = 'complete', ingestion_run_id = ingestion_id,
    imported_count = inserted_count, duplicate_count = total_count - inserted_count,
    completed_at = now(), updated_at = now() where id = import_row.id;

  if p_confirm_profile then
    insert into public.statement_import_profiles(
      bank_account_id, company_id, institution, account_name, account_identifier, confirmed_by
    ) values (
      import_row.bank_account_id, import_row.company_id, import_row.detected_institution,
      import_row.detected_account_name, import_row.detected_account_identifier,
      case when auth.role() = 'service_role' then import_row.created_by else auth.uid() end
    ) on conflict (bank_account_id) do update set
      institution = excluded.institution, account_name = excluded.account_name,
      account_identifier = excluded.account_identifier, confirmed_by = excluded.confirmed_by,
      confirmed_at = now(), updated_at = now();
  end if;
  return jsonb_build_object('status', 'complete', 'imported', inserted_count, 'duplicates', total_count - inserted_count);
end $$;

revoke all on function public.commit_statement_import(uuid, boolean) from public, anon;
grant execute on function public.commit_statement_import(uuid, boolean) to authenticated, service_role;
