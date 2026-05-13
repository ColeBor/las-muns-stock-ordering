-- Waste log: per-store record of wasted items.
--
-- Adds `is_serveable` to items as a hidden marker — used only to filter
-- which items appear in the waste log dropdown. Not a category, not used
-- by allocations / cycles / store_items, just a flag HQ ticks per item.
--
-- Creates `waste_log_entries`: store-scoped, references an item, with a
-- quantity, the date wasted, a reason from a preset list, and an optional
-- free-text reason when the preset is "Other".
--
-- RLS mirrors stock_entries / temperature_log_entries: store managers
-- (front-line workers, schema-named `store_manager`) manage their own
-- store; HQ admins manage all.

alter table public.items
  add column if not exists is_serveable boolean not null default false;

create table if not exists waste_log_entries (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  quantity integer not null check (quantity > 0),
  reason text not null,
  reason_other text,
  wasted_on date not null,
  recorded_by text,
  created_at timestamptz not null default now()
);

-- When reason is 'Other', a free-text explanation is required; otherwise
-- reason_other must be null so we don't end up with stale text attached
-- to a preset reason after someone toggles back.
alter table public.waste_log_entries
  drop constraint if exists waste_log_entries_reason_other_chk;
alter table public.waste_log_entries
  add constraint waste_log_entries_reason_other_chk
  check (
    (reason = 'Other' and reason_other is not null and length(btrim(reason_other)) > 0)
    or (reason <> 'Other' and reason_other is null)
  );

create index if not exists waste_log_entries_store_wasted_idx
  on waste_log_entries(store_id, wasted_on desc);

create index if not exists waste_log_entries_item_idx
  on waste_log_entries(item_id);

alter table public.waste_log_entries enable row level security;
drop policy if exists "Waste log: store managers can manage own store" on public.waste_log_entries;
create policy "Waste log: store managers can manage own store" on public.waste_log_entries
  for all using (
    public.is_hq_admin() or (public.is_store_manager() and store_id = public.current_store_id())
  ) with check (
    public.is_hq_admin() or (public.is_store_manager() and store_id = public.current_store_id())
  );

-- Wire the new table into Supabase Realtime so logging in one tab refreshes
-- the history table in another. items is already in the publication.
do $$
declare
  t text;
  realtime_tables text[] := array['waste_log_entries'];
begin
  foreach t in array realtime_tables loop
    execute format('alter table public.%I replica identity full', t);
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
