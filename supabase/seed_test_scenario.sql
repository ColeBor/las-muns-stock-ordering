-- Test scenario seed for bug-testing the allocation engine.
-- Run from the Supabase dashboard SQL editor (without RLS).
-- Idempotent: safe to re-run; uses fixed names prefixed "TEST:" so it doesn't
-- collide with real data.
--
-- After running:
--   1. Sign in to the app as your HQ admin user
--   2. Go to /admin/cycles → find "TEST: Allocation scenario" → click Manage
--   3. Open the "Allocations" tab and click "Run allocations"
--
-- Expected scenario:
--   F1 has 10 of M1 (9 allocatable after reserve)
--   F2 has 5 of M1 (4 allocatable after reserve)
--   Store A (priorities F1=1, F2=2) demands 5 of M1, 4 of P1
--   Store B (priorities F2=1, F1=2) demands 5 of M1, 6 of P1
--   P1 supplier = Acme Foods
--
-- Expected allocation result:
--   M1 / Store A: qty 5, source=factory, factory_id=F1, shortfall=0
--                 factory_splits: F1=5
--   M1 / Store B: qty 5, source=factory, factory_id=F2 (primary contributor),
--                 shortfall=0, factory_splits: F2=4, F1=1
--   P1 / Store A: qty 4, source=purchase, factory_id=null
--   P1 / Store B: qty 6, source=purchase, factory_id=null
--   Purchase orders: 1 PO under Acme Foods with one line for P1 qty=10
--   Shortfalls: 0

-- ============================================================================
-- 0. Wipe any prior TEST data so the seed is fully re-runnable.
-- order_cycles.name has no unique constraint, so re-runs without this wipe
-- would leave duplicate cycles and break the subqueries below.
-- Order matters: items must go before suppliers (FK with no cascade).
-- Cycle / store / factory deletes cascade their child rows.
-- ============================================================================
delete from public.order_cycles where name like 'TEST:%';
delete from public.items         where name like 'TEST:%';
delete from public.suppliers     where name like 'TEST:%';
delete from public.stores        where name like 'TEST:%';
delete from public.factories     where name like 'TEST:%';

-- ============================================================================
-- 1. Suppliers
-- ============================================================================
insert into public.suppliers (name, contact_info)
values ('TEST: Acme Foods', 'test-seed@example.com');

-- ============================================================================
-- 2. Stores
-- ============================================================================
insert into public.stores (name, is_high_volume, location)
values
  ('TEST: Store A', true,  'Test City A'),
  ('TEST: Store B', false, 'Test City B')
on conflict (name) do nothing;

-- ============================================================================
-- 3. Factories
-- ============================================================================
insert into public.factories (name, location)
values
  ('TEST: Factory 1', 'Test Region 1'),
  ('TEST: Factory 2', 'Test Region 2')
on conflict (name) do nothing;

-- ============================================================================
-- 4. Items (with categories so DeliveryOrders renders correctly)
-- ============================================================================
insert into public.items (name, type, supplier_id, sub_category, packaging_type)
values
  ('TEST: Manufactured Empanada', 'manufactured', null, 'Empanada', 'Single'),
  ('TEST: Purchased Drink',
    'purchased',
    (select id from public.suppliers where name = 'TEST: Acme Foods'),
    'Drink', 'Single')
on conflict (name) do nothing;

-- Backfill the supplier_id on the purchased item if it was inserted before the supplier existed.
update public.items
set supplier_id = (select id from public.suppliers where name = 'TEST: Acme Foods')
where name = 'TEST: Purchased Drink' and supplier_id is null;

-- ============================================================================
-- 5. Store-items: activate both items at both stores with capacity 100
-- ============================================================================
insert into public.store_items (store_id, item_id, is_active, capacity, activated_at)
select s.id, i.id, true, 100, now()
from public.stores s
cross join public.items i
where s.name in ('TEST: Store A', 'TEST: Store B')
  and i.name in ('TEST: Manufactured Empanada', 'TEST: Purchased Drink')
on conflict (store_id, item_id) do update
  set is_active = true, capacity = 100, activated_at = excluded.activated_at;

-- ============================================================================
-- 6. Store-factories: Store A prefers F1, Store B prefers F2
-- ============================================================================
-- Wipe any prior assignments for the test stores to avoid priority conflicts.
delete from public.store_factories
where store_id in (select id from public.stores where name in ('TEST: Store A', 'TEST: Store B'));

insert into public.store_factories (store_id, factory_id, priority)
values
  ((select id from public.stores where name = 'TEST: Store A'),
   (select id from public.factories where name = 'TEST: Factory 1'), 1),
  ((select id from public.stores where name = 'TEST: Store A'),
   (select id from public.factories where name = 'TEST: Factory 2'), 2),
  ((select id from public.stores where name = 'TEST: Store B'),
   (select id from public.factories where name = 'TEST: Factory 2'), 1),
  ((select id from public.stores where name = 'TEST: Store B'),
   (select id from public.factories where name = 'TEST: Factory 1'), 2);

-- ============================================================================
-- 7. Cycle + cycle_stores
-- ============================================================================
insert into public.order_cycles (name, status, created_by)
values ('TEST: Allocation scenario', 'draft', 'seed-script')
on conflict do nothing;

-- Wipe and re-add cycle_stores so it's deterministic
delete from public.cycle_stores
where cycle_id = (select id from public.order_cycles where name = 'TEST: Allocation scenario');

-- Seed marks both stores as already finished so /api/allocations/run can be
-- triggered without first clicking "Mark as finished" in each store's UI.
insert into public.cycle_stores (cycle_id, store_id, finished_at)
select
  (select id from public.order_cycles where name = 'TEST: Allocation scenario'),
  s.id,
  now()
from public.stores s
where s.name in ('TEST: Store A', 'TEST: Store B');

-- ============================================================================
-- 8. Factory counts: F1 has 10, F2 has 5 (of the manufactured item)
-- ============================================================================
insert into public.factory_counts (cycle_id, factory_id, item_id, available_qty, counted_by)
values
  ((select id from public.order_cycles where name = 'TEST: Allocation scenario'),
   (select id from public.factories where name = 'TEST: Factory 1'),
   (select id from public.items where name = 'TEST: Manufactured Empanada'),
   10, 'seed-script'),
  ((select id from public.order_cycles where name = 'TEST: Allocation scenario'),
   (select id from public.factories where name = 'TEST: Factory 2'),
   (select id from public.items where name = 'TEST: Manufactured Empanada'),
   5, 'seed-script')
on conflict (cycle_id, factory_id, item_id) do update
  set available_qty = excluded.available_qty,
      counted_at = now();

-- ============================================================================
-- 9. Stock entries: store demand
-- ============================================================================
insert into public.stock_entries (cycle_id, store_id, item_id, current_count, entered_by)
values
  -- Store A
  ((select id from public.order_cycles where name = 'TEST: Allocation scenario'),
   (select id from public.stores where name = 'TEST: Store A'),
   (select id from public.items where name = 'TEST: Manufactured Empanada'),
   5, 'seed-script'),
  ((select id from public.order_cycles where name = 'TEST: Allocation scenario'),
   (select id from public.stores where name = 'TEST: Store A'),
   (select id from public.items where name = 'TEST: Purchased Drink'),
   4, 'seed-script'),
  -- Store B
  ((select id from public.order_cycles where name = 'TEST: Allocation scenario'),
   (select id from public.stores where name = 'TEST: Store B'),
   (select id from public.items where name = 'TEST: Manufactured Empanada'),
   5, 'seed-script'),
  ((select id from public.order_cycles where name = 'TEST: Allocation scenario'),
   (select id from public.stores where name = 'TEST: Store B'),
   (select id from public.items where name = 'TEST: Purchased Drink'),
   6, 'seed-script')
on conflict (cycle_id, store_id, item_id) do update
  set current_count = excluded.current_count,
      entered_at = now();

-- ============================================================================
-- 10. Wipe any prior allocation/PO data for this cycle so a fresh run is clean.
-- ============================================================================
delete from public.allocations
where cycle_id = (select id from public.order_cycles where name = 'TEST: Allocation scenario');

delete from public.purchase_orders
where cycle_id = (select id from public.order_cycles where name = 'TEST: Allocation scenario');

-- ============================================================================
-- Confirmation: what got seeded
-- ============================================================================
select 'cycle' as kind, id::text as detail from public.order_cycles where name = 'TEST: Allocation scenario'
union all select 'store',     id::text from public.stores     where name like 'TEST:%'
union all select 'factory',   id::text from public.factories  where name like 'TEST:%'
union all select 'item',      name     from public.items      where name like 'TEST:%'
union all select 'supplier',  id::text from public.suppliers  where name like 'TEST:%';
