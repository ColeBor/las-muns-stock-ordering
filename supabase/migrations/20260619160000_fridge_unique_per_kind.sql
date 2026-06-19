-- Allow a fridge and a freezer to share a name within a store.
--
-- store_fridges originally had UNIQUE (store_id, name), so e.g. a "Back"
-- fridge blocked adding a "Back" freezer. Now that units are typed, make the
-- name unique per (store_id, kind, name) instead — same name is fine across
-- different types, still blocked within the same type.

-- Drop the old uniqueness by LOOKING IT UP rather than guessing its name:
-- drop every UNIQUE constraint on store_fridges (the old (store_id, name) one).
-- The primary key is contype 'p', not 'u', so it's untouched; our new rule is
-- a CREATE UNIQUE INDEX (not a constraint), so it's untouched too.
do $$
declare
  r record;
begin
  for r in
    select conname
    from pg_constraint
    where conrelid = 'public.store_fridges'::regclass
      and contype = 'u'
  loop
    execute format('alter table public.store_fridges drop constraint %I', r.conname);
  end loop;
end
$$;

create unique index if not exists store_fridges_store_id_kind_name_key
  on public.store_fridges (store_id, kind, name);
