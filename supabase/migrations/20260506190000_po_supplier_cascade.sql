-- Tighten the FK delete behavior so wiping a supplier / store / factory
-- doesn't trip on related rows that the original schema left as RESTRICT.
--
-- - purchase_orders.supplier_id → cascade. A PO without a supplier is
--   meaningless anyway, and the seed needs to wipe TEST suppliers without
--   tripping on orphan POs.
-- - profiles.store_id and profiles.factory_id → set null. When a store or
--   factory goes away, the user account stays but is unassigned. Don't
--   delete the profile — the user is still real.
-- - items.supplier_id → set null. Same logic; the item record persists,
--   it just no longer has a supplier attached.

alter table public.purchase_orders
  drop constraint if exists purchase_orders_supplier_id_fkey;
alter table public.purchase_orders
  add constraint purchase_orders_supplier_id_fkey
  foreign key (supplier_id) references public.suppliers(id) on delete cascade;

alter table public.profiles
  drop constraint if exists profiles_store_id_fkey;
alter table public.profiles
  add constraint profiles_store_id_fkey
  foreign key (store_id) references public.stores(id) on delete set null;

alter table public.profiles
  drop constraint if exists profiles_factory_id_fkey;
alter table public.profiles
  add constraint profiles_factory_id_fkey
  foreign key (factory_id) references public.factories(id) on delete set null;

alter table public.items
  drop constraint if exists items_supplier_id_fkey;
alter table public.items
  add constraint items_supplier_id_fkey
  foreign key (supplier_id) references public.suppliers(id) on delete set null;
