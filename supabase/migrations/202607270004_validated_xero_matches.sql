-- A reviewed agent recommendation may attach an existing Xero entity without
-- creating a new Xero record. The raw decision remains in private artifact
-- storage; this function commits only the minimum mapping required for sync.
create or replace function public.commit_validated_xero_match(
  p_company_id uuid,
  p_line_id uuid,
  p_expected_status_version integer,
  p_kind public.candidate_kind,
  p_created_by uuid,
  p_preparation_request jsonb,
  p_preparation_fingerprint text,
  p_xero_object jsonb,
  p_event_metadata jsonb default '{}'
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  line public.statement_lines;
  existing public.candidate_sets;
  created public.candidate_sets;
  next_attempt integer;
  token text;
  expected_object_type text;
  expected_object_role text;
begin
  if p_kind not in ('bank_transaction', 'bill', 'invoice') then raise exception 'Existing transfer matching is not supported by this path'; end if;
  if p_preparation_request->>'mode' <> 'match_existing' then raise exception 'Validated intent has the wrong operation'; end if;
  if p_preparation_fingerprint !~ '^[0-9a-f]{64}$' then raise exception 'Invalid validation fingerprint'; end if;
  if jsonb_typeof(p_xero_object) <> 'object' then raise exception 'One validated Xero object is required'; end if;
  expected_object_type := case when p_kind in ('bill', 'invoice') then 'invoice' else 'bank_transaction' end;
  expected_object_role := case when p_kind in ('bill', 'invoice') then 'parent_document' else 'primary' end;
  if p_xero_object->>'objectType' <> expected_object_type or p_xero_object->>'objectRole' <> expected_object_role then
    raise exception 'Xero object does not match the candidate kind';
  end if;
  if coalesce(p_xero_object->>'xeroStatus', '') <> 'AUTHORISED' then raise exception 'Only an AUTHORISED Xero entity can be prepared'; end if;

  select * into line from public.statement_lines where id = p_line_id and company_id = p_company_id for update;
  if line.id is null then raise exception 'Statement line not found'; end if;

  if line.active_candidate_set_id is not null then
    select * into existing from public.candidate_sets where id = line.active_candidate_set_id;
    if existing.preparation_fingerprint = p_preparation_fingerprint and existing.preparation_request = p_preparation_request and existing.preparation_state = 'committed' then
      return jsonb_build_object('candidateSetId', existing.id, 'committed', true, 'alreadyCommitted', true);
    end if;
    raise exception 'Statement line already belongs to an active candidate';
  end if;
  if line.status_version <> p_expected_status_version or line.status in ('prepared', 'reconciled') then raise exception 'Statement line changed; refresh and run the analysis again'; end if;
  if exists(
    select 1 from public.xero_objects
    where company_id = p_company_id and object_type = expected_object_type
      and xero_object_id = (p_xero_object->>'xeroObjectId')::uuid
  ) then raise exception 'This Xero entity is already mapped to another Workbench candidate'; end if;

  select coalesce(max(candidate.attempt_number), 0) + 1 into next_attempt
  from public.candidate_sets candidate
  join public.candidate_set_lines member on member.candidate_set_id = candidate.id
  where member.statement_line_id = line.id;
  token := 'WB-' || upper(substr(replace(line.id::text, '-', ''), 1, 20)) || '-A' || next_attempt;

  insert into public.candidate_sets(
    company_id, kind, attempt_number, status, correlation_token, created_by,
    preparation_state, preparation_request, preparation_fingerprint
  ) values (
    p_company_id, p_kind, next_attempt, 'active', token, p_created_by,
    'committed', p_preparation_request, p_preparation_fingerprint
  ) returning * into created;

  insert into public.candidate_set_lines(
    candidate_set_id, statement_line_id, role, expected_bank_account_id,
    expected_amount_minor, expected_posted_at, verification_status
  ) values (created.id, line.id, 'primary', line.bank_account_id, line.amount_minor, line.posted_at, 'prepared');

  insert into public.xero_objects(
    company_id, candidate_set_id, object_type, object_role, xero_object_id,
    xero_status, is_reconciled, correlation_token, correlation_channels,
    observed_payload, observed_at
  ) values (
    p_company_id, created.id, expected_object_type, expected_object_role,
    (p_xero_object->>'xeroObjectId')::uuid, p_xero_object->>'xeroStatus',
    coalesce((p_xero_object->>'isReconciled')::boolean, false), token,
    array(select jsonb_array_elements_text(coalesce(p_xero_object->'correlationChannels', '["local_only"]'::jsonb))),
    coalesce(p_xero_object->'observedPayload', '{}'::jsonb), now()
  );

  update public.statement_lines set
    status = 'prepared', status_version = status_version + 1,
    active_candidate_set_id = created.id,
    note = 'Existing Xero entity validated and attached. Open Xero to reconcile this statement line.',
    updated_at = now()
  where id = line.id;

  insert into public.line_events(
    company_id, statement_line_id, candidate_set_id, from_status, to_status,
    reason, source, actor_user_id, metadata
  ) values (
    p_company_id, line.id, created.id, line.status, 'prepared',
    'Existing Xero candidate matched after deterministic validation.', 'user', p_created_by,
    p_event_metadata || jsonb_build_object('operation', 'match_existing', 'xeroObjectType', expected_object_type, 'xeroObjectId', p_xero_object->>'xeroObjectId')
  );

  insert into public.outbox_events(company_id, topic, aggregate_id, payload)
  values(p_company_id, 'xero.candidate.observe', created.id, jsonb_build_object('candidateSetId', created.id));

  return jsonb_build_object('candidateSetId', created.id, 'committed', true, 'alreadyCommitted', false);
end $$;

revoke all on function public.commit_validated_xero_match(uuid, uuid, integer, public.candidate_kind, uuid, jsonb, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.commit_validated_xero_match(uuid, uuid, integer, public.candidate_kind, uuid, jsonb, text, jsonb, jsonb) to service_role;
