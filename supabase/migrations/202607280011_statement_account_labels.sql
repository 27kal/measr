-- Statement-upload accounts are no longer CSV-specific in the product. Keep
-- the legacy source enum internally, but remove the obsolete format suffix
-- from existing user-visible account names.
update public.bank_accounts
set name = regexp_replace(name, ' · CSV$', '')
where source = 'csv' and name like '% · CSV';
