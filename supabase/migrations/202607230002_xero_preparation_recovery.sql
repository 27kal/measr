alter table public.candidate_sets
  add column preparation_state text,
  add column preparation_request jsonb not null default '{}',
  add column preparation_fingerprint text,
  add column xero_idempotency_key text,
  add column xero_write_started_at timestamptz,
  add column xero_write_succeeded_at timestamptz,
  add column recovery_attempts integer not null default 0,
  add column last_preparation_error text;

update public.candidate_sets
set preparation_state = case when status = 'building' then 'recovery_needed' else 'committed' end;

alter table public.candidate_sets
  alter column preparation_state set not null,
  alter column preparation_state set default 'creating',
  add constraint candidate_sets_preparation_state_check
    check (preparation_state in ('creating', 'created_in_xero', 'committed', 'recovery_needed')),
  add constraint candidate_sets_preparation_fingerprint_check
    check (preparation_fingerprint is null or preparation_fingerprint ~ '^[0-9a-f]{64}$'),
  add constraint candidate_sets_recovery_attempts_check
    check (recovery_attempts >= 0);

create unique index candidate_sets_xero_idempotency_key_idx
  on public.candidate_sets(xero_idempotency_key)
  where xero_idempotency_key is not null;

create index candidate_sets_recovery_idx
  on public.candidate_sets(preparation_state, updated_at)
  where preparation_state <> 'committed';

create or replace function public.reserve_xero_preparation(
  p_company_id uuid,
  p_kind public.candidate_kind,
  p_created_by uuid,
  p_line_specs jsonb,
  p_preparation_request jsonb,
  p_preparation_fingerprint text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  spec_count integer;
  found_count integer;
  primary_line_id uuid;
  existing public.candidate_sets;
  created public.candidate_sets;
  next_attempt integer;
  token text;
  idempotency_key text;
begin
  if jsonb_typeof(p_line_specs) <> 'array' then raise exception 'Line specifications must be an array'; end if;
  spec_count := jsonb_array_length(p_line_specs);
  if spec_count not in (1, 2) then raise exception 'A candidate requires one line, or two lines for a transfer'; end if;
  if p_preparation_fingerprint !~ '^[0-9a-f]{64}$' then raise exception 'Invalid preparation fingerprint'; end if;

  select (spec->>'statementLineId')::uuid into primary_line_id
  from jsonb_array_elements(p_line_specs) spec
  where (p_kind = 'transfer' and spec->>'role' = 'transfer_source')
     or (p_kind <> 'transfer' and spec->>'role' = 'primary')
  limit 1;
  if primary_line_id is null then raise exception 'Candidate has no primary statement line'; end if;

  perform 1 from public.statement_lines line
  where line.company_id = p_company_id
    and line.id in (select (spec->>'statementLineId')::uuid from jsonb_array_elements(p_line_specs) spec)
  order by line.id for update;
  select count(*) into found_count from public.statement_lines line
  where line.company_id = p_company_id
    and line.id in (select (spec->>'statementLineId')::uuid from jsonb_array_elements(p_line_specs) spec);
  if found_count <> spec_count then raise exception 'Statement line changed; refresh and try again'; end if;

  select candidate.* into existing
  from public.candidate_sets candidate
  join public.candidate_set_lines member on member.candidate_set_id = candidate.id
  where member.statement_line_id = primary_line_id and member.verification_status <> 'invalidated'
  order by candidate.created_at desc limit 1;

  if existing.id is not null then
    if existing.company_id <> p_company_id or existing.kind <> p_kind then
      raise exception 'Statement line already belongs to a different live candidate';
    end if;
    if existing.preparation_fingerprint is distinct from p_preparation_fingerprint
       or existing.preparation_request is distinct from p_preparation_request then
      raise exception 'Retry does not match the reserved accounting request';
    end if;
    return jsonb_build_object(
      'candidateSetId', existing.id,
      'correlationToken', existing.correlation_token,
      'idempotencyKey', existing.xero_idempotency_key,
      'preparationState', existing.preparation_state,
      'reused', true
    );
  end if;

  if exists(
    select 1 from public.statement_lines line
    where line.id in (select (spec->>'statementLineId')::uuid from jsonb_array_elements(p_line_specs) spec)
      and line.active_candidate_set_id is not null
  ) then raise exception 'Statement line changed; refresh and try again'; end if;

  select coalesce(max(candidate.attempt_number), 0) + 1 into next_attempt
  from public.candidate_sets candidate
  join public.candidate_set_lines member on member.candidate_set_id = candidate.id
  where member.statement_line_id = primary_line_id;
  token := 'WB-' || upper(substr(replace(primary_line_id::text, '-', ''), 1, 20)) || '-A' || next_attempt;
  idempotency_key := gen_random_uuid()::text;

  insert into public.candidate_sets(
    company_id, kind, attempt_number, status, correlation_token, created_by,
    preparation_state, preparation_request, preparation_fingerprint, xero_idempotency_key
  ) values (
    p_company_id, p_kind, next_attempt, 'building', token, p_created_by,
    'creating', p_preparation_request, p_preparation_fingerprint, idempotency_key
  ) returning * into created;

  insert into public.candidate_set_lines(
    candidate_set_id, statement_line_id, role, expected_bank_account_id,
    expected_amount_minor, expected_posted_at, verification_status
  )
  select created.id, line.id, (spec->>'role')::public.candidate_line_role,
    line.bank_account_id, line.amount_minor, line.posted_at, 'prepared'
  from jsonb_array_elements(p_line_specs) spec
  join public.statement_lines line on line.id = (spec->>'statementLineId')::uuid;

  return jsonb_build_object(
    'candidateSetId', created.id,
    'correlationToken', token,
    'idempotencyKey', idempotency_key,
    'preparationState', 'creating',
    'reused', false
  );
end $$;

create or replace function public.mark_xero_preparation_started(p_candidate_set_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.candidate_sets set
    preparation_state = 'creating',
    xero_write_started_at = now(),
    last_preparation_error = null,
    updated_at = now()
  where id = p_candidate_set_id and status = 'building';
  if not found then raise exception 'Preparation is not writable'; end if;
end $$;

create or replace function public.mark_xero_preparation_recovery(p_candidate_set_id uuid, p_error text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.candidate_sets set
    preparation_state = 'recovery_needed',
    recovery_attempts = recovery_attempts + 1,
    last_preparation_error = left(p_error, 2000),
    updated_at = now()
  where id = p_candidate_set_id and status = 'building';
end $$;

create or replace function public.commit_xero_preparation(
  p_candidate_set_id uuid,
  p_xero_objects jsonb,
  p_recovered boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  candidate public.candidate_sets;
  member record;
  old_status public.statement_line_status;
  object_count integer;
begin
  select * into candidate from public.candidate_sets where id = p_candidate_set_id for update;
  if candidate.id is null then raise exception 'Candidate set not found'; end if;
  if candidate.preparation_state = 'committed' then
    return jsonb_build_object('candidateSetId', candidate.id, 'committed', true, 'alreadyCommitted', true);
  end if;
  if candidate.status <> 'building' then raise exception 'Candidate is no longer being prepared'; end if;
  if jsonb_typeof(p_xero_objects) <> 'array' or jsonb_array_length(p_xero_objects) = 0 then
    raise exception 'At least one Xero object is required';
  end if;

  insert into public.xero_objects(
    company_id, candidate_set_id, object_type, object_role, xero_object_id,
    xero_status, is_reconciled, correlation_token, correlation_channels,
    observed_payload, observed_at
  )
  select candidate.company_id, candidate.id,
    object->>'objectType', object->>'objectRole', (object->>'xeroObjectId')::uuid,
    coalesce(object->>'xeroStatus', 'AUTHORISED'), (object->>'isReconciled')::boolean,
    candidate.correlation_token,
    array(select jsonb_array_elements_text(coalesce(object->'correlationChannels', '[]'::jsonb))),
    coalesce(object->'observedPayload', '{}'::jsonb), now()
  from jsonb_array_elements(p_xero_objects) object;
  get diagnostics object_count = row_count;

  for member in
    select membership.statement_line_id
    from public.candidate_set_lines membership
    where membership.candidate_set_id = candidate.id
    order by membership.statement_line_id
  loop
    select status into old_status from public.statement_lines where id = member.statement_line_id for update;
    update public.statement_lines set
      status = 'prepared', status_version = status_version + 1,
      active_candidate_set_id = candidate.id,
      note = case when p_recovered
        then 'Recovered the existing Xero candidate after a local persistence failure. Open Xero to reconcile this statement line.'
        else 'Candidate created in Xero. Open Xero to reconcile this statement line.' end,
      updated_at = now()
    where id = member.statement_line_id and company_id = candidate.company_id;
    insert into public.line_events(
      company_id, statement_line_id, candidate_set_id, from_status, to_status,
      reason, source, metadata
    ) values (
      candidate.company_id, member.statement_line_id, candidate.id, old_status, 'prepared',
      case when p_recovered then 'Existing Xero candidate recovered and attached.' else 'Candidate created in Xero.' end,
      'system', jsonb_build_object('recovered', p_recovered)
    );
  end loop;

  update public.candidate_sets set
    status = 'active', preparation_state = 'committed',
    xero_write_succeeded_at = coalesce(xero_write_succeeded_at, now()),
    last_preparation_error = null, updated_at = now()
  where id = candidate.id;

  insert into public.outbox_events(company_id, topic, aggregate_id, payload)
  values(candidate.company_id, 'xero.candidate.observe', candidate.id, jsonb_build_object('candidateSetId', candidate.id));

  return jsonb_build_object(
    'candidateSetId', candidate.id, 'committed', true,
    'alreadyCommitted', false, 'xeroObjectCount', object_count, 'recovered', p_recovered
  );
end $$;

revoke all on function public.reserve_xero_preparation(uuid, public.candidate_kind, uuid, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.mark_xero_preparation_started(uuid) from public, anon, authenticated;
revoke all on function public.mark_xero_preparation_recovery(uuid, text) from public, anon, authenticated;
revoke all on function public.commit_xero_preparation(uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.reserve_xero_preparation(uuid, public.candidate_kind, uuid, jsonb, jsonb, text) to service_role;
grant execute on function public.mark_xero_preparation_started(uuid) to service_role;
grant execute on function public.mark_xero_preparation_recovery(uuid, text) to service_role;
grant execute on function public.commit_xero_preparation(uuid, jsonb, boolean) to service_role;
