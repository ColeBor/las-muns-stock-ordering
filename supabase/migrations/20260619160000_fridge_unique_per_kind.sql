-- Allow a fridge and a freezer to share a name within a store.
--
-- store_fridges originally had UNIQUE (store_id, name), so e.g. a "Back"
-- fridge blocked adding a "Back" freezer. Now that units are typed, make the
-- name unique per (store_id, kind, name) instead — same name is fine across
-- different types, still blocked within the same type.

-- Drop the old uniqueness (covers both the inline-constraint and index forms).
alter table public.store_fridges
  drop constraint if exists store_fridges_store_id_name_key;
drop index if exists public.store_fridges_store_id_name_key;

create unique index if not exists store_fridges_store_id_kind_name_key
  on public.store_fridges (store_id, kind, name);
