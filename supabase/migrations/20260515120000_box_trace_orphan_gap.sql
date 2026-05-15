-- Revised box-trace gap behavior. Traces recorded while no cycle is
-- open used to decrement the previous delivered cycle's stock_entries,
-- mutating historical data. Now they stay orphaned (cycle_id = null)
-- until the next cycle opens, at which point the prepopulate trigger
-- subtracts them from the new cycle's starting count AND attributes
-- them to that cycle so they aren't double-counted later.

create or replace function public.set_box_trace_cycle_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  open_cycle_id uuid;
begin
  if new.cycle_id is null then
    select c.id into open_cycle_id
    from cycle_stores cs
    join order_cycles c on c.id = cs.cycle_id
    where cs.store_id = new.store_id
      and c.status <> 'delivered'
    limit 1;
    -- No open cycle → leave cycle_id NULL. The trace is an orphan until
    -- the next cycle opens; prepopulate_stock_entries_on_cycle_join
    -- subtracts it from the new starting count and attributes it then.
    new.cycle_id := open_cycle_id;
  end if;
  return new;
end;
$$;

create or replace function public.prepopulate_stock_entries_on_cycle_join()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into stock_entries (cycle_id, store_id, item_id, current_count, entered_by)
  select
    new.cycle_id,
    new.store_id,
    si.item_id,
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
          where se.store_id = new.store_id
            and se.item_id = si.item_id
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
            and bt.store_id = new.store_id
            and bt.item_id = si.item_id
        ),
        0
      )
    ),
    'system-prepopulate'
  from store_items si
  where si.store_id = new.store_id
    and si.is_active = true
  on conflict (cycle_id, store_id, item_id) do nothing;

  -- Attribute the orphan traces to this new cycle so they don't
  -- subtract again next time, and so deletes of those traces correctly
  -- increment the new cycle's stock_entry instead of doing nothing.
  update box_trace_entries
  set cycle_id = new.cycle_id
  where cycle_id is null
    and store_id = new.store_id;

  return new;
end;
$$;
