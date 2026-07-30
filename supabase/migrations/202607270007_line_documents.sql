-- Private source documents are durable sync inputs, not normalized agent
-- decisions. The row tracks the two external deliveries (agent and Xero);
-- the reasoning and decision remain in the raw line-thread artifact.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'agent-artifacts',
  'agent-artifacts',
  false,
  10485760,
  array[
    'application/json',
    'text/markdown',
    'text/plain',
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  statement_line_id uuid not null references public.statement_lines(id) on delete cascade,
  storage_key text not null unique,
  filename text not null,
  mime_type text not null check (mime_type in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  byte_size integer not null check (byte_size > 0 and byte_size <= 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  source text not null default 'user_upload' check (source in ('user_upload', 'xero_attachment')),
  analysis_status text not null default 'pending' check (analysis_status in ('pending', 'processing', 'analysed', 'failed')),
  analysis_error text,
  candidate_set_id uuid references public.candidate_sets(id) on delete set null,
  xero_object_type text check (xero_object_type is null or xero_object_type in ('bank_transaction', 'invoice', 'bank_transfer')),
  xero_object_id uuid,
  xero_filename text,
  xero_attachment_id uuid,
  xero_uploaded_at timestamptz,
  xero_upload_error text,
  uploaded_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, statement_line_id, sha256)
);

create index documents_line_created_idx on public.documents(statement_line_id, created_at);
create index documents_xero_pending_idx on public.documents(candidate_set_id, created_at)
  where candidate_set_id is not null and xero_uploaded_at is null;

create or replace function public.validate_document_company()
returns trigger language plpgsql set search_path = public as $$
declare line_company uuid;
begin
  select company_id into line_company from public.statement_lines where id = new.statement_line_id;
  if line_company is null or line_company is distinct from new.company_id then
    raise exception 'Document cannot cross companies';
  end if;
  return new;
end $$;

create trigger document_company_guard before insert or update on public.documents
for each row execute function public.validate_document_company();

alter table public.documents enable row level security;
create policy documents_member_read on public.documents for select
  using (public.is_company_member(company_id));

-- Uploads and delivery-state updates are intentionally service-role only.
-- The browser never receives storage credentials or a public object URL.
