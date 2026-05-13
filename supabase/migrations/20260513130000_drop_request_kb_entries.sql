-- Drop request_kb_entries.
--
-- The Knowledge Base UI has been removed because the AI pre-filter it was
-- going to feed got cut. Without the bot, the table just duplicated info
-- already stored on resolved requests' resolution_note. Dropping it cleans
-- up the schema. The table is removed from the supabase_realtime publication
-- first so the broadcaster doesn't error on a missing relation.

do $$
begin
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'request_kb_entries'
  ) then
    execute 'alter publication supabase_realtime drop table public.request_kb_entries';
  end if;
end
$$;

drop table if exists public.request_kb_entries;
