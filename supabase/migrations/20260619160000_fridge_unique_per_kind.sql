-- Allow a fridge and a freezer to share a name within a store.
--
-- store_fridges originally had UNIQUE (store_id, name), so e.g. a "Back"
-- fridge blocked adding a "Back" freezer. Now that units are typed, make the
-- name unique per (store_id, kind, name) instead — same name is fine across
-- different types, still blocked within the same type.

-- Drop the old uniqueness regardless of whether it's a constraint or a bare
-- unique index: drop EVERY unique, non-primary index on store_fridges except
-- our new (store_id, kind, name) one. CASCADE also removes a backing
-- constraint if the index has one. Then (re)create the kind-aware index.
do $$
declare
  r record;
begin
  for r in
    select i.relname as idxname
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
    join pg_class t on t.oid = x.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where t.relname = 'store_fridges'
      and n.nspname = 'public'
      and x.indisunique
      and not x.indisprimary
      and i.relname <> 'store_fridges_store_id_kind_name_key'
  loop
    execute format('drop index if exists public.%I cascade', r.idxname);
  end loop;
end
$$;

create unique index if not exists store_fridges_store_id_kind_name_key
  on public.store_fridges (store_id, kind, name);
