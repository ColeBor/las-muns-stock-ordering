-- Move order_date from per-stock-entry to per-cycle. Each cycle is one
-- delivery moment with one delivery date that applies to every store in the
-- cycle. Stores ordering on different cadences (twice a week vs. once a week)
-- belong to different cycles.
--
-- If you have existing stock_entries with order_date populated and want to
-- preserve them, run this BEFORE the drop column statement below:
--
--   update public.order_cycles oc
--   set order_date = (
--     select min(se.order_date) from public.stock_entries se
--     where se.cycle_id = oc.id and se.order_date is not null
--   );

alter table public.order_cycles
  add column if not exists order_date date;

alter table public.stock_entries
  drop column if exists order_date;
