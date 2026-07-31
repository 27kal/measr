-- Three changes to drain large analysis backlogs safely:
--   1. A company may hold up to three concurrent analysis leases instead of
--      one. Snapshot building stays serialised: a job whose batch has no
--      valid snapshot is only claimable while the company holds no lease at
--      all, so exactly one job builds the shared snapshot.
--   2. finish_agent_analysis_job recomputes the company's live lease count
--      instead of zeroing it, which the old single-lease code could assume.
--   3. A job that fails permanently no longer strands its line in `new`:
--      the line moves to needs_you with an explanatory note and audit event,
--      so unfinished work is always visible to the bookkeeper.

create or replace function public.claim_agent_analysis_jobs(
  p_limit integer default 2,
  p_lease_seconds integer default 130
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  max_company_leases constant integer := 3;
  org record;
  claimed_job record;
  claims jsonb := '[]'::jsonb;
  token uuid;
  effective_leases integer;
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
    select queue.company_id, queue.active_leases
    from public.agent_analysis_org_queue queue
    where queue.active_leases < max_company_leases
      and (queue.next_eligible_at is null or queue.next_eligible_at <= now())
      and exists (
        select 1
        from public.agent_analysis_jobs pending
        join public.agent_analysis_batches batch on batch.id = pending.batch_id
        where pending.company_id = queue.company_id
          and pending.state in ('queued', 'retryable')
          and pending.available_at <= now()
          and (
            (batch.snapshot_path is not null and batch.snapshot_expires_at > now())
            or (queue.active_leases = 0 and not exists (
              select 1 from public.agent_analysis_jobs earlier
              where earlier.batch_id = pending.batch_id
                and earlier.state in ('queued', 'leased', 'retryable')
                and (earlier.created_at, earlier.id) < (pending.created_at, pending.id)
            ))
          )
      )
    order by queue.last_dequeued_at nulls first, queue.company_id
    for update skip locked
    limit p_limit
  loop
    effective_leases := org.active_leases;
    while effective_leases < max_company_leases loop
      select pending.* into claimed_job
      from public.agent_analysis_jobs pending
      join public.agent_analysis_batches batch on batch.id = pending.batch_id
      where pending.company_id = org.company_id
        and pending.state in ('queued', 'retryable')
        and pending.available_at <= now()
        and (
          (batch.snapshot_path is not null and batch.snapshot_expires_at > now())
          or (effective_leases = 0 and not exists (
            select 1 from public.agent_analysis_jobs earlier
            where earlier.batch_id = pending.batch_id
              and earlier.state in ('queued', 'leased', 'retryable')
              and (earlier.created_at, earlier.id) < (pending.created_at, pending.id)
          ))
        )
      order by pending.created_at, pending.id
      for update of pending skip locked
      limit 1;
      exit when not found;

      token := gen_random_uuid();
      update public.agent_analysis_jobs set
        state = 'leased', attempts = attempts + 1, lease_token = token,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        started_at = coalesce(started_at, now()), updated_at = now()
      where id = claimed_job.id;
      update public.agent_analysis_batches set
        status = case when snapshot_path is null or snapshot_expires_at <= now() then 'snapshotting' else 'running' end,
        started_at = coalesce(started_at, now()), updated_at = now()
      where id = claimed_job.batch_id and status in ('queued', 'snapshotting', 'running');

      claims := claims || jsonb_build_array(jsonb_build_object(
        'jobId', claimed_job.id, 'batchId', claimed_job.batch_id, 'companyId', claimed_job.company_id,
        'statementLineId', claimed_job.statement_line_id,
        'expectedStatusVersion', claimed_job.expected_status_version,
        'attempt', claimed_job.attempts + 1, 'leaseToken', token
      ));
      effective_leases := effective_leases + 1;
      -- A snapshot-less claim must stay alone until its snapshot exists.
      exit when claimed_job.batch_id is not null and exists (
        select 1 from public.agent_analysis_batches batch
        where batch.id = claimed_job.batch_id
          and (batch.snapshot_path is null or batch.snapshot_expires_at <= now())
      );
    end loop;

    update public.agent_analysis_org_queue set
      active_leases = (
        select count(*) from public.agent_analysis_jobs leased_job
        where leased_job.company_id = org.company_id and leased_job.state = 'leased' and leased_job.lease_expires_at > now()
      ),
      last_dequeued_at = case when effective_leases > org.active_leases then now() else last_dequeued_at end,
      next_eligible_at = null, updated_at = now()
    where company_id = org.company_id;
  end loop;
  return claims;
end $$;

revoke all on function public.claim_agent_analysis_jobs(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_agent_analysis_jobs(integer, integer) to service_role;

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

  if terminal_state = 'failed' then
    -- Never strand a line invisibly: surface the exhausted analysis to the
    -- bookkeeper instead of leaving the line waiting forever.
    update public.statement_lines set
      status = 'needs_you',
      status_version = status_version + 1,
      note = 'Automatic analysis could not complete after repeated attempts. Open the line to review it with the agent.',
      updated_at = now()
    where id = job.statement_line_id and company_id = job.company_id
      and status = 'new' and status_version = job.expected_status_version
      and active_candidate_set_id is null;
    if found then
      insert into public.line_events(company_id, statement_line_id, from_status, to_status, reason, source, metadata)
      values (job.company_id, job.statement_line_id, 'new', 'needs_you', 'Automatic analysis failed permanently', 'system',
        jsonb_build_object('jobId', job.id, 'error', left(coalesce(p_error, ''), 500)));
    end if;
  end if;

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

  update public.agent_analysis_org_queue set
    active_leases = (
      select count(*) from public.agent_analysis_jobs leased_job
      where leased_job.company_id = job.company_id and leased_job.state = 'leased' and leased_job.lease_expires_at > now()
    ),
    next_eligible_at = case when terminal_state = 'retryable' then now() else null end,
    updated_at = now()
  where company_id = job.company_id;
  return jsonb_build_object('state', terminal_state, 'batchPending', pending_count);
end $$;

revoke all on function public.finish_agent_analysis_job(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.finish_agent_analysis_job(uuid, uuid, text, uuid, text) to service_role;
