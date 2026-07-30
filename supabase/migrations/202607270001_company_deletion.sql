create or replace function public.delete_company_for_owner(
  p_company_id uuid,
  p_user_id uuid,
  p_confirmation text
) returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  company_name text;
  secret_id uuid;
  deleted_id uuid;
begin
  select c.legal_name, x.refresh_token_secret_id
    into company_name, secret_id
  from public.companies c
  left join public.xero_connections x on x.company_id = c.id
  where c.id = p_company_id;

  if company_name is null then
    raise exception 'Company not found';
  end if;

  if not exists (
    select 1
    from public.company_memberships membership
    where membership.company_id = p_company_id
      and membership.user_id = p_user_id
      and membership.role = 'owner'
  ) then
    raise exception 'Only a company owner can delete this company' using errcode = '42501';
  end if;

  if p_confirmation is distinct from company_name then
    raise exception 'Company name confirmation does not match' using errcode = '22023';
  end if;

  -- Break the deliberate statement-line RESTRICT guard before the company-wide
  -- cascade. Normal line deletion remains protected outside this operation.
  delete from public.candidate_set_lines member
  using public.candidate_sets candidate
  where member.candidate_set_id = candidate.id
    and candidate.company_id = p_company_id;

  delete from public.companies
  where id = p_company_id
  returning id into deleted_id;

  if secret_id is not null then
    delete from vault.secrets where id = secret_id;
  end if;

  return deleted_id;
end
$$;

revoke all on function public.delete_company_for_owner(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.delete_company_for_owner(uuid, uuid, text) to service_role;
