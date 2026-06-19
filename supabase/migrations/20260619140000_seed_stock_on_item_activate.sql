-- Fix "order sheet shows 0 for an item activated mid-cycle".
--
-- prepopulate_stock_entries_on_cycle_join only seeds stock_entries for the
-- items that were ACTIVE at the moment the store joined the cycle. If an item
-- is activated for a store while a cycle is already open, no stock_entry gets
-- created for it, so the order sheet falls back to 0 — even though the store
-- has a real carried-forward on-hand. This adds a companion trigger on
-- store_items that seeds the open cycle's entry on activation, using the SAME
-- carry-forward math (previous delivered current_count + allocated, minus
-- orphan box traces, floored at 0) as the join-time prepopulate.

-- ── Shared seed helper ──────────────────────────────────────────────────────
-- Inserts the carried-forward starting count for one (cycle, store, item),
-- and attributes that item's orphan box traces to the cycle so they aren't
-- double-counted later. Idempotent (ON CONFLICT DO NOTHING) — never clobbers
-- an existing entry.
create or replace function public.seed_stock_entry(
  p_cycle_id uuid, p_store_id uuid, p_item_id uuid
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into stock_entries (cycle_id, store_id, item_id, current_count, entered_by)
  values (
    p_cycle_id, p_store_id, p_item_id,
    greatest(
      0,
      coalesce(
        (
          select se.current_count + coalesce(a.qty, 0)
          from stock_entries se
          join order_cycles c on c.id = se.cycle_id
          left join allocations a
            on a.cycle_id = se.cycle_id
           and a.store_id = se.store_id
           and a.item_id = se.item_id
          where se.store_id = p_store_id
            and se.item_id = p_item_id
            and c.status = 'delivered'
          order by c.order_date desc nulls last, c.created_at desc
          limit 1
        ),
        0
      )
      - coalesce(
        (
          select count(*)::int
          from box_trace_entries bt
          where bt.cycle_id is null
            and bt.store_id = p_store_id
            and bt.item_id = p_item_id
        ),
        0
      )
    ),
    'system-prepopulate'
  )
  on conflict (cycle_id, store_id, item_id) do nothing;

  update box_trace_entries
  set cycle_id = p_cycle_id
  where cycle_id is null
    and store_id = p_store_id
    and item_id = p_item_id;
end;
$$;

-- ── Trigger: seed the open cycle's entry when an item is activated ───────────
-- Fires on INSERT of an active row, or UPDATE flipping is_active false→true.
-- Capacity-only edits (is_active already true) are a no-op. If the store isn't
-- in any open (non-delivered) cycle, there's nothing to seed.
create or replace function public.seed_stock_entry_on_item_activate()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_cycle uuid;
begin
  if not new.is_active then
    return new;
  end if;
  -- Only touch OLD on UPDATE (it's unassigned on INSERT). Skip when the row
  -- was already active — that's a capacity/edit, not an activation.
  if tg_op = 'UPDATE' then
    if old.is_active then
      return new;
    end if;
  end if;

  select c.id into v_cycle
  from cycle_stores cs
  join order_cycles c on c.id = cs.cycle_id
  where cs.store_id = new.store_id
    and c.status <> 'delivered'
  limit 1;

  if v_cycle is not null then
    perform public.seed_stock_entry(v_cycle, new.store_id, new.item_id);
  end if;
  return new;
end;
$$;

drop trigger if exists store_items_seed_open_cycle on public.store_items;
create trigger store_items_seed_open_cycle
after insert or update on public.store_items
for each row execute function public.seed_stock_entry_on_item_activate();
