create extension if not exists pgcrypto;
create extension if not exists citext;

create type public.member_role as enum ('owner', 'bookkeeper', 'viewer');
create type public.statement_line_status as enum ('new', 'processing', 'needs_you', 'waiting_doc', 'prepared', 'reconciled');
create type public.candidate_kind as enum ('bank_transaction', 'bill', 'invoice', 'transfer');
create type public.candidate_status as enum ('building', 'active', 'settled', 'invalidated');
create type public.candidate_line_role as enum ('primary', 'transfer_source', 'transfer_destination');
create type public.verification_status as enum ('prepared', 'reconciled', 'invalidated');

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  companies_house_number text not null check (companies_house_number ~ '^[A-Z0-9]{8}$'),
  registered_office text not null,
  country_code text not null default 'GB' check (country_code = 'GB'),
  base_currency text check (base_currency is null or base_currency = 'GBP'),
  vat_registered boolean,
  vat_scheme text check (vat_scheme is null or vat_scheme in ('standard', 'cash', 'flat_rate', 'not_applicable')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.company_memberships (
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null default 'bookkeeper',
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (company_id, user_id)
);

create table public.company_invitations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  email citext not null,
  role public.member_role not null default 'bookkeeper',
  token_hash text not null unique,
  invited_by uuid not null references auth.users(id),
  accepted_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (company_id, email)
);

create table public.xero_connections (
  company_id uuid primary key references public.companies(id) on delete cascade,
  tenant_id uuid not null unique,
  tenant_name text not null,
  encrypted_refresh_token text not null,
  scopes text[] not null,
  connected_by uuid not null references auth.users(id),
  connected_at timestamptz not null default now(),
  last_settings_sync_at timestamptz,
  disconnected_at timestamptz
);

create table public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  currency text not null default 'GBP' check (currency = 'GBP'),
  source text not null check (source in ('open_banking', 'csv')),
  external_account_id text,
  xero_account_id uuid,
  created_at timestamptz not null default now(),
  unique (company_id, external_account_id)
);

create table public.ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id) on delete cascade,
  source text not null check (source in ('open_banking', 'csv')),
  source_file_name text,
  status text not null check (status in ('processing', 'complete', 'failed')),
  imported_count integer not null default 0,
  rejected_count integer not null default 0,
  error_summary jsonb not null default '[]',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.statement_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id) on delete restrict,
  ingestion_run_id uuid references public.ingestion_runs(id) on delete set null,
  posted_at date not null,
  amount_minor bigint not null check (amount_minor <> 0),
  currency text not null default 'GBP' check (currency = 'GBP'),
  payee text not null default '',
  description text not null,
  reference text not null default '',
  source_line_id text,
  dedupe_key text not null,
  occurrence integer not null default 1 check (occurrence > 0),
  status public.statement_line_status not null default 'new',
  status_version integer not null default 0 check (status_version >= 0),
  active_candidate_set_id uuid,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bank_account_id, dedupe_key)
);

create table public.candidate_sets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  kind public.candidate_kind not null,
  attempt_number integer not null check (attempt_number > 0),
  status public.candidate_status not null default 'building',
  correlation_token text not null unique,
  invalidation_reason text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.statement_lines
  add constraint statement_lines_active_candidate_fk
  foreign key (active_candidate_set_id) references public.candidate_sets(id) on delete set null;

create unique index statement_lines_one_active_candidate
  on public.statement_lines (id, active_candidate_set_id)
  where active_candidate_set_id is not null;

create table public.candidate_set_lines (
  candidate_set_id uuid not null references public.candidate_sets(id) on delete cascade,
  statement_line_id uuid not null references public.statement_lines(id) on delete restrict,
  role public.candidate_line_role not null,
  required_for_settlement boolean not null default true,
  expected_bank_account_id uuid not null references public.bank_accounts(id),
  expected_amount_minor bigint not null check (expected_amount_minor <> 0),
  verification_status public.verification_status not null default 'prepared',
  primary key (candidate_set_id, statement_line_id),
  unique (candidate_set_id, role)
);

create unique index candidate_set_lines_one_live_attempt
  on public.candidate_set_lines(statement_line_id)
  where verification_status <> 'invalidated';

create table public.xero_objects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  candidate_set_id uuid not null references public.candidate_sets(id) on delete cascade,
  object_type text not null check (object_type in ('bank_transaction', 'bank_transfer', 'invoice', 'payment')),
  object_role text not null check (object_role in ('primary', 'source_transaction', 'destination_transaction', 'parent_document', 'payment')),
  xero_object_id uuid not null,
  xero_status text not null,
  is_reconciled boolean,
  correlation_token text not null,
  correlation_channels text[] not null default '{}',
  observed_payload jsonb not null default '{}',
  observed_at timestamptz,
  deleted_at timestamptz,
  unique (company_id, object_type, xero_object_id),
  unique (candidate_set_id, object_role, xero_object_id)
);

create table public.line_events (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  statement_line_id uuid not null references public.statement_lines(id) on delete cascade,
  candidate_set_id uuid references public.candidate_sets(id) on delete set null,
  from_status public.statement_line_status,
  to_status public.statement_line_status not null,
  reason text not null,
  source text not null check (source in ('system', 'user', 'xero_observation')),
  actor_user_id uuid references auth.users(id),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.outbox_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  topic text not null,
  aggregate_id uuid not null,
  payload jsonb not null,
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  processed_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);

create index statement_lines_company_status_idx on public.statement_lines(company_id, status, posted_at desc);
create index candidate_sets_company_status_idx on public.candidate_sets(company_id, status);
create index outbox_pending_idx on public.outbox_events(available_at) where processed_at is null;

create or replace function public.is_company_member(target_company_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.company_memberships where company_id = target_company_id and user_id = auth.uid()) $$;

create or replace function public.is_company_owner(target_company_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.company_memberships where company_id = target_company_id and user_id = auth.uid() and role = 'owner') $$;

create or replace function public.create_company_onboarding(
  p_legal_name text, p_companies_house_number text, p_registered_office text
) returns public.companies language plpgsql security definer set search_path = public
as $$
declare created public.companies;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  insert into public.companies(legal_name, companies_house_number, registered_office)
  values (p_legal_name, upper(p_companies_house_number), p_registered_office) returning * into created;
  insert into public.company_memberships(company_id, user_id, role) values (created.id, auth.uid(), 'owner');
  return created;
end $$;

grant execute on function public.create_company_onboarding(text, text, text) to authenticated;

alter table public.companies enable row level security;
alter table public.company_memberships enable row level security;
alter table public.company_invitations enable row level security;
alter table public.xero_connections enable row level security;
alter table public.bank_accounts enable row level security;
alter table public.ingestion_runs enable row level security;
alter table public.statement_lines enable row level security;
alter table public.candidate_sets enable row level security;
alter table public.candidate_set_lines enable row level security;
alter table public.xero_objects enable row level security;
alter table public.line_events enable row level security;
alter table public.outbox_events enable row level security;

create policy companies_member_read on public.companies for select using (public.is_company_member(id));
create policy companies_owner_update on public.companies for update using (public.is_company_owner(id)) with check (public.is_company_owner(id));
create policy memberships_member_read on public.company_memberships for select using (public.is_company_member(company_id));
create policy memberships_owner_write on public.company_memberships for all using (public.is_company_owner(company_id)) with check (public.is_company_owner(company_id));
create policy invitations_member_read on public.company_invitations for select using (public.is_company_member(company_id));
create policy invitations_owner_write on public.company_invitations for all using (public.is_company_owner(company_id)) with check (public.is_company_owner(company_id));

do $$
declare table_name text;
begin
  foreach table_name in array array['bank_accounts','ingestion_runs','statement_lines'] loop
    execute format('create policy %I_member_all on public.%I for all using (public.is_company_member(company_id)) with check (public.is_company_member(company_id))', table_name, table_name);
  end loop;
  foreach table_name in array array['xero_connections','candidate_sets','xero_objects','line_events','outbox_events'] loop
    execute format('create policy %I_member_read on public.%I for select using (public.is_company_member(company_id))', table_name, table_name);
  end loop;
end $$;

create policy candidate_set_lines_member_read on public.candidate_set_lines for select using (
  exists(select 1 from public.candidate_sets c where c.id = candidate_set_id and public.is_company_member(c.company_id))
);

-- Candidate creation, Xero writes and observation transitions are intentionally service-role only.
-- Clients may read those records but cannot forge prepared/reconciled states.

create or replace function public.validate_candidate_membership()
returns trigger language plpgsql set search_path = public as $$
declare candidate_company uuid; line_company uuid; line_bank uuid; line_amount bigint;
begin
  select company_id into candidate_company from public.candidate_sets where id = new.candidate_set_id;
  select company_id, bank_account_id, amount_minor into line_company, line_bank, line_amount from public.statement_lines where id = new.statement_line_id;
  if candidate_company is distinct from line_company then raise exception 'Candidate cannot cross companies'; end if;
  if new.expected_bank_account_id is distinct from line_bank or new.expected_amount_minor is distinct from line_amount then
    raise exception 'Candidate fingerprint must match the immutable statement line';
  end if;
  return new;
end $$;
create trigger candidate_membership_guard before insert or update on public.candidate_set_lines for each row execute function public.validate_candidate_membership();

create or replace function public.enforce_transfer_shape()
returns trigger language plpgsql set search_path = public as $$
declare source_count integer; destination_count integer; candidate_kind public.candidate_kind;
begin
  select kind into candidate_kind from public.candidate_sets where id = coalesce(new.candidate_set_id, old.candidate_set_id);
  if candidate_kind = 'transfer' then
    select count(*) filter(where role='transfer_source'), count(*) filter(where role='transfer_destination')
      into source_count, destination_count from public.candidate_set_lines where candidate_set_id = coalesce(new.candidate_set_id, old.candidate_set_id);
    -- Deferred constraint checks final transaction shape; a transfer must share exactly two statement lines.
    if source_count <> 1 or destination_count <> 1 then raise exception 'A transfer has exactly one source and one destination'; end if;
  end if;
  return null;
end $$;
create constraint trigger transfer_shape_guard after insert or update or delete on public.candidate_set_lines deferrable initially deferred for each row execute function public.enforce_transfer_shape();

create or replace function public.apply_candidate_observation(
  p_candidate_set_id uuid,
  p_object_updates jsonb,
  p_line_results jsonb,
  p_candidate_status public.candidate_status,
  p_invalidation_reason text default null
) returns void language plpgsql security definer set search_path = public as $$
declare candidate_company uuid; result jsonb; old_status public.statement_line_status; new_status public.statement_line_status;
begin
  select company_id into candidate_company from public.candidate_sets where id = p_candidate_set_id for update;
  if candidate_company is null then raise exception 'Candidate set not found'; end if;
  update public.candidate_sets set status = p_candidate_status, invalidation_reason = p_invalidation_reason, updated_at = now() where id = p_candidate_set_id;

  update public.xero_objects xo set
    xero_status = coalesce(update_row.value->>'xeroStatus', xo.xero_status),
    is_reconciled = coalesce((update_row.value->>'isReconciled')::boolean, xo.is_reconciled),
    observed_payload = coalesce(update_row.value->'payload', xo.observed_payload),
    observed_at = now(),
    deleted_at = case when update_row.value->>'xeroStatus' = 'DELETED' then now() else xo.deleted_at end
  from jsonb_array_elements(p_object_updates) update_row
  where xo.candidate_set_id = p_candidate_set_id and xo.xero_object_id = (update_row.value->>'xeroObjectId')::uuid;

  for result in select value from jsonb_array_elements(p_line_results) loop
    select status into old_status from public.statement_lines where id = (result->>'statementLineId')::uuid for update;
    new_status := (result->>'status')::public.statement_line_status;
    update public.candidate_set_lines set verification_status = (result->>'verificationStatus')::public.verification_status
      where candidate_set_id = p_candidate_set_id and statement_line_id = (result->>'statementLineId')::uuid;
    update public.statement_lines set status = new_status, status_version = status_version + 1,
      active_candidate_set_id = case when new_status = 'needs_you' then null else p_candidate_set_id end,
      note = result->>'reason', updated_at = now()
      where id = (result->>'statementLineId')::uuid and company_id = candidate_company;
    insert into public.line_events(company_id, statement_line_id, candidate_set_id, from_status, to_status, reason, source, metadata)
      values(candidate_company, (result->>'statementLineId')::uuid, p_candidate_set_id, old_status, new_status, result->>'reason', 'xero_observation', result);
  end loop;
end $$;
revoke all on function public.apply_candidate_observation(uuid, jsonb, jsonb, public.candidate_status, text) from public, anon, authenticated;
grant execute on function public.apply_candidate_observation(uuid, jsonb, jsonb, public.candidate_status, text) to service_role;
