-- Xero rejected the documentation's four-concatenated-UUID example at 144
-- characters. The only affected live reservation received a definite 400, so
-- no external object exists and rotating its untouched key is safe.
update public.candidate_sets
set xero_idempotency_key = gen_random_uuid()::text, updated_at = now()
where status = 'building' and length(xero_idempotency_key) > 128;

alter table public.candidate_sets
  add constraint candidate_sets_xero_idempotency_key_length_check
  check (xero_idempotency_key is null or length(xero_idempotency_key) <= 128);

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

revoke all on function public.reserve_xero_preparation(uuid, public.candidate_kind, uuid, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.reserve_xero_preparation(uuid, public.candidate_kind, uuid, jsonb, jsonb, text) to service_role;
