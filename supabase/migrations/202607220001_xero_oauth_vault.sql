create extension if not exists supabase_vault with schema vault;

alter table public.xero_connections
  drop column encrypted_refresh_token,
  add column connection_id uuid not null unique,
  add column refresh_token_secret_id uuid not null;

create table public.xero_oauth_states (
  state_hash text primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  return_to text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.xero_oauth_states enable row level security;
-- OAuth state is server-only. No browser policy is intentionally defined.

create or replace function public.store_xero_connection(
  p_company_id uuid,
  p_connection_id uuid,
  p_tenant_id uuid,
  p_tenant_name text,
  p_refresh_token text,
  p_scopes text[],
  p_connected_by uuid
) returns void language plpgsql security definer set search_path = public, vault as $$
declare secret_id uuid;
begin
  select refresh_token_secret_id into secret_id
    from public.xero_connections where company_id = p_company_id for update;
  if secret_id is null then
    secret_id := vault.create_secret(p_refresh_token, 'xero-refresh-' || p_company_id::text, 'Rotating Xero OAuth refresh token');
  else
    perform vault.update_secret(secret_id, p_refresh_token);
  end if;
  insert into public.xero_connections(company_id, connection_id, tenant_id, tenant_name, refresh_token_secret_id, scopes, connected_by, connected_at, disconnected_at)
    values(p_company_id, p_connection_id, p_tenant_id, p_tenant_name, secret_id, p_scopes, p_connected_by, now(), null)
  on conflict(company_id) do update set
    connection_id = excluded.connection_id,
    tenant_id = excluded.tenant_id,
    tenant_name = excluded.tenant_name,
    scopes = excluded.scopes,
    connected_by = excluded.connected_by,
    connected_at = now(),
    disconnected_at = null;
end $$;

create or replace function public.xero_refresh_token_for_worker(target_company_id uuid)
returns text language sql security definer set search_path = public, vault
as $$
  select secret.decrypted_secret
  from public.xero_connections connection
  join vault.decrypted_secrets secret on secret.id = connection.refresh_token_secret_id
  where connection.company_id = target_company_id and connection.disconnected_at is null
$$;

create or replace function public.rotate_xero_refresh_token_for_worker(target_company_id uuid, new_refresh_token text)
returns void language plpgsql security definer set search_path = public, vault as $$
declare secret_id uuid;
begin
  select refresh_token_secret_id into strict secret_id from public.xero_connections where company_id = target_company_id for update;
  perform vault.update_secret(secret_id, new_refresh_token);
end $$;

revoke all on function public.store_xero_connection(uuid, uuid, uuid, text, text, text[], uuid) from public, anon, authenticated;
revoke all on function public.xero_refresh_token_for_worker(uuid) from public, anon, authenticated;
revoke all on function public.rotate_xero_refresh_token_for_worker(uuid, text) from public, anon, authenticated;
grant execute on function public.store_xero_connection(uuid, uuid, uuid, text, text, text[], uuid) to service_role;
grant execute on function public.xero_refresh_token_for_worker(uuid) to service_role;
grant execute on function public.rotate_xero_refresh_token_for_worker(uuid, text) to service_role;

create index xero_oauth_states_expiry_idx on public.xero_oauth_states(expires_at) where consumed_at is null;
