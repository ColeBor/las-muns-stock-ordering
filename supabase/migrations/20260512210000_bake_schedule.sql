-- Bake schedule.
--
-- Three tables:
--   bake_expected_sales — HQ-configured static expected daily sales per
--     (store, item, day_of_week). Will be replaced by dynamic data once
--     POS sales import is wired up; the bake form will keep reading from
--     this table either way.
--   bake_sheets — one row per store. Only one active sheet at a time.
--     Closing-shift fills it out, opening-shift reads it, saving a new
--     one replaces the old. No history.
--   bake_sheet_lines — items on the current sheet with on-hand and the
--     final bake quantity. The "Multiple" the worker chose is purely UI
--     state — not persisted — since reloading just needs the final
--     bake_qty for the morning opener.
--
-- day_of_week uses the JavaScript convention 0=Sunday..6=Saturday so
-- `new Date(yyyy, mm-1, dd).getDay()` maps directly. Picked over ISO
-- (1=Mon..7=Sun) because the front-end speaks JS.

create table if not exists bake_expected_sales (
  store_id uuid not null references stores(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  expected_qty integer not null default 0 check (expected_qty >= 0),
  primary key (store_id, item_id, day_of_week)
);

create index if not exists bake_expected_sales_store_idx
  on bake_expected_sales(store_id);

create table if not exists bake_sheets (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null unique references stores(id) on delete cascade,
  bake_for_date date not null,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bake_sheet_lines (
  bake_sheet_id uuid not null references bake_sheets(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  on_hand_qty integer not null default 0 check (on_hand_qty >= 0),
  bake_qty integer not null default 0 check (bake_qty >= 0),
  primary key (bake_sheet_id, item_id)
);

-- RLS — bake_expected_sales is HQ-only for writes, employees of the store
-- can read for the bake form lookup.
alter table public.bake_expected_sales enable row level security;
drop policy if exists "Bake expected: HQ can manage" on public.bake_expected_sales;
create policy "Bake expected: HQ can manage" on public.bake_expected_sales
  for all using (public.is_hq_admin()) with check (public.is_hq_admin());
drop policy if exists "Bake expected: store managers can view own store" on public.bake_expected_sales;
create policy "Bake expected: store managers can view own store" on public.bake_expected_sales
  for select using (
    public.is_hq_admin() or (public.is_store_manager() and store_id = public.current_store_id())
  );

-- bake_sheets and bake_sheet_lines follow the existing log pattern:
-- store managers manage their own store; HQ manages everything.
alter table public.bake_sheets enable row level security;
drop policy if exists "Bake sheets: store managers can manage own store" on public.bake_sheets;
create policy "Bake sheets: store managers can manage own store" on public.bake_sheets
  for all using (
    public.is_hq_admin() or (public.is_store_manager() and store_id = public.current_store_id())
  ) with check (
    public.is_hq_admin() or (public.is_store_manager() and store_id = public.current_store_id())
  );

alter table public.bake_sheet_lines enable row level security;
-- Lines inherit the access rule of their parent sheet via a join.
drop policy if exists "Bake sheet lines: follow parent sheet" on public.bake_sheet_lines;
create policy "Bake sheet lines: follow parent sheet" on public.bake_sheet_lines
  for all using (
    public.is_hq_admin()
    or exists (
      select 1 from public.bake_sheets s
      where s.id = bake_sheet_lines.bake_sheet_id
        and public.is_store_manager()
        and s.store_id = public.current_store_id()
    )
  ) with check (
    public.is_hq_admin()
    or exists (
      select 1 from public.bake_sheets s
      where s.id = bake_sheet_lines.bake_sheet_id
        and public.is_store_manager()
        and s.store_id = public.current_store_id()
    )
  );

-- Trigger to keep bake_sheets.updated_at fresh on any line change.
create or replace function public.touch_bake_sheet() returns trigger
  language plpgsql security definer set search_path = public
as $$
begin
  update public.bake_sheets set updated_at = now() where id = coalesce(new.bake_sheet_id, old.bake_sheet_id);
  return null;
end;
$$;

drop trigger if exists bake_sheet_lines_touch on public.bake_sheet_lines;
create trigger bake_sheet_lines_touch
  after insert or update or delete on public.bake_sheet_lines
  for each row execute function public.touch_bake_sheet();

-- Realtime so the morning opener sees the saved sheet without reloading.
do $$
declare
  t text;
  realtime_tables text[] := array['bake_expected_sales', 'bake_sheets', 'bake_sheet_lines'];
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
