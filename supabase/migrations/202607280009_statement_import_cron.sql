-- Recover statement extraction after process crashes or failed asynchronous
-- kicks. Reuse the existing company-fair runner secret; no new credential is
-- introduced.
create or replace function public.configure_statement_import_cron(
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
    perform vault.create_secret(p_runner_secret, 'workbench_agent_runner_secret', 'Authenticates Workbench durable workers');
  else
    perform vault.update_secret(existing_secret_id, p_runner_secret, 'workbench_agent_runner_secret', 'Authenticates Workbench durable workers');
  end if;
  select jobid into existing_job_id from cron.job where jobname = 'workbench-statement-import' limit 1;
  if existing_job_id is not null then perform cron.unschedule(existing_job_id); end if;
  select cron.schedule(
    'workbench-statement-import',
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
      p_project_url || '/functions/v1/statement-import-worker'
    )
  ) into scheduled_job_id;
  return scheduled_job_id;
end $$;

-- Existing deployments already have the analysis cron configured. Clone its
-- command now so this migration becomes durable without another manual setup
-- step. Fresh deployments can call configure_statement_import_cron alongside
-- configure_agent_analysis_cron.
do $$
declare
  analysis_job record;
  existing_job_id bigint;
begin
  select schedule, command into analysis_job from cron.job where jobname = 'workbench-agent-analysis' limit 1;
  if analysis_job.command is null then return; end if;
  select jobid into existing_job_id from cron.job where jobname = 'workbench-statement-import' limit 1;
  if existing_job_id is not null then perform cron.unschedule(existing_job_id); end if;
  perform cron.schedule(
    'workbench-statement-import',
    analysis_job.schedule,
    replace(analysis_job.command, '/agent-analysis-worker', '/statement-import-worker')
  );
end $$;

revoke all on function public.configure_statement_import_cron(text, text) from public, anon, authenticated;
grant execute on function public.configure_statement_import_cron(text, text) to service_role;
