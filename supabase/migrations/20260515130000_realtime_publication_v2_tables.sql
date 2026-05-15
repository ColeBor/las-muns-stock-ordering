-- Add tables created in the v2 phase to the realtime publication so
-- the new admin-side useRealtimeRefetch subscriptions actually receive
-- events. REPLICA IDENTITY FULL is needed for DELETE payloads to carry
-- the old row so clients can match by primary key.
alter table public.packaging_types replica identity full;
alter table public.profile_stores replica identity full;

do $$
declare
  t text;
  realtime_tables text[] := array['packaging_types', 'profile_stores'];
begin
  foreach t in array realtime_tables loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
