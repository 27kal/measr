-- Reuse the same Vault-held secret as the durable analysis runner. The cron is
-- a recovery trigger; successful workers self-chain while due work remains.
create or replace function public.configure_xero_observation_cron(
  p_project_url text
) returns bigint language plpgsql security definer set search_path = public, vault, cron as $$
declare
  existing_job_id bigint;
  scheduled_job_id bigint;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if p_project_url !~ '^https://[a-z0-9-]+\.supabase\.co$' then raise exception 'Invalid Supabase project URL'; end if;
  if not exists (select 1 from vault.secrets where name = 'workbench_agent_runner_secret') then
    raise exception 'Workbench runner secret is not configured';
  end if;

  select jobid into existing_job_id from cron.job where jobname = 'workbench-xero-observation' limit 1;
  if existing_job_id is not null then perform cron.unschedule(existing_job_id); end if;

  select cron.schedule(
    'workbench-xero-observation',
    '* * * * *',
    format(
      $command$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-workbench-runner-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'workbench_agent_runner_secret')
        ),
        body := '{}'::jsonb
      );
      $command$,
      p_project_url || '/functions/v1/xero-observation-worker'
    )
  ) into scheduled_job_id;
  return scheduled_job_id;
end $$;

revoke all on function public.configure_xero_observation_cron(text) from public, anon, authenticated;
grant execute on function public.configure_xero_observation_cron(text) to service_role;
