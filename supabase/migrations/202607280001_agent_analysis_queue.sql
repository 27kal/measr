-- Durable, fair background analysis. These rows contain scheduling metadata only;
-- the agent's reasoning and decision audit trail remain in private thread artifacts.

create table public.agent_analysis_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_account_id uuid references public.bank_accounts(id) on delete cascade,
  ingestion_run_id uuid references public.ingestion_runs(id) on delete cascade,
  source text not null check (source in ('csv_import', 'bank_feed', 'manual_backfill')),
  status text not null default 'queued' check (status in ('queued', 'snapshotting', 'running', 'complete', 'partial', 'failed')),
  snapshot_path text,
  snapshot_created_at timestamptz,
  snapshot_expires_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index agent_analysis_batches_ingestion_run_idx
  on public.agent_analysis_batches(ingestion_run_id)
  where ingestion_run_id is not null;

create table public.agent_analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.agent_analysis_batches(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  statement_line_id uuid not null references public.statement_lines(id) on delete cascade,
  expected_status_version integer not null check (expected_status_version >= 0),
  state text not null default 'queued' check (state in ('queued', 'leased', 'retryable', 'succeeded', 'skipped', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  result_run_id uuid,
  last_error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(statement_line_id, expected_status_version)
);

create index agent_analysis_jobs_claim_idx
  on public.agent_analysis_jobs(company_id, available_at, created_at)
  where state in ('queued', 'retryable');

create table public.agent_analysis_org_queue (
  company_id uuid primary key references public.companies(id) on delete cascade,
  last_dequeued_at timestamptz,
  active_leases integer not null default 0 check (active_leases >= 0),
  next_eligible_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.agent_analysis_batches enable row level security;
alter table public.agent_analysis_jobs enable row level security;
alter table public.agent_analysis_org_queue enable row level security;

create policy agent_analysis_batches_member_read on public.agent_analysis_batches
  for select using (public.is_company_member(company_id));
create policy agent_analysis_jobs_member_read on public.agent_analysis_jobs
  for select using (public.is_company_member(company_id));

-- Enqueue all still-new lines in one ingestion run. The trigger makes completion
-- and scheduling one transaction, so a crashed browser cannot lose the work.
create or replace function public.enqueue_ingestion_analysis()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  created_batch uuid;
  job_count integer;
begin
  if new.status <> 'complete' or old.status = 'complete' then return new; end if;

  insert into public.agent_analysis_batches(
    company_id, bank_account_id, ingestion_run_id, source, created_by
  ) values (
    new.company_id,
    new.bank_account_id,
    new.id,
    case new.source when 'open_banking' then 'bank_feed' else 'csv_import' end,
    new.created_by
  ) on conflict (ingestion_run_id) where ingestion_run_id is not null do nothing
  returning id into created_batch;

  if created_batch is null then return new; end if;

  insert into public.agent_analysis_jobs(
    batch_id, company_id, statement_line_id, expected_status_version
  )
  select created_batch, line.company_id, line.id, line.status_version
  from public.statement_lines line
  where line.ingestion_run_id = new.id
    and line.status = 'new'
    and line.active_candidate_set_id is null
  on conflict (statement_line_id, expected_status_version) do nothing;

  get diagnostics job_count = row_count;
  if job_count = 0 then
    update public.agent_analysis_batches
      set status = 'complete', completed_at = now(), updated_at = now()
      where id = created_batch;
  else
    insert into public.agent_analysis_org_queue(company_id)
      values (new.company_id) on conflict (company_id) do nothing;
  end if;
  return new;
end $$;

create trigger ingestion_run_enqueue_analysis
after update of status on public.ingestion_runs
for each row execute function public.enqueue_ingestion_analysis();

create or replace function public.enqueue_agent_analysis_backfill(
  p_company_id uuid,
  p_bank_account_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  created_batch uuid;
  job_count integer;
begin
  if auth.role() <> 'service_role' and not public.is_company_member(p_company_id) then
    raise exception 'Company access required';
  end if;
  if p_bank_account_id is not null and not exists (
    select 1 from public.bank_accounts where id = p_bank_account_id and company_id = p_company_id
  ) then raise exception 'Bank account not found'; end if;

  insert into public.agent_analysis_batches(company_id, bank_account_id, source, created_by)
  values (p_company_id, p_bank_account_id, 'manual_backfill', auth.uid())
  returning id into created_batch;

  insert into public.agent_analysis_jobs(batch_id, company_id, statement_line_id, expected_status_version)
  select created_batch, line.company_id, line.id, line.status_version
  from public.statement_lines line
  where line.company_id = p_company_id
    and (p_bank_account_id is null or line.bank_account_id = p_bank_account_id)
    and line.status = 'new'
    and line.active_candidate_set_id is null
  on conflict (statement_line_id, expected_status_version) do nothing;
  get diagnostics job_count = row_count;

  if job_count = 0 then
    update public.agent_analysis_batches set status = 'complete', completed_at = now(), updated_at = now() where id = created_batch;
  else
    insert into public.agent_analysis_org_queue(company_id) values (p_company_id)
      on conflict (company_id) do nothing;
  end if;
  return jsonb_build_object('batchId', created_batch, 'queued', job_count);
end $$;

-- Claim at most one FIFO job per company, ordering companies by the last time
-- they received work. SKIP LOCKED lets multiple workers scale safely.
create or replace function public.claim_agent_analysis_jobs(
  p_limit integer default 2,
  p_lease_seconds integer default 130
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  org record;
  claimed_job record;
  claims jsonb := '[]'::jsonb;
  token uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  p_limit := greatest(1, least(p_limit, 10));
  p_lease_seconds := greatest(30, least(p_lease_seconds, 300));

  update public.agent_analysis_jobs
    set state = 'retryable', lease_token = null, lease_expires_at = null,
        available_at = now(), last_error = coalesce(last_error, 'Worker lease expired'), updated_at = now()
    where state = 'leased' and lease_expires_at <= now();
  update public.agent_analysis_org_queue queue
    set active_leases = (
      select count(*) from public.agent_analysis_jobs leased_job
      where leased_job.company_id = queue.company_id and leased_job.state = 'leased' and leased_job.lease_expires_at > now()
    ), updated_at = now()
    where true;

  for org in
    select queue.company_id
    from public.agent_analysis_org_queue queue
    where queue.active_leases = 0
      and (queue.next_eligible_at is null or queue.next_eligible_at <= now())
      and exists (
        select 1 from public.agent_analysis_jobs pending
        where pending.company_id = queue.company_id
          and pending.state in ('queued', 'retryable')
          and pending.available_at <= now()
      )
    order by queue.last_dequeued_at nulls first, queue.company_id
    for update skip locked
    limit p_limit
  loop
    select * into claimed_job
    from public.agent_analysis_jobs pending
    where pending.company_id = org.company_id
      and pending.state in ('queued', 'retryable')
      and pending.available_at <= now()
    order by pending.created_at, pending.id
    for update skip locked
    limit 1;
    if not found then continue; end if;

    token := gen_random_uuid();
    update public.agent_analysis_jobs set
      state = 'leased', attempts = attempts + 1, lease_token = token,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      started_at = coalesce(started_at, now()), updated_at = now()
    where id = claimed_job.id;
    update public.agent_analysis_org_queue set
      active_leases = 1, last_dequeued_at = now(), next_eligible_at = null, updated_at = now()
    where company_id = org.company_id;
    update public.agent_analysis_batches set
      status = case when snapshot_path is null then 'snapshotting' else 'running' end,
      started_at = coalesce(started_at, now()), updated_at = now()
    where id = claimed_job.batch_id and status in ('queued', 'snapshotting', 'running');

    claims := claims || jsonb_build_array(jsonb_build_object(
      'jobId', claimed_job.id, 'batchId', claimed_job.batch_id, 'companyId', claimed_job.company_id,
      'statementLineId', claimed_job.statement_line_id,
      'expectedStatusVersion', claimed_job.expected_status_version,
      'attempt', claimed_job.attempts + 1, 'leaseToken', token
    ));
  end loop;
  return claims;
end $$;

create or replace function public.finish_agent_analysis_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_result_run_id uuid default null,
  p_error text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  job public.agent_analysis_jobs;
  terminal_state text;
  pending_count integer;
  failed_count integer;
  succeeded_count integer;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if p_outcome not in ('succeeded', 'skipped', 'retryable', 'failed') then raise exception 'Unsupported job outcome'; end if;
  select * into job from public.agent_analysis_jobs where id = p_job_id for update;
  if job.id is null then raise exception 'Analysis job not found'; end if;
  if job.state <> 'leased' or job.lease_token is distinct from p_lease_token then raise exception 'Analysis lease is no longer current'; end if;

  terminal_state := case when p_outcome = 'retryable' and job.attempts >= 5 then 'failed' else p_outcome end;
  update public.agent_analysis_jobs set
    state = terminal_state,
    result_run_id = coalesce(p_result_run_id, result_run_id),
    last_error = case when terminal_state in ('retryable', 'failed') then left(coalesce(p_error, 'Analysis failed'), 2000) else null end,
    available_at = case when terminal_state = 'retryable'
      then now() + make_interval(secs => least(900, 15 * power(2, greatest(job.attempts - 1, 0))::integer))
      else available_at end,
    lease_token = null, lease_expires_at = null,
    completed_at = case when terminal_state in ('succeeded', 'skipped', 'failed') then now() else null end,
    updated_at = now()
  where id = job.id;

  select count(*) filter (where state in ('queued', 'leased', 'retryable')),
         count(*) filter (where state = 'failed'),
         count(*) filter (where state = 'succeeded')
    into pending_count, failed_count, succeeded_count
  from public.agent_analysis_jobs where batch_id = job.batch_id;

  update public.agent_analysis_batches set
    status = case
      when pending_count > 0 then 'running'
      when failed_count > 0 and succeeded_count > 0 then 'partial'
      when failed_count > 0 then 'failed'
      else 'complete' end,
    completed_at = case when pending_count = 0 then now() else null end,
    updated_at = now()
  where id = job.batch_id;

  update public.agent_analysis_org_queue set active_leases = 0,
    next_eligible_at = case when terminal_state = 'retryable' then now() else null end,
    updated_at = now()
  where company_id = job.company_id;
  return jsonb_build_object('state', terminal_state, 'batchPending', pending_count);
end $$;

create or replace function public.set_agent_analysis_snapshot(
  p_batch_id uuid,
  p_path text,
  p_created_at timestamptz,
  p_expires_at timestamptz
) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  update public.agent_analysis_batches set snapshot_path = p_path,
    snapshot_created_at = p_created_at, snapshot_expires_at = p_expires_at,
    status = 'running', updated_at = now()
  where id = p_batch_id;
end $$;

revoke all on function public.claim_agent_analysis_jobs(integer, integer) from public, anon, authenticated;
revoke all on function public.finish_agent_analysis_job(uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.set_agent_analysis_snapshot(uuid, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_agent_analysis_jobs(integer, integer) to service_role;
grant execute on function public.finish_agent_analysis_job(uuid, uuid, text, uuid, text) to service_role;
grant execute on function public.set_agent_analysis_snapshot(uuid, text, timestamptz, timestamptz) to service_role;
grant execute on function public.enqueue_agent_analysis_backfill(uuid, uuid) to authenticated, service_role;
