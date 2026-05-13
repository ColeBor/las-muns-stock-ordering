-- Freezer box trace log.
--
-- We receive Empanadas and Desserts in frozen boxes stamped with a
-- "prepared on" date. When a box is finished, the store logs (a) the date
-- the box was finished and (b) the prepared-on date stamped on the box.
-- This lets HQ trace which boxes a given preparation batch went into when
-- chasing a bad batch or a health report.
--
-- Only sub_category in ('Empanada','Dessert') shows up in the dropdown —
-- enforced in the UI rather than the DB so admins can extend the
-- categories without a migration. RLS is the now-standard "HQ admins
-- manage everything, store_manager (front-line workers) manage their own
-- store" pattern.

create table if not exists box_trace_entries (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  finished_on date not null default current_date,
  box_prepared_on date not null,
  recorded_by text,
  created_at timestamptz not null default now()
);

-- The box can't be finished before it was prepared.
alter table public.box_trace_entries
  drop constraint if exists box_trace_entries_dates_chk;
alter table public.box_trace_entries
  add constraint box_trace_entries_dates_chk
  check (box_prepared_on <= finished_on);

create index if not exists box_trace_entries_store_finished_idx
  on box_trace_entries(store_id, finished_on desc);
create index if not exists box_trace_entries_item_prepared_idx
  on box_trace_entries(item_id, box_prepared_on);

alter table public.box_trace_entries enable row level security;
drop policy if exists "Box trace: store managers can manage own store" on public.box_trace_entries;
create policy "Box trace: store managers can manage own store" on public.box_trace_entries
  for all using (
    public.is_hq_admin() or (public.is_store_manager() and store_id = public.current_store_id())
  ) with check (
    public.is_hq_admin() or (public.is_store_manager() and store_id = public.current_store_id())
  );

do $$
declare
  t text;
  realtime_tables text[] := array['box_trace_entries'];
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
