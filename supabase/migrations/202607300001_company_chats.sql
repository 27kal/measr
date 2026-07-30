create table public.company_chats (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  created_by uuid not null references auth.users(id),
  latest_run_id uuid,
  running_run_id uuid,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index company_chats_company_updated_idx
  on public.company_chats(company_id, updated_at desc);

alter table public.company_chats enable row level security;

create policy company_chats_member_read on public.company_chats
  for select using (public.is_company_member(company_id));

create policy company_chats_member_insert on public.company_chats
  for insert with check (
    public.is_company_member(company_id)
    and created_by = auth.uid()
  );

create or replace function public.reserve_company_chat_run(
  p_company_id uuid,
  p_chat_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  chat public.company_chats%rowtype;
  run_id uuid := gen_random_uuid();
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  select * into chat
  from public.company_chats
  where id = p_chat_id and company_id = p_company_id
  for update;
  if chat.id is null then raise exception 'Chat not found'; end if;
  if chat.running_run_id is not null then raise exception 'This chat is already replying'; end if;

  update public.company_chats
  set running_run_id = run_id, last_error = null, updated_at = now()
  where id = p_chat_id;
  return run_id;
end $$;

create or replace function public.finish_company_chat_run(
  p_company_id uuid,
  p_chat_id uuid,
  p_run_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  update public.company_chats
  set latest_run_id = p_run_id,
      running_run_id = null,
      last_error = null,
      updated_at = now()
  where id = p_chat_id
    and company_id = p_company_id
    and running_run_id = p_run_id;
  if not found then raise exception 'Chat run reservation changed'; end if;
end $$;

create or replace function public.fail_company_chat_run(
  p_company_id uuid,
  p_chat_id uuid,
  p_run_id uuid,
  p_error text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  update public.company_chats
  set running_run_id = null,
      last_error = left(p_error, 1000),
      updated_at = now()
  where id = p_chat_id
    and company_id = p_company_id
    and running_run_id = p_run_id;
end $$;

revoke all on function public.reserve_company_chat_run(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_company_chat_run(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.fail_company_chat_run(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_company_chat_run(uuid, uuid) to service_role;
grant execute on function public.finish_company_chat_run(uuid, uuid, uuid) to service_role;
grant execute on function public.fail_company_chat_run(uuid, uuid, uuid, text) to service_role;
