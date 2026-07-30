-- Attach accounting objects which Xero already reports as reconciled. This is
-- observation-only: no Xero write or user accounting decision occurs here.
-- One invoice may legitimately have several independently reconciled partial
-- payments. Payment and bank-transaction IDs remain globally single-use;
-- parent invoice references may therefore appear in several candidate sets.
alter table public.xero_objects
  drop constraint if exists xero_objects_company_id_object_type_xero_object_id_key;
create unique index if not exists xero_objects_single_bank_movement_idx
  on public.xero_objects(company_id, object_type, xero_object_id)
  where object_role <> 'parent_document';

create or replace function public.commit_observed_xero_reconciliation(
  p_company_id uuid,
  p_line_id uuid,
  p_expected_status_version integer,
  p_kind public.candidate_kind,
  p_created_by uuid,
  p_observation jsonb,
  p_observation_fingerprint text,
  p_xero_objects jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  line public.statement_lines;
  created public.candidate_sets;
  next_attempt integer;
  token text;
  object_count integer;
begin
  if p_kind not in ('bank_transaction', 'bill', 'invoice') then raise exception 'Unsupported observed reconciliation kind'; end if;
  if p_observation->>'mode' <> 'observed_xero_reconciliation' then raise exception 'Observation has the wrong mode'; end if;
  if p_observation_fingerprint !~ '^[0-9a-f]{64}$' then raise exception 'Invalid observation fingerprint'; end if;
  if jsonb_typeof(p_xero_objects) <> 'array' or jsonb_array_length(p_xero_objects) = 0 then raise exception 'At least one Xero object is required'; end if;

  if p_kind = 'bank_transaction' and not exists(
    select 1 from jsonb_array_elements(p_xero_objects) object
    where object->>'objectType' = 'bank_transaction' and object->>'objectRole' = 'primary'
      and coalesce((object->>'isReconciled')::boolean, false)
      and coalesce(object->>'xeroStatus', '') <> 'DELETED'
  ) then raise exception 'A reconciled bank transaction is required'; end if;

  if p_kind in ('bill', 'invoice') and not exists(
    select 1 from jsonb_array_elements(p_xero_objects) object
    where object->>'objectType' = 'payment' and object->>'objectRole' = 'payment'
      and coalesce((object->>'isReconciled')::boolean, false)
      and coalesce(object->>'xeroStatus', '') = 'AUTHORISED'
      and object->'observedPayload'->'Invoice'->>'Type' = case when p_kind = 'bill' then 'ACCPAY' else 'ACCREC' end
  ) then raise exception 'A reconciled Xero payment with the correct document type is required'; end if;

  select * into line from public.statement_lines where id = p_line_id and company_id = p_company_id for update;
  if line.id is null then raise exception 'Statement line not found'; end if;
  if line.active_candidate_set_id is not null or line.status in ('prepared', 'reconciled') then
    return jsonb_build_object('lineId', line.id, 'status', line.status, 'alreadyCommitted', true);
  end if;
  if line.status_version <> p_expected_status_version then raise exception 'Statement line changed during Xero reconciliation preflight'; end if;

  if exists(
    select 1 from public.xero_objects stored
    join jsonb_array_elements(p_xero_objects) object
      on stored.xero_object_id = (object->>'xeroObjectId')::uuid
     and stored.object_type = object->>'objectType'
    where stored.company_id = p_company_id
  ) then raise exception 'The observed Xero object is already linked to another Workbench line'; end if;

  select coalesce(max(candidate.attempt_number), 0) + 1 into next_attempt
  from public.candidate_sets candidate
  join public.candidate_set_lines member on member.candidate_set_id = candidate.id
  where member.statement_line_id = line.id;
  token := 'WB-' || upper(substr(replace(line.id::text, '-', ''), 1, 20)) || '-A' || next_attempt;

  insert into public.candidate_sets(
    company_id, kind, attempt_number, status, correlation_token, created_by,
    preparation_state, preparation_request, preparation_fingerprint
  ) values (
    p_company_id, p_kind, next_attempt, 'settled', token, p_created_by,
    'committed', p_observation, p_observation_fingerprint
  ) returning * into created;

  insert into public.candidate_set_lines(
    candidate_set_id, statement_line_id, role, expected_bank_account_id,
    expected_amount_minor, expected_posted_at, verification_status
  ) values (created.id, line.id, 'primary', line.bank_account_id, line.amount_minor, line.posted_at, 'reconciled');

  insert into public.xero_objects(
    company_id, candidate_set_id, object_type, object_role, xero_object_id,
    xero_status, is_reconciled, correlation_token, correlation_channels,
    observed_payload, observed_at
  )
  select p_company_id, created.id, object->>'objectType', object->>'objectRole',
    (object->>'xeroObjectId')::uuid, object->>'xeroStatus',
    coalesce((object->>'isReconciled')::boolean, false), token,
    array(select jsonb_array_elements_text(coalesce(object->'correlationChannels', '["local_only"]'::jsonb))),
    coalesce(object->'observedPayload', '{}'::jsonb), now()
  from jsonb_array_elements(p_xero_objects) object;
  get diagnostics object_count = row_count;

  update public.statement_lines set
    status = 'reconciled', status_version = status_version + 1,
    active_candidate_set_id = created.id,
    note = 'Matched to an existing reconciliation observed in Xero.',
    updated_at = now()
  where id = line.id;

  insert into public.line_events(
    company_id, statement_line_id, candidate_set_id, from_status, to_status,
    reason, source, actor_user_id, metadata
  ) values (
    p_company_id, line.id, created.id, line.status, 'reconciled',
    'Existing reconciled Xero ledger movement matched by account, signed amount and date.',
    'xero_observation', p_created_by,
    jsonb_build_object('mode', 'observed_xero_reconciliation', 'fingerprint', p_observation_fingerprint, 'objectCount', object_count)
  );

  insert into public.outbox_events(company_id, topic, aggregate_id, payload)
  values(p_company_id, 'xero.candidate.observe', created.id, jsonb_build_object('candidateSetId', created.id));

  return jsonb_build_object('lineId', line.id, 'candidateSetId', created.id, 'status', 'reconciled', 'alreadyCommitted', false);
end $$;

create or replace function public.mark_xero_reconciliation_ambiguous(
  p_company_id uuid,
  p_line_id uuid,
  p_expected_status_version integer,
  p_reason text,
  p_candidates jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  line public.statement_lines;
  next_note text := 'Possible existing Xero reconciliation needs review. No new Xero record was created.';
begin
  if jsonb_typeof(p_candidates) <> 'array' or jsonb_array_length(p_candidates) = 0 then raise exception 'At least one possible Xero movement is required'; end if;
  select * into line from public.statement_lines where id = p_line_id and company_id = p_company_id for update;
  if line.id is null then raise exception 'Statement line not found'; end if;
  if line.active_candidate_set_id is not null or line.status in ('prepared', 'reconciled') then return jsonb_build_object('lineId', line.id, 'status', line.status, 'changed', false); end if;
  if line.status = 'needs_you' and line.note = next_note then return jsonb_build_object('lineId', line.id, 'status', line.status, 'changed', false); end if;
  if line.status_version <> p_expected_status_version then raise exception 'Statement line changed during Xero reconciliation preflight'; end if;

  update public.statement_lines set status = 'needs_you', status_version = status_version + 1, note = next_note, updated_at = now() where id = line.id;
  insert into public.line_events(company_id, statement_line_id, from_status, to_status, reason, source, metadata)
  values(p_company_id, line.id, line.status, 'needs_you', left(p_reason, 1000), 'xero_observation', jsonb_build_object('mode', 'ambiguous_xero_reconciliation', 'candidates', p_candidates));
  return jsonb_build_object('lineId', line.id, 'status', 'needs_you', 'changed', true);
end $$;

revoke all on function public.commit_observed_xero_reconciliation(uuid, uuid, integer, public.candidate_kind, uuid, jsonb, text, jsonb) from public, anon, authenticated;
revoke all on function public.mark_xero_reconciliation_ambiguous(uuid, uuid, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.commit_observed_xero_reconciliation(uuid, uuid, integer, public.candidate_kind, uuid, jsonb, text, jsonb) to service_role;
grant execute on function public.mark_xero_reconciliation_ambiguous(uuid, uuid, integer, text, jsonb) to service_role;
