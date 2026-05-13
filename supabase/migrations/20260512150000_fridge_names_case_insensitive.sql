-- Make fridge names case-insensitive within a store.
-- Previously `unique (store_id, name)` treated "Walk-in" and "walk-in" as
-- different entries, which confused HQ when re-adding what looked like
-- the same fridge. Replace the case-sensitive unique constraint with a
-- case-insensitive expression index on (store_id, lower(name)).

alter table public.store_fridges
  drop constraint if exists store_fridges_store_id_name_key;

create unique index if not exists store_fridges_store_lower_name_key
  on public.store_fridges (store_id, lower(name));
