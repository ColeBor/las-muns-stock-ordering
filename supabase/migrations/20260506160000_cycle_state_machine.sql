-- Tighten the cycle status state machine to draft → allocated → delivered.
--
-- - 'active' was a label with no functional behavior; collapse into 'draft'
--   (a cycle still being filled out by store employees).
-- - 'finalized' is renamed to 'delivered' to match how operations talk
--   about the cycle once stock has actually shipped.
-- - cycle_stores.finished_at lets each participating store mark their stock
--   entry "done" so the allocator can verify everyone has submitted before
--   it runs.
--
-- Status transitions are now machine-driven:
--   draft → allocated   when /api/allocations/run succeeds
--   allocated → delivered when /api/allocations/finalize succeeds

update public.order_cycles set status = 'draft' where status = 'active';
update public.order_cycles set status = 'delivered' where status = 'finalized';

alter table public.order_cycles drop constraint if exists order_cycles_status_check;
alter table public.order_cycles
  add constraint order_cycles_status_check
  check (status in ('draft', 'allocated', 'delivered'));

alter table public.cycle_stores
  add column if not exists finished_at timestamptz;
