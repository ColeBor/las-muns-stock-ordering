-- Give factory workers access to the order-cycle / delivery flow so the Cycles
-- page works for them with the same (full) management a store manager has.
-- is_factory_worker() is unscoped here — a factory worker sees and manages all
-- cycles, exactly like the boss (store_manager).
--
-- items / stores / factory_counts / factory_inventory already allow any
-- authenticated user to read, so only these tables need new policies.

-- Full manage on the tables the Cycles page creates/edits.
drop policy if exists "Order cycles: factory workers can manage" on public.order_cycles;
create policy "Order cycles: factory workers can manage" on public.order_cycles
  for all using (public.is_factory_worker()) with check (public.is_factory_worker());

drop policy if exists "Cycle stores: factory workers can manage" on public.cycle_stores;
create policy "Cycle stores: factory workers can manage" on public.cycle_stores
  for all using (public.is_factory_worker()) with check (public.is_factory_worker());

drop policy if exists "Allocations: factory workers can manage" on public.allocations;
create policy "Allocations: factory workers can manage" on public.allocations
  for all using (public.is_factory_worker()) with check (public.is_factory_worker());

-- Read on the reference tables the Preview / Stock views need.
drop policy if exists "Stock entries: factory workers can view" on public.stock_entries;
create policy "Stock entries: factory workers can view" on public.stock_entries
  for select using (public.is_factory_worker());

drop policy if exists "Store items: factory workers can view" on public.store_items;
create policy "Store items: factory workers can view" on public.store_items
  for select using (public.is_factory_worker());
