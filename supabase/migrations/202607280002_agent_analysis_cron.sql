create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Deployment calls this once with the generated runner secret. The secret is
-- held in Supabase Vault and is never committed to the repository or cron text.
create or replace function public.configure_agent_analysis_cron(
  p_project_url text,
  p_runner_secret text
) returns bigint language plpgsql security definer set search_path = public, vault, cron as $$
declare
  existing_secret_id uuid;
  existing_job_id bigint;
  scheduled_job_id bigint;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if p_project_url !~ '^https://[a-z0-9-]+\.supabase\.co$' then raise exception 'Invalid Supabase project URL'; end if;
  if length(p_runner_secret) < 32 then raise exception 'Runner secret is too short'; end if;

  select id into existing_secret_id from vault.secrets where name = 'workbench_agent_runner_secret' limit 1;
  if existing_secret_id is null then
    perform vault.create_secret(p_runner_secret, 'workbench_agent_runner_secret', 'Authenticates the Workbench analysis cron worker');
  else
    perform vault.update_secret(existing_secret_id, p_runner_secret, 'workbench_agent_runner_secret', 'Authenticates the Workbench analysis cron worker');
  end if;

  select jobid into existing_job_id from cron.job where jobname = 'workbench-agent-analysis' limit 1;
  if existing_job_id is not null then perform cron.unschedule(existing_job_id); end if;

  select cron.schedule(
    'workbench-agent-analysis',
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
      p_project_url || '/functions/v1/agent-analysis-worker'
    )
  ) into scheduled_job_id;
  return scheduled_job_id;
end $$;

revoke all on function public.configure_agent_analysis_cron(text, text) from public, anon, authenticated;
grant execute on function public.configure_agent_analysis_cron(text, text) to service_role;
