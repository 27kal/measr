alter table public.candidate_set_lines add column expected_posted_at date;

update public.candidate_set_lines membership
set expected_posted_at = line.posted_at
from public.statement_lines line
where line.id = membership.statement_line_id;

set constraints all immediate;

alter table public.candidate_set_lines alter column expected_posted_at set not null;

create or replace function public.validate_candidate_membership()
returns trigger language plpgsql set search_path = public as $$
declare candidate_company uuid; line_company uuid; line_bank uuid; line_amount bigint; line_date date;
begin
  select company_id into candidate_company from public.candidate_sets where id = new.candidate_set_id;
  select company_id, bank_account_id, amount_minor, posted_at into line_company, line_bank, line_amount, line_date from public.statement_lines where id = new.statement_line_id;
  if candidate_company is distinct from line_company then raise exception 'Candidate cannot cross companies'; end if;
  if new.expected_bank_account_id is distinct from line_bank
    or new.expected_amount_minor is distinct from line_amount
    or new.expected_posted_at is distinct from line_date then
    raise exception 'Candidate fingerprint must match the immutable statement line';
  end if;
  return new;
end $$;
