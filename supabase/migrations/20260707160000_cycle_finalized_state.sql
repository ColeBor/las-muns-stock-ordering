-- Add a 'finalized' state between 'allocated' and 'delivered'.
--
-- New meaning (NOT the old one that 20260506160000 renamed to 'delivered'):
-- 'finalized' = the delivery is locked. Allocations can no longer be re-run
-- (manually or by the auto-reallocator), the delivery PDF has been printed and
-- the truck loaded. Delivery numbers may still be hand-corrected, but the plan
-- won't shift underneath the crew. Delivered can only be marked from 'finalized'.
--
--   draft → allocated → finalized → delivered
--
-- Additive constraint change only; existing rows are unaffected (the old
-- 'finalized' rows were migrated to 'delivered' long ago).

alter table public.order_cycles drop constraint if exists order_cycles_status_check;
alter table public.order_cycles
  add constraint order_cycles_status_check
  check (status in ('draft', 'allocated', 'finalized', 'delivered'));
