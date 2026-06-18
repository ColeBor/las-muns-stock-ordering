-- Keep factory_inventory accurate automatically: when an order cycle is
-- delivered, the quantities that shipped out of each factory are subtracted
-- from its rolling on-hand count. Combined with the factory's manual recounts
-- and production additions, on_hand stays current without constant re-typing.
--
-- Source of the shipped amounts = allocation_factories (the per-factory split
-- of each allocation), summed per (factory_id, item_id) for the cycle.
--
-- Clamped at 0: on_hand_qty has a >= 0 check, and a hard override can ship more
-- than was on hand. Idempotent: only fires on the transition INTO 'delivered',
-- so re-saving an already-delivered cycle never double-subtracts.

create or replace function public.apply_factory_shipment() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'delivered' and old.status is distinct from 'delivered' then
    update public.factory_inventory fi
    set on_hand_qty = greatest(0, fi.on_hand_qty - agg.shipped),
        last_counted_at = now(),
        counted_by = 'auto: order delivered'
    from (
      select factory_id, item_id, sum(qty)::int as shipped
      from public.allocation_factories
      where cycle_id = new.id
      group by factory_id, item_id
    ) agg
    where fi.factory_id = agg.factory_id and fi.item_id = agg.item_id;
  end if;
  return new;
end;
$$;

drop trigger if exists order_cycles_apply_shipment on public.order_cycles;
create trigger order_cycles_apply_shipment
  after update of status on public.order_cycles
  for each row execute function public.apply_factory_shipment();
