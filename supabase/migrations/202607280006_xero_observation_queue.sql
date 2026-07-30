-- Durable, company-fair Xero observation. These rows retain operational
-- scheduling and outcome metadata only; accounting evidence remains on the
-- candidate, Xero object, line event and raw agent-thread records.

create table public.xero_observation_jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  source text not null check (source in ('scheduled', 'manual')),
  full_sweep boolean not null default false,
  state text not null default 'queued' check (state in ('queued', 'leased', 'retryable', 'succeeded', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  candidate_count integer not null default 0 check (candidate_count >= 0),
  unlinked_line_count integer not null default 0 check (unlinked_line_count >= 0),
  changed_line_count integer not null default 0 check (changed_line_count >= 0),
  result jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index xero_observation_jobs_one_pending_company_idx
  on public.xero_observation_jobs(company_id)
  where state in ('queued', 'leased', 'retryable');

create index xero_observation_jobs_claim_idx
  on public.xero_observation_jobs(company_id, available_at, created_at)
  where state in ('queued', 'retryable');

create table public.xero_observation_org_queue (
  company_id uuid primary key references public.companies(id) on delete cascade,
  last_dequeued_at timestamptz,
  active_leases integer not null default 0 check (active_leases >= 0),
  next_eligible_at timestamptz not null default now(),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_succeeded_at timestamptz,
  last_full_sweep_at timestamptz,
  last_result jsonb not null default '{}'::jsonb,
  last_error text,
  updated_at timestamptz not null default now()
);

alter table public.xero_observation_jobs enable row level security;
alter table public.xero_observation_org_queue enable row level security;

create policy xero_observation_jobs_member_read on public.xero_observation_jobs
  for select using (public.is_company_member(company_id));
create policy xero_observation_org_queue_member_read on public.xero_observation_org_queue
  for select using (public.is_company_member(company_id));

create or replace function public.enqueue_xero_observation(
  p_company_id uuid,
  p_source text default 'manual'
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  job_id uuid;
begin
  if p_source not in ('scheduled', 'manual') then raise exception 'Unsupported observation source'; end if;
  if auth.role() <> 'service_role' and not public.is_company_member(p_company_id) then
    raise exception 'Company access required';
  end if;
  if not exists (
    select 1 from public.xero_connections
    where company_id = p_company_id and disconnected_at is null
  ) then raise exception 'Xero is not connected'; end if;

  insert into public.xero_observation_org_queue(company_id, next_eligible_at)
    values (p_company_id, now())
  on conflict (company_id) do update
    set next_eligible_at = now(), updated_at = now();

  select id into job_id
  from public.xero_observation_jobs
  where company_id = p_company_id and state in ('queued', 'leased', 'retryable')
  order by created_at limit 1;

  if job_id is null then
    insert into public.xero_observation_jobs(company_id, source)
      values (p_company_id, p_source)
      returning id into job_id;
  end if;
  return jsonb_build_object('jobId', job_id, 'scheduled', true);
end $$;

-- Claim at most one observation job per company. Companies are ordered by the
-- last time they received a lease, matching the analysis runner's fairness.
create or replace function public.claim_xero_observation_jobs(
  p_limit integer default 2,
  p_lease_seconds integer default 180
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  org record;
  claimed_job record;
  claims jsonb := '[]'::jsonb;
  token uuid;
  needs_full_sweep boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  p_limit := greatest(1, least(p_limit, 10));
  p_lease_seconds := greatest(30, least(p_lease_seconds, 300));

  update public.xero_observation_jobs
    set state = 'retryable', lease_token = null, lease_expires_at = null,
        available_at = now(), last_error = coalesce(last_error, 'Worker lease expired'), updated_at = now()
    where state = 'leased' and lease_expires_at <= now();

  update public.xero_observation_org_queue queue
    set active_leases = (
      select count(*) from public.xero_observation_jobs leased_job
      where leased_job.company_id = queue.company_id
        and leased_job.state = 'leased' and leased_job.lease_expires_at > now()
    ), updated_at = now()
    where true;

  insert into public.xero_observation_org_queue(company_id)
  select connection.company_id
  from public.xero_connections connection
  where connection.disconnected_at is null
    and (
      exists (select 1 from public.candidate_sets candidate where candidate.company_id = connection.company_id and candidate.status in ('active', 'settled'))
      or exists (select 1 from public.statement_lines line where line.company_id = connection.company_id and line.active_candidate_set_id is null and line.status in ('new', 'processing', 'needs_you', 'waiting_doc'))
    )
  on conflict (company_id) do nothing;

  for org in
    select queue.company_id, queue.last_full_sweep_at
    from public.xero_observation_org_queue queue
    join public.xero_connections connection on connection.company_id = queue.company_id and connection.disconnected_at is null
    where queue.active_leases = 0
      and queue.next_eligible_at <= now()
      and (
        exists (select 1 from public.xero_observation_jobs pending where pending.company_id = queue.company_id and pending.state in ('queued', 'retryable') and pending.available_at <= now())
        or exists (select 1 from public.candidate_sets candidate where candidate.company_id = queue.company_id and candidate.status in ('active', 'settled'))
        or exists (select 1 from public.statement_lines line where line.company_id = queue.company_id and line.active_candidate_set_id is null and line.status in ('new', 'processing', 'needs_you', 'waiting_doc'))
      )
    order by queue.last_dequeued_at nulls first, queue.company_id
    for update of queue skip locked
    limit p_limit
  loop
    select * into claimed_job
    from public.xero_observation_jobs pending
    where pending.company_id = org.company_id
      and pending.state in ('queued', 'retryable')
      and pending.available_at <= now()
    order by pending.created_at, pending.id
    for update skip locked
    limit 1;

    needs_full_sweep := org.last_full_sweep_at is null or org.last_full_sweep_at <= now() - interval '24 hours';
    if not found then
      insert into public.xero_observation_jobs(company_id, source, full_sweep)
        values (org.company_id, 'scheduled', needs_full_sweep)
        returning * into claimed_job;
    else
      update public.xero_observation_jobs set full_sweep = full_sweep or needs_full_sweep where id = claimed_job.id;
      claimed_job.full_sweep := claimed_job.full_sweep or needs_full_sweep;
    end if;

    token := gen_random_uuid();
    update public.xero_observation_jobs set
      state = 'leased', attempts = attempts + 1, lease_token = token,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      started_at = coalesce(started_at, now()), updated_at = now()
    where id = claimed_job.id;
    update public.xero_observation_org_queue set
      active_leases = 1, last_dequeued_at = now(), updated_at = now()
    where company_id = org.company_id;

    claims := claims || jsonb_build_array(jsonb_build_object(
      'jobId', claimed_job.id,
      'companyId', claimed_job.company_id,
      'attempt', claimed_job.attempts + 1,
      'leaseToken', token,
      'fullSweep', claimed_job.full_sweep
    ));
  end loop;
  return claims;
end $$;

create or replace function public.finish_xero_observation_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_candidate_count integer default 0,
  p_unlinked_line_count integer default 0,
  p_changed_line_count integer default 0,
  p_result jsonb default '{}'::jsonb,
  p_error text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  job public.xero_observation_jobs;
  terminal_state text;
  has_frequent_work boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if p_outcome not in ('succeeded', 'retryable', 'failed') then raise exception 'Unsupported observation outcome'; end if;
  select * into job from public.xero_observation_jobs where id = p_job_id for update;
  if job.id is null then raise exception 'Observation job not found'; end if;
  if job.state <> 'leased' or job.lease_token is distinct from p_lease_token then raise exception 'Observation lease is no longer current'; end if;

  terminal_state := case when p_outcome = 'retryable' and job.attempts >= 5 then 'failed' else p_outcome end;
  update public.xero_observation_jobs set
    state = terminal_state,
    candidate_count = greatest(0, p_candidate_count),
    unlinked_line_count = greatest(0, p_unlinked_line_count),
    changed_line_count = greatest(0, p_changed_line_count),
    result = coalesce(p_result, '{}'::jsonb),
    last_error = case when terminal_state in ('retryable', 'failed') then left(coalesce(p_error, 'Observation failed'), 2000) else null end,
    available_at = case when terminal_state = 'retryable'
      then now() + make_interval(secs => least(900, 15 * power(2, greatest(job.attempts - 1, 0))::integer))
      else available_at end,
    lease_token = null, lease_expires_at = null,
    completed_at = case when terminal_state in ('succeeded', 'failed') then now() else null end,
    updated_at = now()
  where id = job.id;

  select exists (
    select 1 from public.candidate_sets candidate where candidate.company_id = job.company_id and candidate.status = 'active'
  ) or exists (
    select 1 from public.statement_lines line where line.company_id = job.company_id and line.active_candidate_set_id is null and line.status in ('new', 'processing', 'needs_you', 'waiting_doc')
  ) into has_frequent_work;

  update public.xero_observation_org_queue set
    active_leases = 0,
    consecutive_failures = case when terminal_state = 'succeeded' then 0 else consecutive_failures + 1 end,
    last_succeeded_at = case when terminal_state = 'succeeded' then now() else last_succeeded_at end,
    last_full_sweep_at = case when terminal_state = 'succeeded' and job.full_sweep then now() else last_full_sweep_at end,
    last_result = case when terminal_state = 'succeeded' then coalesce(p_result, '{}'::jsonb) else last_result end,
    last_error = case when terminal_state = 'succeeded' then null else left(coalesce(p_error, 'Observation failed'), 2000) end,
    next_eligible_at = case
      when terminal_state = 'retryable' then now() + make_interval(secs => least(900, 15 * power(2, greatest(job.attempts - 1, 0))::integer))
      when terminal_state = 'failed' then now() + interval '15 minutes'
      when has_frequent_work then now() + interval '2 minutes'
      else now() + interval '15 minutes'
    end,
    updated_at = now()
  where company_id = job.company_id;
  return jsonb_build_object('state', terminal_state);
end $$;

-- Repeated polling must not increment a line version or emit duplicate events
-- when Xero reports the same authoritative state again.
create or replace function public.apply_candidate_observation(
  p_candidate_set_id uuid,
  p_object_updates jsonb,
  p_line_results jsonb,
  p_candidate_status public.candidate_status,
  p_invalidation_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  candidate_company uuid;
  current_candidate_status public.candidate_status;
  current_invalidation_reason text;
  result jsonb;
  old_status public.statement_line_status;
  old_candidate_id uuid;
  old_note text;
  old_verification public.verification_status;
  new_status public.statement_line_status;
  new_candidate_id uuid;
  new_verification public.verification_status;
begin
  select company_id, status, invalidation_reason
    into candidate_company, current_candidate_status, current_invalidation_reason
  from public.candidate_sets where id = p_candidate_set_id for update;
  if candidate_company is null then raise exception 'Candidate set not found'; end if;

  if current_candidate_status is distinct from p_candidate_status or current_invalidation_reason is distinct from p_invalidation_reason then
    update public.candidate_sets set status = p_candidate_status, invalidation_reason = p_invalidation_reason, updated_at = now()
    where id = p_candidate_set_id;
  end if;

  update public.xero_objects xo set
    xero_status = coalesce(update_row.value->>'xeroStatus', xo.xero_status),
    is_reconciled = coalesce((update_row.value->>'isReconciled')::boolean, xo.is_reconciled),
    observed_payload = coalesce(update_row.value->'payload', xo.observed_payload),
    observed_at = now(),
    deleted_at = case when update_row.value->>'xeroStatus' = 'DELETED' then coalesce(xo.deleted_at, now()) else xo.deleted_at end
  from jsonb_array_elements(p_object_updates) update_row
  where xo.candidate_set_id = p_candidate_set_id and xo.xero_object_id = (update_row.value->>'xeroObjectId')::uuid;

  for result in select value from jsonb_array_elements(p_line_results) loop
    select line.status, line.active_candidate_set_id, line.note, member.verification_status
      into old_status, old_candidate_id, old_note, old_verification
    from public.statement_lines line
    join public.candidate_set_lines member on member.statement_line_id = line.id and member.candidate_set_id = p_candidate_set_id
    where line.id = (result->>'statementLineId')::uuid for update of line, member;

    new_status := (result->>'status')::public.statement_line_status;
    new_verification := (result->>'verificationStatus')::public.verification_status;
    new_candidate_id := case when new_status = 'needs_you' then null else p_candidate_set_id end;

    if old_verification is distinct from new_verification then
      update public.candidate_set_lines set verification_status = new_verification
      where candidate_set_id = p_candidate_set_id and statement_line_id = (result->>'statementLineId')::uuid;
    end if;

    if old_status is distinct from new_status
      or old_candidate_id is distinct from new_candidate_id
      or old_note is distinct from (result->>'reason') then
      update public.statement_lines set status = new_status, status_version = status_version + 1,
        active_candidate_set_id = new_candidate_id, note = result->>'reason', updated_at = now()
      where id = (result->>'statementLineId')::uuid and company_id = candidate_company;
      insert into public.line_events(company_id, statement_line_id, candidate_set_id, from_status, to_status, reason, source, metadata)
        values(candidate_company, (result->>'statementLineId')::uuid, p_candidate_set_id, old_status, new_status, result->>'reason', 'xero_observation', result);
    end if;
  end loop;
end $$;

revoke all on function public.enqueue_xero_observation(uuid, text) from public, anon;
revoke all on function public.claim_xero_observation_jobs(integer, integer) from public, anon, authenticated;
revoke all on function public.finish_xero_observation_job(uuid, uuid, text, integer, integer, integer, jsonb, text) from public, anon, authenticated;
grant execute on function public.enqueue_xero_observation(uuid, text) to authenticated, service_role;
grant execute on function public.claim_xero_observation_jobs(integer, integer) to service_role;
grant execute on function public.finish_xero_observation_job(uuid, uuid, text, integer, integer, integer, jsonb, text) to service_role;
