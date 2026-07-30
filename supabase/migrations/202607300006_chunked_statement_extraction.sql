-- Chunked extraction: a tabular statement too large for one model pass is
-- split into deterministic line-range segments, extracted one segment per
-- worker run, and stitched before deterministic validation. Segment results
-- are durable so a killed worker resumes instead of restarting, and a run
-- that completes a segment refreshes the attempt budget: attempts only count
-- runs that made no progress.

create table public.statement_import_chunks (
  import_id uuid not null references public.statement_imports(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  line_start integer not null check (line_start > 0),
  line_end integer not null check (line_end >= line_start),
  extraction jsonb not null,
  created_at timestamptz not null default now(),
  primary key (import_id, chunk_index)
);

-- Segment results are a server-only working area; no browser policies.
alter table public.statement_import_chunks enable row level security;

alter table public.statement_imports
  add column chunk_total integer check (chunk_total is null or chunk_total > 0),
  add column chunk_done integer not null default 0 check (chunk_done >= 0);

create or replace function public.finish_statement_import(
  p_import_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_extraction jsonb default null,
  p_validation jsonb default null,
  p_error text default null,
  p_chunk_done integer default null,
  p_chunk_total integer default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  import_row public.statement_imports;
  terminal_status text;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if p_outcome not in ('ready', 'retryable', 'failed', 'progress') then raise exception 'Unsupported import outcome'; end if;
  select * into import_row from public.statement_imports where id = p_import_id for update;
  if import_row.id is null then raise exception 'Statement import not found'; end if;
  if import_row.status <> 'processing' or import_row.lease_token is distinct from p_lease_token then
    raise exception 'Statement import lease is no longer current';
  end if;

  if p_outcome = 'progress' then
    -- A completed segment refreshes the attempt budget; the import queues
    -- again immediately with no backoff and no error.
    update public.statement_imports set
      status = 'retryable', attempts = 0,
      chunk_done = coalesce(p_chunk_done, chunk_done),
      chunk_total = coalesce(p_chunk_total, chunk_total),
      last_error = null,
      available_at = now(), lease_token = null, lease_expires_at = null, updated_at = now()
    where id = import_row.id;
    update public.statement_import_org_queue set active_leases = 0, next_eligible_at = now(), updated_at = now()
    where company_id = import_row.company_id;
    return jsonb_build_object('status', 'retryable', 'progress', true);
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
    chunk_done = coalesce(p_chunk_done, chunk_done),
    chunk_total = coalesce(p_chunk_total, chunk_total),
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

revoke all on function public.finish_statement_import(uuid, uuid, text, jsonb, jsonb, text, integer, integer) from public, anon, authenticated;
grant execute on function public.finish_statement_import(uuid, uuid, text, jsonb, jsonb, text, integer, integer) to service_role;

-- The previous six-argument signature is superseded.
drop function if exists public.finish_statement_import(uuid, uuid, text, jsonb, jsonb, text);

-- PostgREST must see the new function signature before workers call it.
notify pgrst, 'reload schema';
