-- Let a Purchased item still be stocked + allocated like a Manufactured one.
--
-- When track_factory_stock = true on a purchased item, the allocator pulls it
-- from factory_inventory with shortfalls (instead of treating it as unlimited
-- supply), and the Factory Stock screen lists it for on-hand counting.
alter table public.items
  add column if not exists track_factory_stock boolean not null default false;
