-- A Xero 429 is a tenant-wide scheduling signal, not a failed line-analysis
-- attempt. Honour Retry-After for the whole company and preserve the job's
-- bounded retry budget.

create or replace function public.defer_agent_analysis_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_error text,
  p_retry_after_seconds integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  job public.agent_analysis_jobs;
  resume_at timestamptz;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  select * into job from public.agent_analysis_jobs where id = p_job_id for update;
  if job.id is null then raise exception 'Analysis job not found'; end if;
  if job.state <> 'leased' or job.lease_token is distinct from p_lease_token then
    raise exception 'Analysis lease is no longer current';
  end if;

  resume_at := now() + make_interval(secs => greatest(60, least(coalesce(p_retry_after_seconds, 300), 86400)));
  update public.agent_analysis_jobs set
    state = 'retryable',
    attempts = greatest(attempts - 1, 0),
    available_at = resume_at,
    last_error = left(coalesce(p_error, 'Xero rate limit reached'), 2000),
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
  where id = job.id;

  update public.agent_analysis_batches set status = 'running', updated_at = now()
  where id = job.batch_id and status in ('queued', 'snapshotting', 'running');
  update public.agent_analysis_org_queue set
    active_leases = 0,
    next_eligible_at = resume_at,
    updated_at = now()
  where company_id = job.company_id;

  return jsonb_build_object('state', 'retryable', 'resumeAt', resume_at);
end $$;

revoke all on function public.defer_agent_analysis_job(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.defer_agent_analysis_job(uuid, uuid, text, integer) to service_role;
