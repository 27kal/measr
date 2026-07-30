-- When the stitched whole fails deterministic validation, the worker now
-- repairs only the segments that produced the failing rows instead of failing
-- the import: those segment rows are marked with their validation errors and
-- re-extracted with that context. Repair rounds are bounded so a segment the
-- model cannot extract cleanly still fails the import with its real errors.

alter table public.statement_import_chunks
  add column redo_errors jsonb;

alter table public.statement_imports
  add column repair_rounds integer not null default 0 check (repair_rounds >= 0);

notify pgrst, 'reload schema';
