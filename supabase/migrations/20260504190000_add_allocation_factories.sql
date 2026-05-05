-- Per-factory allocation breakdown.
-- The allocations table holds one row per (cycle, store, item) summarizing the order.
-- This table records the per-factory split when an item is sourced from multiple factories,
-- so factory dashboards can sum the units they're responsible for shipping.

create table if not exists allocation_factories (
  cycle_id uuid not null,
  store_id uuid not null,
  item_id uuid not null,
  factory_id uuid not null references factories(id) on delete cascade,
  qty integer not null default 0,
  primary key (cycle_id, store_id, item_id, factory_id),
  foreign key (cycle_id, store_id, item_id)
    references allocations (cycle_id, store_id, item_id)
    on delete cascade
);

alter table allocation_factories enable row level security;

drop policy if exists "Allocation factories: HQ can manage" on allocation_factories;
create policy "Allocation factories: HQ can manage" on allocation_factories
  for all using (is_hq_admin()) with check (is_hq_admin());

drop policy if exists "Allocation factories: factory users can view own factory" on allocation_factories;
create policy "Allocation factories: factory users can view own factory" on allocation_factories
  for select using (
    is_factory_user() and factory_id = current_factory_id()
  );

drop policy if exists "Allocation factories: store managers can view own store" on allocation_factories;
create policy "Allocation factories: store managers can view own store" on allocation_factories
  for select using (
    is_store_manager() and store_id = current_store_id()
  );
