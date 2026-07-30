-- Xero observation is an on-demand synchronization operation. It is triggered
-- by product activity (page open/focus or an explicit refresh), not by the
-- worker discovering accounting work on its own. The minute cron remains only
-- as a durable wake-up for explicitly queued retries; an empty claim performs
-- no Xero request.

create or replace function public.enqueue_xero_observation(
  p_company_id uuid,
  p_source text default 'manual'
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  pending_job public.xero_observation_jobs;
begin
  if p_source not in ('scheduled', 'manual') then raise exception 'Unsupported observation source'; end if;
  if auth.role() <> 'service_role' and not public.is_company_member(p_company_id) then
    raise exception 'Company access required';
  end if;
  if not exists (
    select 1 from public.xero_connections where company_id = p_company_id and disconnected_at is null
  ) then raise exception 'Xero is not connected'; end if;

  select * into pending_job
  from public.xero_observation_jobs
  where company_id = p_company_id and state in ('queued', 'leased', 'retryable')
  order by created_at limit 1;

  if pending_job.id is null then
    insert into public.xero_observation_jobs(company_id, source)
      values (p_company_id, p_source)
      returning * into pending_job;
  end if;

  insert into public.xero_observation_org_queue(company_id, next_eligible_at)
    values (p_company_id, case when pending_job.state = 'retryable' then pending_job.available_at else now() end)
  on conflict (company_id) do update set
    next_eligible_at = case
      when pending_job.state = 'retryable' and pending_job.available_at > now() then pending_job.available_at
      else now()
    end,
    updated_at = now();

  return jsonb_build_object(
    'jobId', pending_job.id,
    'scheduled', true,
    'availableAt', pending_job.available_at
  );
end $$;

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

  for org in
    select queue.company_id, queue.last_full_sweep_at
    from public.xero_observation_org_queue queue
    join public.xero_connections connection on connection.company_id = queue.company_id and connection.disconnected_at is null
    where queue.active_leases = 0
      and queue.next_eligible_at <= now()
      and exists (
        select 1 from public.xero_observation_jobs pending
        where pending.company_id = queue.company_id
          and pending.state in ('queued', 'retryable') and pending.available_at <= now()
      )
    order by queue.last_dequeued_at nulls first, queue.company_id
    for update of queue skip locked
    limit p_limit
  loop
    select * into claimed_job
    from public.xero_observation_jobs pending
    where pending.company_id = org.company_id
      and pending.state in ('queued', 'retryable') and pending.available_at <= now()
    order by pending.created_at, pending.id
    for update skip locked
    limit 1;
    if not found then continue; end if;

    needs_full_sweep := org.last_full_sweep_at is null or org.last_full_sweep_at <= now() - interval '24 hours';
    update public.xero_observation_jobs set full_sweep = full_sweep or needs_full_sweep where id = claimed_job.id;
    claimed_job.full_sweep := claimed_job.full_sweep or needs_full_sweep;

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

create or replace function public.defer_xero_observation_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_error text,
  p_retry_after_seconds integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  job public.xero_observation_jobs;
  resume_at timestamptz;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  select * into job from public.xero_observation_jobs where id = p_job_id for update;
  if job.id is null then raise exception 'Observation job not found'; end if;
  if job.state <> 'leased' or job.lease_token is distinct from p_lease_token then
    raise exception 'Observation lease is no longer current';
  end if;

  resume_at := now() + make_interval(secs => greatest(60, least(coalesce(p_retry_after_seconds, 300), 86400)));
  update public.xero_observation_jobs set
    state = 'retryable',
    attempts = greatest(attempts - 1, 0),
    available_at = resume_at,
    last_error = left(coalesce(p_error, 'Xero rate limit reached'), 2000),
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
  where id = job.id;
  update public.xero_observation_org_queue set
    active_leases = 0,
    next_eligible_at = resume_at,
    last_error = left(coalesce(p_error, 'Xero rate limit reached'), 2000),
    updated_at = now()
  where company_id = job.company_id;
  return jsonb_build_object('state', 'retryable', 'resumeAt', resume_at);
end $$;

revoke all on function public.claim_xero_observation_jobs(integer, integer) from public, anon, authenticated;
revoke all on function public.defer_xero_observation_job(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.claim_xero_observation_jobs(integer, integer) to service_role;
grant execute on function public.defer_xero_observation_job(uuid, uuid, text, integer) to service_role;
