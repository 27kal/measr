-- Bank accounts mirror the connected Xero organisation one-to-one. Workbench
-- no longer creates accounts by hand: the server syncs active GBP Xero bank
-- accounts into bank_accounts, adopts Xero's names, and the browser only reads
-- the list. Accounts are added or renamed in Xero and appear here after sync.

-- Retire manually created accounts that never mapped to Xero and own no data.
-- The statement_lines RESTRICT foreign key keeps any referenced account safe.
delete from public.bank_accounts account
where account.xero_account_id is null
  and not exists (select 1 from public.statement_lines line where line.bank_account_id = account.id)
  and not exists (select 1 from public.statement_imports import where import.bank_account_id = account.id);

create unique index if not exists bank_accounts_company_xero_idx
  on public.bank_accounts(company_id, xero_account_id)
  where xero_account_id is not null;

-- One transactional sync per company. p_accounts is the authoritative list of
-- active GBP bank accounts read from Xero: [{"id": ..., "name": ...}, ...].
-- Existing mapped accounts adopt Xero's current name; new Xero accounts are
-- created; local accounts that no longer exist in Xero are removed when they
-- own no statement data and kept (with their history) when they do.
create or replace function public.sync_xero_bank_accounts(
  p_company_id uuid,
  p_accounts jsonb
) returns integer language plpgsql security definer set search_path = public as $$
declare
  synced integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Bank account sync is server-only' using errcode = '42501';
  end if;

  update public.bank_accounts account
     set name = incoming.item->>'name'
    from jsonb_array_elements(p_accounts) as incoming(item)
   where account.company_id = p_company_id
     and account.xero_account_id::text = incoming.item->>'id'
     and account.name is distinct from incoming.item->>'name';

  insert into public.bank_accounts(company_id, name, currency, source, xero_account_id)
  select p_company_id, incoming.item->>'name', 'GBP', 'csv', (incoming.item->>'id')::uuid
    from jsonb_array_elements(p_accounts) as incoming(item)
   where not exists (
     select 1 from public.bank_accounts existing
      where existing.company_id = p_company_id
        and existing.xero_account_id::text = incoming.item->>'id'
   );
  get diagnostics synced = row_count;

  delete from public.bank_accounts account
   where account.company_id = p_company_id
     and (account.xero_account_id is null or not exists (
       select 1 from jsonb_array_elements(p_accounts) as incoming(item)
        where incoming.item->>'id' = account.xero_account_id::text
     ))
     and not exists (select 1 from public.statement_lines line where line.bank_account_id = account.id)
     and not exists (select 1 from public.statement_imports import where import.bank_account_id = account.id);

  return synced;
end $$;

revoke all on function public.sync_xero_bank_accounts(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.sync_xero_bank_accounts(uuid, jsonb) to service_role;
