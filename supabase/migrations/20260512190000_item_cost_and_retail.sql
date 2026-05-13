-- Per-item production cost and retail price.
--
-- Drives the waste analytics dashboard's two loss metrics:
--   cost_per_unit         — money already spent to make/buy the item
--   retail_price_per_unit — selling price; profit lost = retail - cost
--
-- Both nullable so existing items can phase in pricing without breaking
-- inserts. Items without prices contribute 0 to the loss totals; the
-- dashboard surfaces a count of unpriced items so HQ knows what to fix.

alter table public.items
  add column if not exists cost_per_unit numeric(10,2),
  add column if not exists retail_price_per_unit numeric(10,2);

alter table public.items
  drop constraint if exists items_cost_nonneg_chk;
alter table public.items
  add constraint items_cost_nonneg_chk
  check (
    (cost_per_unit is null or cost_per_unit >= 0)
    and (retail_price_per_unit is null or retail_price_per_unit >= 0)
  );
