-- A completed agent run is workflow progress even though it does not prepare
-- or reconcile anything. Collapse every review outcome into one user-facing
-- state: needs_you. The raw thread contains the detailed reason.
create or replace function public.mark_agent_review_required(
  p_company_id uuid,
  p_line_id uuid,
  p_expected_status_version integer,
  p_run_id uuid,
  p_outcome text,
  p_proposed_operation text,
  p_summary text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  line public.statement_lines;
  old_status public.statement_line_status;
  next_note text;
begin
  if p_outcome not in ('recommend_candidate', 'needs_information', 'needs_review') then raise exception 'Unsupported agent outcome'; end if;
  if p_proposed_operation not in ('create_new', 'match_existing', 'request_information', 'human_review') then raise exception 'Unsupported agent operation'; end if;

  select * into line from public.statement_lines where id = p_line_id and company_id = p_company_id for update;
  if line.id is null then raise exception 'Statement line not found'; end if;
  if line.status_version <> p_expected_status_version then raise exception 'Statement line changed while the agent was running'; end if;
  if line.active_candidate_set_id is not null or line.status in ('prepared', 'reconciled') then raise exception 'A prepared or reconciled line cannot return to agent review'; end if;

  old_status := line.status;
  next_note := case p_outcome
    when 'recommend_candidate' then 'Agent recommendation is ready for review.'
    when 'needs_information' then 'Agent needs information before it can recommend a candidate.'
    else 'Agent analysis needs your judgement.'
  end;

  update public.statement_lines set
    status = 'needs_you', status_version = status_version + 1,
    note = next_note, updated_at = now()
  where id = line.id;

  insert into public.line_events(
    company_id, statement_line_id, from_status, to_status,
    reason, source, metadata
  ) values (
    p_company_id, line.id, old_status, 'needs_you',
    next_note, 'system', jsonb_build_object(
      'agentRunId', p_run_id,
      'outcome', p_outcome,
      'proposedOperation', p_proposed_operation,
      'summary', left(p_summary, 1000)
    )
  );

  return jsonb_build_object(
    'status', 'needs_you',
    'statusVersion', line.status_version + 1,
    'note', next_note
  );
end $$;

revoke all on function public.mark_agent_review_required(uuid, uuid, integer, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.mark_agent_review_required(uuid, uuid, integer, uuid, text, text, text) to service_role;
