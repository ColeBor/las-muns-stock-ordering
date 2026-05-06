-- Simplify the items table: drop unit, meta_category, and sku columns and
-- promote name to the unique key.
--
-- - unit duplicated packaging_type for the current ops where every item is
--   "1 each".
-- - meta_category duplicated the canonical items.type enum that the
--   allocator already branches on.
-- - sku was a surface key with no operational use; name is enough.
--
-- The unique constraint on name lets the seed's ON CONFLICT (name) clause
-- work and prevents accidental duplicate entries.
--
-- The categories table referenced the meta_category enum and was never
-- read by the application — drop it before the enum so the enum drop
-- doesn't fail on a dependency.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'items_name_unique' and conrelid = 'public.items'::regclass
  ) then
    alter table public.items add constraint items_name_unique unique (name);
  end if;
end $$;

alter table public.items drop column if exists meta_category;
alter table public.items drop column if exists unit;
alter table public.items drop column if exists sku;

drop table if exists public.categories;
drop type if exists meta_category;
