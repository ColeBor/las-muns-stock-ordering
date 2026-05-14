-- Rolling factory inventory: one row per (factory, item), editable any time,
-- independent of cycles. The allocator reads from this table; the existing
-- factory_counts(cycle_id, ...) table becomes a per-cycle snapshot written
-- right after allocations run.
create table if not exists public.factory_inventory (
  factory_id uuid not null references public.factories(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  on_hand_qty integer not null default 0 check (on_hand_qty >= 0),
  last_counted_at timestamptz not null default now(),
  counted_by text,
  primary key (factory_id, item_id)
);

-- Seed from the latest existing factory_counts row per (factory, item) so
-- factories don't have to re-enter everything.
insert into public.factory_inventory (factory_id, item_id, on_hand_qty, last_counted_at, counted_by)
select distinct on (factory_id, item_id)
  factory_id, item_id, available_qty, counted_at, counted_by
from public.factory_counts
order by factory_id, item_id, counted_at desc
on conflict (factory_id, item_id) do nothing;

alter table public.factory_inventory enable row level security;

drop policy if exists "Factory inventory: Store Managers can manage" on public.factory_inventory;
create policy "Factory inventory: Store Managers can manage"
  on public.factory_inventory for all
  using (public.is_store_manager()) with check (public.is_store_manager());

drop policy if exists "Factory inventory: factory workers can manage own factory" on public.factory_inventory;
create policy "Factory inventory: factory workers can manage own factory"
  on public.factory_inventory for all
  using (public.is_factory_worker() and factory_id = public.current_factory_id())
  with check (public.is_factory_worker() and factory_id = public.current_factory_id());

drop policy if exists "Factory inventory: authenticated can view" on public.factory_inventory;
create policy "Factory inventory: authenticated can view"
  on public.factory_inventory for select using (auth.role() = 'authenticated');

-- Realtime so the FactoryStock UI refreshes as counts come in from other tabs.
alter table public.factory_inventory replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'factory_inventory'
  ) then
    alter publication supabase_realtime add table public.factory_inventory;
  end if;
end
$$;
