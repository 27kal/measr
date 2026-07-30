-- While a batch has no valid immutable Xero snapshot, only its first pending
-- job may be claimed. A transient snapshot failure therefore backs off that
-- one job instead of letting every line repeat the same Xero reads.

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
        select 1
        from public.agent_analysis_jobs pending
        join public.agent_analysis_batches batch on batch.id = pending.batch_id
        where pending.company_id = queue.company_id
          and pending.state in ('queued', 'retryable')
          and pending.available_at <= now()
          and (
            (batch.snapshot_path is not null and batch.snapshot_expires_at > now())
            or not exists (
              select 1 from public.agent_analysis_jobs earlier
              where earlier.batch_id = pending.batch_id
                and earlier.state in ('queued', 'leased', 'retryable')
                and (earlier.created_at, earlier.id) < (pending.created_at, pending.id)
            )
          )
      )
    order by queue.last_dequeued_at nulls first, queue.company_id
    for update skip locked
    limit p_limit
  loop
    select pending.* into claimed_job
    from public.agent_analysis_jobs pending
    join public.agent_analysis_batches batch on batch.id = pending.batch_id
    where pending.company_id = org.company_id
      and pending.state in ('queued', 'retryable')
      and pending.available_at <= now()
      and (
        (batch.snapshot_path is not null and batch.snapshot_expires_at > now())
        or not exists (
          select 1 from public.agent_analysis_jobs earlier
          where earlier.batch_id = pending.batch_id
            and earlier.state in ('queued', 'leased', 'retryable')
            and (earlier.created_at, earlier.id) < (pending.created_at, pending.id)
        )
      )
    order by pending.created_at, pending.id
    for update of pending skip locked
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
      status = case when snapshot_path is null or snapshot_expires_at <= now() then 'snapshotting' else 'running' end,
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

revoke all on function public.claim_agent_analysis_jobs(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_agent_analysis_jobs(integer, integer) to service_role;
