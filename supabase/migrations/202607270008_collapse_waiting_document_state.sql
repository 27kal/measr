-- Document collection is an action inside the single needs_you review state.
-- Keep the old enum value for backwards-compatible database decoding, but stop
-- projecting or creating it.
update public.statement_lines
set status = 'needs_you',
    status_version = status_version + 1,
    updated_at = now()
where status = 'waiting_doc';
