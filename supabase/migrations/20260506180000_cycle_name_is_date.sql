-- Drop order_cycles.name. In this business every cycle is essentially named
-- after its order_date (the date the order was placed), so the separate
-- name field was redundant. Also makes order_date NOT NULL since it's now
-- the canonical identifier shown to humans.
--
-- Existing cycles with a null order_date get backfilled from created_at::date
-- so the NOT NULL add can succeed.

update public.order_cycles
set order_date = created_at::date
where order_date is null;

alter table public.order_cycles alter column order_date set not null;

alter table public.order_cycles drop column if exists name;
