-- Per-item pack quantity: how many units are in this item's package/case.
-- Two items can share a packaging type ("Case") but hold different amounts
-- (Coke case = 24, Fanta case = 12). Shown on the order sheet so store staff
-- know how much each line represents. Nullable; positive when set.
alter table public.items
  add column if not exists pack_qty integer
  check (pack_qty is null or pack_qty > 0);
