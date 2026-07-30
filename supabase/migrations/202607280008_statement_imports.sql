-- Durable, company-fair extraction of immutable bank-statement files. The LLM
-- may interpret a source document, but only this database boundary can commit
-- verified canonical statement lines.

alter table public.ingestion_runs drop constraint if exists ingestion_runs_source_check;
alter table public.ingestion_runs add constraint ingestion_runs_source_check
  check (source in ('open_banking', 'csv', 'statement_upload'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'agent-artifacts',
  'agent-artifacts',
  false,
  26214400,
  array[
    'application/json',
    'text/markdown',
    'text/plain',
    'text/csv',
    'text/tab-separated-values',
    'application/csv',
    'application/pdf',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/png',
    'image/jpeg',
    'image/webp'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table public.statement_imports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id) on delete cascade,
  storage_key text not null unique,
  filename text not null,
  mime_type text not null check (mime_type in (
    'text/csv', 'text/tab-separated-values', 'application/csv', 'application/pdf',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )),
  byte_size integer not null check (byte_size > 0 and byte_size <= 26214400),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'queued' check (status in (
    'queued', 'processing', 'retryable', 'awaiting_confirmation', 'complete', 'failed'
  )),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  detected_institution text not null default '',
  detected_account_name text not null default '',
  detected_account_identifier text not null default '',
  period_start date,
  period_end date,
  opening_balance_minor bigint,
  closing_balance_minor bigint,
  transaction_count integer not null default 0 check (transaction_count >= 0),
  imported_count integer not null default 0 check (imported_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  extraction jsonb,
  validation jsonb,
  ingestion_run_id uuid references public.ingestion_runs(id) on delete set null,
  last_error text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (company_id, bank_account_id, sha256)
);

create index statement_imports_claim_idx on public.statement_imports(company_id, available_at, created_at)
  where status in ('queued', 'retryable');
create index statement_imports_account_created_idx on public.statement_imports(bank_account_id, created_at desc);

create table public.statement_import_profiles (
  bank_account_id uuid primary key references public.bank_accounts(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  institution text not null default '',
  account_name text not null default '',
  account_identifier text not null default '',
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.statement_import_org_queue (
  company_id uuid primary key references public.companies(id) on delete cascade,
  last_dequeued_at timestamptz,
  active_leases integer not null default 0 check (active_leases >= 0),
  next_eligible_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.statement_imports enable row level security;
alter table public.statement_import_profiles enable row level security;
alter table public.statement_import_org_queue enable row level security;

create policy statement_imports_member_read on public.statement_imports for select
  using (public.is_company_member(company_id));
create policy statement_import_profiles_member_read on public.statement_import_profiles for select
  using (public.is_company_member(company_id));

create or replace function public.claim_statement_imports(
  p_limit integer default 2,
  p_lease_seconds integer default 150
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  org record;
  claimed_import record;
  claims jsonb := '[]'::jsonb;
  token uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  p_limit := greatest(1, least(p_limit, 5));
  p_lease_seconds := greatest(60, least(p_lease_seconds, 300));

  update public.statement_imports
    set status = 'retryable', lease_token = null, lease_expires_at = null,
        available_at = now(), last_error = coalesce(last_error, 'Worker lease expired'), updated_at = now()
    where status = 'processing' and lease_expires_at <= now();
  update public.statement_import_org_queue queue
    set active_leases = (
      select count(*) from public.statement_imports active_import
      where active_import.company_id = queue.company_id
        and active_import.status = 'processing' and active_import.lease_expires_at > now()
    ), updated_at = now()
    where true;

  for org in
    select queue.company_id
    from public.statement_import_org_queue queue
    where queue.active_leases = 0
      and (queue.next_eligible_at is null or queue.next_eligible_at <= now())
      and exists (
        select 1 from public.statement_imports pending
        where pending.company_id = queue.company_id
          and pending.status in ('queued', 'retryable') and pending.available_at <= now()
      )
    order by queue.last_dequeued_at nulls first, queue.company_id
    for update skip locked
    limit p_limit
  loop
    select pending.* into claimed_import
    from public.statement_imports pending
    where pending.company_id = org.company_id
      and pending.status in ('queued', 'retryable') and pending.available_at <= now()
    order by pending.created_at, pending.id
    for update skip locked
    limit 1;
    if not found then continue; end if;

    token := gen_random_uuid();
    update public.statement_imports set
      status = 'processing', attempts = attempts + 1, lease_token = token,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      started_at = coalesce(started_at, now()), last_error = null, updated_at = now()
    where id = claimed_import.id;
    update public.statement_import_org_queue set
      active_leases = 1, last_dequeued_at = now(), next_eligible_at = null, updated_at = now()
    where company_id = org.company_id;
    claims := claims || jsonb_build_array(jsonb_build_object(
      'importId', claimed_import.id, 'companyId', claimed_import.company_id,
      'bankAccountId', claimed_import.bank_account_id, 'attempt', claimed_import.attempts + 1,
      'leaseToken', token
    ));
  end loop;
  return claims;
end $$;

create or replace function public.finish_statement_import(
  p_import_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_extraction jsonb default null,
  p_validation jsonb default null,
  p_error text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  import_row public.statement_imports;
  terminal_status text;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if p_outcome not in ('ready', 'retryable', 'failed') then raise exception 'Unsupported import outcome'; end if;
  select * into import_row from public.statement_imports where id = p_import_id for update;
  if import_row.id is null then raise exception 'Statement import not found'; end if;
  if import_row.status <> 'processing' or import_row.lease_token is distinct from p_lease_token then
    raise exception 'Statement import lease is no longer current';
  end if;

  terminal_status := case
    when p_outcome = 'ready' then 'awaiting_confirmation'
    when p_outcome = 'retryable' and import_row.attempts < 3 then 'retryable'
    else 'failed' end;
  update public.statement_imports set
    status = terminal_status,
    extraction = coalesce(p_extraction, extraction),
    validation = coalesce(p_validation, validation),
    detected_institution = coalesce(p_extraction->>'institution', detected_institution),
    detected_account_name = coalesce(p_extraction->>'accountName', detected_account_name),
    detected_account_identifier = coalesce(p_extraction->>'accountIdentifier', detected_account_identifier),
    period_start = nullif(p_extraction->>'periodStart', '')::date,
    period_end = nullif(p_extraction->>'periodEnd', '')::date,
    opening_balance_minor = nullif(p_extraction->>'openingBalanceMinor', '')::bigint,
    closing_balance_minor = nullif(p_extraction->>'closingBalanceMinor', '')::bigint,
    transaction_count = case when p_extraction is null then transaction_count else jsonb_array_length(coalesce(p_extraction->'transactions', '[]'::jsonb)) end,
    last_error = case when terminal_status in ('retryable', 'failed') then left(coalesce(p_error, 'Statement extraction failed'), 4000) else null end,
    available_at = case when terminal_status = 'retryable'
      then now() + make_interval(secs => least(300, 15 * power(2, greatest(import_row.attempts - 1, 0))::integer))
      else available_at end,
    lease_token = null, lease_expires_at = null,
    completed_at = case when terminal_status = 'failed' then now() else null end,
    updated_at = now()
  where id = import_row.id;
  update public.statement_import_org_queue set active_leases = 0,
    next_eligible_at = case when terminal_status = 'retryable' then now() else null end,
    updated_at = now()
  where company_id = import_row.company_id;
  return jsonb_build_object('status', terminal_status);
end $$;

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
  if not exists (
    select 1 from public.bank_accounts account
    where account.id = import_row.bank_account_id and account.company_id = import_row.company_id
  ) then raise exception 'Bank account not found'; end if;

  insert into public.ingestion_runs(company_id, bank_account_id, source, source_file_name, status, created_by)
  values (import_row.company_id, import_row.bank_account_id, 'statement_upload', import_row.filename, 'processing', import_row.created_by)
  returning id into ingestion_id;

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
    coalesce((item->>'occurrence')::integer, 1),
    'new',
    'Imported from a verified bank statement and waiting for analysis.'
  from jsonb_array_elements(import_row.extraction->'transactions') item
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

revoke all on function public.claim_statement_imports(integer, integer) from public, anon, authenticated;
revoke all on function public.finish_statement_import(uuid, uuid, text, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.commit_statement_import(uuid, boolean) from public, anon;
grant execute on function public.claim_statement_imports(integer, integer) to service_role;
grant execute on function public.finish_statement_import(uuid, uuid, text, jsonb, jsonb, text) to service_role;
grant execute on function public.commit_statement_import(uuid, boolean) to authenticated, service_role;
