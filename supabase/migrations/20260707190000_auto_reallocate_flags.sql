-- Server-auto reallocation, part 1: flag a cycle "dirty" when its allocation
-- inputs change, so a scheduled job (part 2) can re-run allocations without
-- anyone clicking Run.
--
-- Only 'allocated' cycles are ever flagged: 'draft' hasn't been run yet, and
-- 'finalized'/'delivered' are locked (the truck is loaded / order is closed).
-- The run engine writes allocations/factory_counts/POs — never stock_entries or
-- factory_inventory — so these triggers can't feed back into themselves.

alter table public.order_cycles add column if not exists reallocate_requested_at timestamptz;

-- Store stock changed (a count edit, a box trace) → flag that cycle. stock_entries
-- carry a cycle_id, so we flag exactly the affected cycle.
create or replace function public.flag_reallocation_from_stock_entry()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update order_cycles set reallocate_requested_at = now()
  where id = coalesce(new.cycle_id, old.cycle_id) and status = 'allocated';
  return null;
end;
$$;

drop trigger if exists stock_entries_flag_reallocation on public.stock_entries;
create trigger stock_entries_flag_reallocation
after insert or update or delete on public.stock_entries
for each row execute function public.flag_reallocation_from_stock_entry();

-- Factory stock changed (a count edit, a freezer box trace) → flag every
-- allocated cycle, since factory stock is shared across cycles.
create or replace function public.flag_reallocation_from_factory_inventory()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update order_cycles set reallocate_requested_at = now() where status = 'allocated';
  return null;
end;
$$;

drop trigger if exists factory_inventory_flag_reallocation on public.factory_inventory;
create trigger factory_inventory_flag_reallocation
after insert or update or delete on public.factory_inventory
for each row execute function public.flag_reallocation_from_factory_inventory();
