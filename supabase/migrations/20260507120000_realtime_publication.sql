-- Wire the operational + config tables into Supabase Realtime so changes
-- broadcast to subscribed clients. REPLICA IDENTITY FULL ensures old-row
-- payloads on UPDATE/DELETE so client filters by foreign keys still work.

do $$
declare
  t text;
  realtime_tables text[] := array[
    'order_cycles',
    'cycle_stores',
    'allocations',
    'allocation_factories',
    'allocation_overrides',
    'stock_entries',
    'factory_counts',
    'purchase_orders',
    'po_lines',
    'items',
    'stores',
    'factories',
    'suppliers',
    'store_items',
    'store_factories',
    'profiles'
  ];
begin
  foreach t in array realtime_tables loop
    execute format('alter table public.%I replica identity full', t);
    -- Add to the supabase_realtime publication if not already a member.
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
