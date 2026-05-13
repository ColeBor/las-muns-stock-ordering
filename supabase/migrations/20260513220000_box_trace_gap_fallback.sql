-- Fix: a box trace logged in the gap between cycle delivery and the next
-- cycle being created was silently uncounted (cycle_id stayed null, no
-- decrement). Result: the next cycle's pre-populated starting count was
-- 1 too high per orphan trace, and the store would under-order.
--
-- New behaviour: if no open cycle exists for the store, fall back to the
-- most recent delivered cycle. Decrementing its stock_entries.current_count
-- is correct because the next cycle's pre-populate reads
-- (prev_delivered.current_count + prev_delivered.allocations.qty) as the
-- new starting on-hand — so a smaller prev_delivered.current_count means
-- a smaller (and accurate) starting count for the new cycle.
create or replace function public.set_box_trace_cycle_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  open_cycle_id uuid;
  recent_delivered_cycle_id uuid;
begin
  if new.cycle_id is null then
    -- Prefer the open cycle (happy path).
    select c.id into open_cycle_id
    from cycle_stores cs
    join order_cycles c on c.id = cs.cycle_id
    where cs.store_id = new.store_id
      and c.status <> 'delivered'
    limit 1;

    if open_cycle_id is not null then
      new.cycle_id := open_cycle_id;
    else
      -- Fallback: attribute to most recent delivered cycle so the
      -- decrement carries forward into the next cycle's starting count.
      select c.id into recent_delivered_cycle_id
      from cycle_stores cs
      join order_cycles c on c.id = cs.cycle_id
      where cs.store_id = new.store_id
        and c.status = 'delivered'
      order by c.order_date desc nulls last, c.created_at desc
      limit 1;
      new.cycle_id := recent_delivered_cycle_id;
    end if;
  end if;
  return new;
end;
$$;
