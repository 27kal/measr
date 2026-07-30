-- Continuous polling previously accumulated stale failures even when no
-- observation was pending. They are not actionable in the on-demand model.

update public.xero_observation_org_queue queue set
  consecutive_failures = 0,
  last_error = null,
  next_eligible_at = now(),
  updated_at = now()
where not exists (
  select 1 from public.xero_observation_jobs job
  where job.company_id = queue.company_id and job.state in ('queued', 'leased', 'retryable')
);
