-- Agent memory and run transcripts are deliberately stored as private files,
-- not normalized decision rows. Edge Functions mediate all access.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'agent-artifacts',
  'agent-artifacts',
  false,
  5242880,
  array['application/json', 'text/markdown', 'text/plain']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
