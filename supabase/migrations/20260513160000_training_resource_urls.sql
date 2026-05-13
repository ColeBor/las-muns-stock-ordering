-- Allow training resources to be sourced from an external URL (YouTube,
-- Vimeo, Google Drive, etc.) instead of an uploaded file. Lets HQ link out
-- past the Supabase free-tier file-size limit without paying for storage.
--
-- Two new columns:
--   source_type  — 'upload' (file in storage) or 'url' (external)
--   source_url   — the external URL when source_type = 'url'
--
-- `storage_path` becomes nullable so URL-sourced rows don't need to set it.
-- A CHECK enforces that exactly one of the two fields is populated for the
-- chosen source_type so the data stays consistent.

alter table public.training_resources
  add column if not exists source_type text not null default 'upload'
    check (source_type in ('upload', 'url'));

alter table public.training_resources
  add column if not exists source_url text;

alter table public.training_resources
  alter column storage_path drop not null;

alter table public.training_resources
  drop constraint if exists training_resources_source_chk;
alter table public.training_resources
  add constraint training_resources_source_chk
  check (
    (source_type = 'upload'
       and storage_path is not null and length(btrim(storage_path)) > 0
       and source_url is null)
    or
    (source_type = 'url'
       and source_url is not null and length(btrim(source_url)) > 0
       and storage_path is null)
  );
