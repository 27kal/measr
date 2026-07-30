-- Re-leasing a statement import erased the previous attempt's error, so a
-- worker that later died silently left no evidence of what went wrong. Keep
-- the last recorded error across claims: a successful finish overwrites it,
-- and the expired-lease sweep's coalesce now preserves a real message from an
-- earlier attempt instead of substituting a generic one.

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
    set status = case when attempts >= 3 then 'failed' else 'retryable' end,
        lease_token = null, lease_expires_at = null,
        available_at = now(),
        last_error = coalesce(last_error, case when attempts >= 3
          then 'Extraction repeatedly exceeded the worker time budget. The statement is too large for one extraction pass; upload it in shorter periods.'
          else 'Worker lease expired' end),
        completed_at = case when attempts >= 3 then now() else completed_at end,
        updated_at = now()
    where status = 'processing' and lease_expires_at <= now();

  update public.statement_imports
    set status = 'failed',
        last_error = coalesce(last_error, 'Extraction repeatedly exceeded the worker time budget. The statement is too large for one extraction pass; upload it in shorter periods.'),
        completed_at = coalesce(completed_at, now()), updated_at = now()
    where status in ('queued', 'retryable') and attempts >= 3;

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
          and pending.attempts < 3
      )
    order by queue.last_dequeued_at nulls first, queue.company_id
    for update skip locked
    limit p_limit
  loop
    select pending.* into claimed_import
    from public.statement_imports pending
    where pending.company_id = org.company_id
      and pending.status in ('queued', 'retryable') and pending.available_at <= now()
      and pending.attempts < 3
    order by pending.created_at, pending.id
    for update skip locked
    limit 1;
    if not found then continue; end if;

    token := gen_random_uuid();
    -- last_error deliberately survives the re-lease as diagnostic history.
    update public.statement_imports set
      status = 'processing', attempts = attempts + 1, lease_token = token,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      started_at = coalesce(started_at, now()), updated_at = now()
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

revoke all on function public.claim_statement_imports(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_statement_imports(integer, integer) to service_role;
